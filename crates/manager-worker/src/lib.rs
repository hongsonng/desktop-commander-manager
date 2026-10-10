pub mod client;
pub mod config;
pub mod error;
pub mod ownership;
pub mod state;
pub mod supervisor;

pub use client::WorkerClient;
pub use config::{resolve_desktop_commander_spawn_spec, WorkerLaunchConfig};
pub use error::WorkerClientError;
pub use ownership::SupervisorOwnershipGuard;
pub use state::{InvalidTransition, WorkerLifecycleEvent, WorkerState, WorkerStateMachine};
pub use supervisor::{SupervisorError, WorkerSupervisor};
