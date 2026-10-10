pub use dcm_manager::backend;
pub use dcm_manager::management_server;
pub use dcm_manager::platform;
mod sidecar;

use std::env;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 && args[1] == "sidecar" {
        match sidecar::run_sidecar().await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("[dcm-manager] Sidecar error: {}", e);
                ExitCode::FAILURE
            }
        }
    } else {
        println!("Desktop Commander Manager (Rust Sidecar / Host)");
        println!("Usage: dcm-manager sidecar");
        ExitCode::SUCCESS
    }
}
