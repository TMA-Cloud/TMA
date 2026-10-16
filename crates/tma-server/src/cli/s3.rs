//! Bucket hardening for the configured storage bucket: keep it private, refuse
//! plain HTTP, keep old versions for a week, encrypt at rest, and clean up
//! abandoned multipart uploads.

use std::sync::Arc;

use anyhow::Context;
use aws_sdk_s3::types::{
    AbortIncompleteMultipartUpload, BucketLifecycleConfiguration, BucketVersioningStatus, ExpirationStatus,
    LifecycleExpiration, LifecycleRule, LifecycleRuleFilter, NoncurrentVersionExpiration,
    PublicAccessBlockConfiguration, ServerSideEncryption, ServerSideEncryptionByDefault,
    ServerSideEncryptionConfiguration, ServerSideEncryptionRule, VersioningConfiguration,
};

use super::S3Action;
use crate::config::Config;
use crate::crypto::Keyring;
use crate::db;
use crate::storage::Storage;

const DAYS_AFTER_INITIATION: i32 = 1;
const NONCURRENT_DAYS: i32 = 7;

struct Bucket {
    client: aws_sdk_s3::Client,
    name: String,
}

async fn open() -> anyhow::Result<Bucket> {
    let config = Config::from_env()?;
    let keyring = Arc::new(Keyring::from_env(config.production, false)?);
    let pool = db::connect(&config.database_url, 2).await?;
    let active = Storage::new(pool.clone(), keyring)
        .active()
        .await
        .context("Connect a storage bucket in Settings > Storage first")?;
    pool.close().await;
    Ok(Bucket { client: active.client, name: active.bucket })
}

fn lifecycle_rules() -> anyhow::Result<BucketLifecycleConfiguration> {
    let abort = LifecycleRule::builder()
        .id("AbortIncompleteMultipartUploads")
        .status(ExpirationStatus::Enabled)
        .filter(LifecycleRuleFilter::builder().build())
        .abort_incomplete_multipart_upload(
            AbortIncompleteMultipartUpload::builder().days_after_initiation(DAYS_AFTER_INITIATION).build(),
        )
        .build()?;
    let versions = LifecycleRule::builder()
        .id("DeleteOldVersions")
        .status(ExpirationStatus::Enabled)
        .filter(LifecycleRuleFilter::builder().build())
        .noncurrent_version_expiration(NoncurrentVersionExpiration::builder().noncurrent_days(NONCURRENT_DAYS).build())
        .expiration(LifecycleExpiration::builder().expired_object_delete_marker(true).build())
        .build()?;
    Ok(BucketLifecycleConfiguration::builder().rules(abort).rules(versions).build()?)
}

fn https_only_policy(bucket: &str) -> String {
    serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "DenyInsecureTransport",
            "Effect": "Deny",
            "Principal": "*",
            "Action": "s3:*",
            "Resource": [format!("arn:aws:s3:::{bucket}"), format!("arn:aws:s3:::{bucket}/*")],
            "Condition": { "Bool": { "aws:SecureTransport": "false" } },
        }],
    })
    .to_string()
}

/// The full error chain; S3-compatible servers put the useful part deep inside.
fn describe<E, R>(err: aws_sdk_s3::error::SdkError<E, R>) -> anyhow::Error
where
    E: std::error::Error + aws_sdk_s3::error::ProvideErrorMetadata + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    use aws_sdk_s3::error::ProvideErrorMetadata;
    match (err.code(), err.message()) {
        (Some(code), Some(message)) => anyhow::anyhow!("{code}: {message}"),
        (Some(code), None) => anyhow::anyhow!("{code}"),
        _ => anyhow::anyhow!("{}", aws_sdk_s3::error::DisplayErrorContext(err)),
    }
}

async fn apply(bucket: &Bucket, action: S3Action) -> anyhow::Result<&'static str> {
    let (client, name) = (&bucket.client, bucket.name.as_str());
    match action {
        S3Action::Lifecycle => {
            client
                .put_bucket_lifecycle_configuration()
                .bucket(name)
                .lifecycle_configuration(lifecycle_rules()?)
                .send()
                .await
                .map_err(describe)?;
            Ok("Lifecycle: unfinished uploads abort after 1 day; old versions expire after 7 days.")
        }
        S3Action::PublicBlock => {
            let block = PublicAccessBlockConfiguration::builder()
                .block_public_acls(true)
                .ignore_public_acls(true)
                .block_public_policy(true)
                .restrict_public_buckets(true)
                .build();
            client
                .put_public_access_block()
                .bucket(name)
                .public_access_block_configuration(block)
                .send()
                .await
                .map_err(describe)?;
            Ok("Block public access: the bucket is private.")
        }
        S3Action::PolicyHttps => {
            client.put_bucket_policy().bucket(name).policy(https_only_policy(name)).send().await.map_err(describe)?;
            Ok("Bucket policy: requests without HTTPS are denied.")
        }
        S3Action::Versioning => {
            let config = VersioningConfiguration::builder().status(BucketVersioningStatus::Enabled).build();
            client
                .put_bucket_versioning()
                .bucket(name)
                .versioning_configuration(config)
                .send()
                .await
                .map_err(describe)?;
            Ok("Versioning: overwritten and deleted objects keep a previous version.")
        }
        S3Action::Encryption => {
            let default =
                ServerSideEncryptionByDefault::builder().sse_algorithm(ServerSideEncryption::Aes256).build()?;
            let rule = ServerSideEncryptionRule::builder()
                .apply_server_side_encryption_by_default(default)
                .bucket_key_enabled(false)
                .build();
            let config = ServerSideEncryptionConfiguration::builder().rules(rule).build()?;
            client
                .put_bucket_encryption()
                .bucket(name)
                .server_side_encryption_configuration(config)
                .send()
                .await
                .map_err(describe)?;
            Ok("Default encryption: objects are encrypted at rest (SSE-S3).")
        }
        S3Action::CheckLifecycle | S3Action::ProtectAll => Ok(""),
    }
}

pub async fn run(action: S3Action) -> anyhow::Result<()> {
    let bucket = open().await?;
    println!("Bucket: {}", bucket.name);
    match action {
        S3Action::CheckLifecycle => {
            let rules = bucket.client.get_bucket_lifecycle_configuration().bucket(&bucket.name).send().await;
            match rules {
                Ok(out) if !out.rules().is_empty() => {
                    for rule in out.rules() {
                        println!("  {} ({:?})", rule.id().unwrap_or("unnamed"), rule.status());
                    }
                }
                Ok(_) => println!("  No lifecycle rules. Run: tma-server s3 lifecycle"),
                Err(err) => anyhow::bail!("Cannot read the lifecycle rules: {}", describe(err)),
            }
            Ok(())
        }
        S3Action::ProtectAll => {
            let steps = [
                S3Action::PublicBlock,
                S3Action::PolicyHttps,
                S3Action::Versioning,
                S3Action::Encryption,
                S3Action::Lifecycle,
            ];
            let mut failed = 0;
            for (i, step) in steps.into_iter().enumerate() {
                match apply(&bucket, step).await {
                    Ok(done) => println!("{}/5 {done}", i + 1),
                    Err(err) => {
                        failed += 1;
                        eprintln!("{}/5 FAILED: {err}", i + 1);
                    }
                }
            }
            if failed > 0 {
                anyhow::bail!("{failed} step(s) failed; some S3-compatible servers do not support every setting");
            }
            Ok(())
        }
        other => {
            println!("{}", apply(&bucket, other).await?);
            Ok(())
        }
    }
}
