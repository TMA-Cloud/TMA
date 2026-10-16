//! Running futures from the UI thread: a shared tokio runtime on desktop, the
//! browser's microtask queue on the web.

use std::future::Future;
use std::time::Duration;

#[cfg(not(target_arch = "wasm32"))]
fn runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        match tokio::runtime::Builder::new_multi_thread().worker_threads(4).thread_name("tma-net").enable_all().build()
        {
            Ok(rt) => rt,
            // Without a multi-threaded runtime there is nothing to run requests on; a current-thread one still works.
            Err(_) => match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(err) => {
                    log::error!("Cannot start async runtime: {err}");
                    std::process::abort()
                }
            },
        }
    })
}

/// Run `future` in the background.
#[cfg(not(target_arch = "wasm32"))]
pub fn spawn<F: Future<Output = ()> + Send + 'static>(future: F) {
    runtime().spawn(future);
}

#[cfg(target_arch = "wasm32")]
pub fn spawn<F: Future<Output = ()> + 'static>(future: F) {
    wasm_bindgen_futures::spawn_local(future);
}

/// Block on a future from a non-async thread (desktop helpers only).
#[cfg(not(target_arch = "wasm32"))]
pub fn block_on<F: Future>(future: F) -> F::Output {
    runtime().block_on(future)
}

/// The runtime handle, for desktop code that needs tokio directly.
#[cfg(not(target_arch = "wasm32"))]
pub fn handle() -> tokio::runtime::Handle {
    runtime().handle().clone()
}

pub async fn sleep(duration: Duration) {
    #[cfg(not(target_arch = "wasm32"))]
    tokio::time::sleep(duration).await;
    #[cfg(target_arch = "wasm32")]
    gloo_timers::future::sleep(duration).await;
}

/// `Send` on desktop, nothing on the web, where futures stay on one thread.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}
#[cfg(target_arch = "wasm32")]
impl<T> MaybeSend for T {}
