use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerState {
    Stopped,
    Starting,
    Ready,
    Busy,
    Degraded,
    Offline,
    Disabled,
}

impl std::fmt::Display for WorkerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => write!(f, "STOPPED"),
            Self::Starting => write!(f, "STARTING"),
            Self::Ready => write!(f, "READY"),
            Self::Busy => write!(f, "BUSY"),
            Self::Degraded => write!(f, "DEGRADED"),
            Self::Offline => write!(f, "OFFLINE"),
            Self::Disabled => write!(f, "DISABLED"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerLifecycleEvent {
    StartRequested,
    Started {
        pid: u32,
    },
    HandshakeSucceeded,
    HandshakeFailed {
        reason: String,
    },
    ToolCallStarted,
    ToolCallCompleted,
    ProcessExited {
        code: Option<i32>,
        signal: Option<String>,
    },
    RecoveryExhausted,
    DisableRequested,
    EnableRequested,
    StopRequested,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("Invalid state transition from {from:?} with event {event}")]
pub struct InvalidTransition {
    pub from: WorkerState,
    pub event: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStateMachine {
    current_state: WorkerState,
    pid: Option<u32>,
    failure_count: u32,
}

impl WorkerStateMachine {
    pub fn new(initial_state: WorkerState) -> Self {
        Self {
            current_state: initial_state,
            pid: None,
            failure_count: 0,
        }
    }

    pub fn state(&self) -> WorkerState {
        self.current_state
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn failure_count(&self) -> u32 {
        self.failure_count
    }

    pub fn reset_failure_count(&mut self) {
        self.failure_count = 0;
    }

    pub fn transition(
        &mut self,
        event: WorkerLifecycleEvent,
    ) -> Result<WorkerState, InvalidTransition> {
        let event_name = format!("{:?}", event);
        let next_state = match (self.current_state, &event) {
            // Disable from any state
            (_, WorkerLifecycleEvent::DisableRequested) => {
                self.pid = None;
                WorkerState::Disabled
            }

            // Disabled
            (WorkerState::Disabled, WorkerLifecycleEvent::EnableRequested) => WorkerState::Stopped,

            // Stopped
            (WorkerState::Stopped, WorkerLifecycleEvent::StartRequested) => WorkerState::Starting,
            (WorkerState::Stopped, WorkerLifecycleEvent::StopRequested) => WorkerState::Stopped,

            // Starting
            (WorkerState::Starting, WorkerLifecycleEvent::Started { pid }) => {
                self.pid = Some(*pid);
                WorkerState::Starting
            }
            (WorkerState::Starting, WorkerLifecycleEvent::HandshakeSucceeded) => {
                self.failure_count = 0;
                WorkerState::Ready
            }
            (WorkerState::Starting, WorkerLifecycleEvent::HandshakeFailed { .. }) => {
                self.pid = None;
                self.failure_count += 1;
                WorkerState::Degraded
            }
            (WorkerState::Starting, WorkerLifecycleEvent::ProcessExited { .. }) => {
                self.pid = None;
                self.failure_count += 1;
                WorkerState::Degraded
            }
            (WorkerState::Starting, WorkerLifecycleEvent::StopRequested) => {
                self.pid = None;
                WorkerState::Stopped
            }

            // Ready
            (WorkerState::Ready, WorkerLifecycleEvent::ToolCallStarted) => WorkerState::Busy,
            (WorkerState::Ready, WorkerLifecycleEvent::ProcessExited { .. }) => {
                self.pid = None;
                self.failure_count += 1;
                WorkerState::Degraded
            }
            (WorkerState::Ready, WorkerLifecycleEvent::StopRequested) => {
                self.pid = None;
                WorkerState::Stopped
            }
            (WorkerState::Ready, WorkerLifecycleEvent::StartRequested) => WorkerState::Starting,

            // Busy
            (WorkerState::Busy, WorkerLifecycleEvent::ToolCallCompleted) => WorkerState::Ready,
            (WorkerState::Busy, WorkerLifecycleEvent::ProcessExited { .. }) => {
                self.pid = None;
                self.failure_count += 1;
                WorkerState::Degraded
            }
            (WorkerState::Busy, WorkerLifecycleEvent::StopRequested) => {
                self.pid = None;
                WorkerState::Stopped
            }

            // Degraded
            (WorkerState::Degraded, WorkerLifecycleEvent::StartRequested) => WorkerState::Starting,
            (WorkerState::Degraded, WorkerLifecycleEvent::RecoveryExhausted) => {
                self.pid = None;
                WorkerState::Offline
            }
            (WorkerState::Degraded, WorkerLifecycleEvent::ProcessExited { .. }) => {
                self.pid = None;
                WorkerState::Degraded
            }
            (WorkerState::Degraded, WorkerLifecycleEvent::StopRequested) => {
                self.pid = None;
                WorkerState::Stopped
            }

            // Offline
            (WorkerState::Offline, WorkerLifecycleEvent::StartRequested) => WorkerState::Starting,
            (WorkerState::Offline, WorkerLifecycleEvent::StopRequested) => {
                self.pid = None;
                WorkerState::Stopped
            }

            _ => {
                return Err(InvalidTransition {
                    from: self.current_state,
                    event: event_name,
                });
            }
        };

        self.current_state = next_state;
        Ok(next_state)
    }
}
