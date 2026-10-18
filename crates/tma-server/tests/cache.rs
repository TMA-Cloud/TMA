//! The Redis cache against a real server: invalidation must win over a fill
//! that read the database before the change. Skipped unless `TMA_TEST_REDIS_URL` is set.
#![expect(clippy::unwrap_used, reason = "tests fail loudly on purpose")]

use tma_server::cache::Cache;

#[tokio::test]
async fn invalidation_blocks_stale_fills() {
    let Some(url) = std::env::var("TMA_TEST_REDIS_URL").ok().filter(|v| !v.is_empty()) else {
        eprintln!("skipped: TMA_TEST_REDIS_URL not set");
        return;
    };
    let cache = Cache::connect(&url).await.unwrap();
    let key = format!("user:cache-test-{}:token_version", uuid::Uuid::new_v4());

    cache.fill(&key, &1, 60).await;
    assert_eq!(cache.get::<i32>(&key).await, Some(1));
    // A second fill never replaces what is cached.
    cache.fill(&key, &2, 60).await;
    assert_eq!(cache.get::<i32>(&key).await, Some(1));

    cache.invalidate(std::slice::from_ref(&key)).await;
    assert_eq!(cache.get::<i32>(&key).await, None);
    // A lookup that read the old row before the change cannot put it back.
    cache.fill(&key, &1, 60).await;
    assert_eq!(cache.get::<i32>(&key).await, None);

    // Invalidating a key nothing cached still blocks a late fill.
    let cold = format!("session:cache-test-{}:s:1", uuid::Uuid::new_v4());
    cache.invalidate(std::slice::from_ref(&cold)).await;
    cache.fill(&cold, &true, 60).await;
    assert_eq!(cache.get::<bool>(&cold).await, None);
}
