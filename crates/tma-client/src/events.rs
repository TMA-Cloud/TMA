//! Live file events over server-sent events. The subscription reconnects with
//! backoff until it is dropped.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tma_core::api::FileEvent;

use crate::http::Client;

#[cfg(not(target_arch = "wasm32"))]
pub type Sink = Arc<dyn Fn(FileEvent) + Send + Sync>;
#[cfg(target_arch = "wasm32")]
pub type Sink = Arc<dyn Fn(FileEvent)>;

/// Stops the stream when dropped.
pub struct Subscription {
    stop: Arc<AtomicBool>,
    #[cfg(target_arch = "wasm32")]
    source: Option<web_sys::EventSource>,
    #[cfg(target_arch = "wasm32")]
    _handler: Option<wasm_bindgen::closure::Closure<dyn FnMut(web_sys::MessageEvent)>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(target_arch = "wasm32")]
        if let Some(source) = &self.source {
            source.close();
        }
    }
}

/// Parse one SSE `data:` payload; the keepalive comment and junk are ignored.
pub fn parse_data(payload: &str) -> Option<FileEvent> {
    serde_json::from_str::<FileEvent>(payload).ok()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn subscribe(client: &Client, sink: Sink) -> Subscription {
    let stop = Arc::new(AtomicBool::new(false));
    let (client, flag) = (client.clone(), stop.clone());
    crate::rt::spawn(async move {
        use futures::StreamExt;
        let mut backoff = 1u64;
        while !flag.load(Ordering::Relaxed) {
            let request =
                client.request(reqwest::Method::GET, "/api/files/events").header("accept", "text/event-stream");
            match client.send(request).await {
                Ok(response) => {
                    backoff = 1;
                    let mut stream = response.bytes_stream();
                    let mut buffer = String::new();
                    while let Some(chunk) = stream.next().await {
                        if flag.load(Ordering::Relaxed) {
                            return;
                        }
                        let Ok(chunk) = chunk else { break };
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(end) = buffer.find("\n\n") {
                            let block: String = buffer.drain(..end + 2).collect();
                            let data: Vec<&str> =
                                block.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect();
                            if let Some(event) = parse_data(&data.join("\n")) {
                                sink(event);
                            }
                        }
                    }
                }
                // Signed out: stop rather than hammer the server.
                Err(err) if err.is_unauthorized() => return,
                Err(err) => log::debug!("Event stream unavailable: {err}"),
            }
            crate::rt::sleep(std::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    Subscription { stop }
}

#[cfg(target_arch = "wasm32")]
pub fn subscribe(client: &Client, sink: Sink) -> Subscription {
    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;
    let stop = Arc::new(AtomicBool::new(false));
    let init = web_sys::EventSourceInit::new();
    init.set_with_credentials(true);
    let Ok(source) = web_sys::EventSource::new_with_event_source_init_dict(&client.url("/api/files/events"), &init)
    else {
        return Subscription { stop, source: None, _handler: None };
    };
    let handler = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |msg: web_sys::MessageEvent| {
        if let Some(event) = msg.data().as_string().as_deref().and_then(parse_data) {
            sink(event);
        }
    });
    source.set_onmessage(Some(handler.as_ref().unchecked_ref()));
    Subscription { stop, source: Some(source), _handler: Some(handler) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events() {
        let e = parse_data(r#"{"type":"file.uploaded","data":{"id":"x"}}"#);
        assert_eq!(e.map(|e| e.event_type), Some("file.uploaded".to_string()));
        assert!(parse_data("keepalive").is_none());
    }
}
