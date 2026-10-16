//! NDJSON progress for bulk changes (`Accept: application/x-ndjson`): a line per
//! finished batch, then `done` or `error`. Progress is real: a line is written
//! only after its batch has committed.

use std::future::Future;

use axum::body::Body;
use axum::http::header;
use axum::response::Response;
use serde_json::json;

const MAX_STEPS: usize = 20;
const MIN_BATCH: usize = 25;

fn line(value: serde_json::Value) -> bytes::Bytes {
    bytes::Bytes::from(format!("{value}\n"))
}

pub fn stream<F, Fut, P>(ids: Vec<String>, run: F, done_message: String, after: P) -> Response
where
    F: Fn(Vec<String>) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send,
    P: Future<Output = ()> + Send + 'static,
{
    let total = ids.len();
    let batch = MIN_BATCH.max(total.div_ceil(MAX_STEPS));
    let body = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(line(json!({ "type": "progress", "done": 0, "total": total })));
        let mut done = 0;
        for chunk in ids.chunks(batch) {
            if let Err(err) = run(chunk.to_vec()).await {
                tracing::error!(error = %err, "Streaming bulk operation failed mid-flight");
                yield Ok(line(json!({ "type": "error", "message": err.to_string() })));
                return;
            }
            done += chunk.len();
            yield Ok(line(json!({ "type": "progress", "done": done, "total": total })));
        }
        after.await;
        yield Ok(line(json!({ "type": "done", "message": done_message })));
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(body))
        .unwrap_or_default()
}
