//! Server-sent events: a private stream of the account's file changes, with a
//! keepalive comment every 30 seconds; a closed tab drops the stream and its slot.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::Stream;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::state::AppState;

const MAX_STREAMS_PER_USER: u32 = 20;

pub async fn stream(State(state): State<AppState>, auth: AuthUser) -> Response {
    let Some(slot) = state.limits.acquire_sse(&auth.user_id, MAX_STREAMS_PER_USER) else {
        return ApiError::too_many("Too many active connections. Please close other tabs or wait a moment.")
            .into_response();
    };
    let Some(mut sub) = state.events.subscribe(&auth.owner_id) else {
        return ApiError::unavailable("Failed to connect to event stream").into_response();
    };
    let events: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(
        async_stream::stream! {
            let _slot = slot;
            yield Ok(Event::default().data(r#"{"type":"connected","message":"Connected to file events stream"}"#));
            loop {
                match sub.rx.recv().await {
                    Ok(message) => yield Ok(Event::default().data(message.as_ref())),
                    // A slow tab missed some events; one refresh covers them.
                    Err(RecvError::Lagged(_)) => yield Ok(Event::default().data(r#"{"type":"file.batch","data":{"events":[]}}"#)),
                    Err(RecvError::Closed) => break,
                }
            }
        },
    );
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(30)).text("keepalive"))
        .into_response();
    response.headers_mut().insert("x-accel-buffering", axum::http::HeaderValue::from_static("no"));
    response.headers_mut().insert("cache-control", axum::http::HeaderValue::from_static("no-cache"));
    response
}
