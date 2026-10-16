//! `tma-server`: the API, the background worker and admin commands in one binary.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match tma_server::cli::run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("Error: {err:#}");
            std::process::ExitCode::FAILURE
        }
    }
}
