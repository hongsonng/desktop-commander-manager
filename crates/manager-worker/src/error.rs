use manager_protocol::{SidecarError, UpstreamFailureKind};
use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum WorkerClientError {
    #[error("Upstream error ({kind:?}): {message}")]
    Upstream {
        kind: UpstreamFailureKind,
        message: String,
    },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Worker process exited: code={code:?}")]
    ProcessExited { code: Option<i32> },
}

impl WorkerClientError {
    pub fn pre_dispatch(msg: impl fmt::Display) -> Self {
        Self::Upstream {
            kind: UpstreamFailureKind::PreDispatch,
            message: msg.to_string(),
        }
    }

    pub fn ack_unknown(msg: impl fmt::Display) -> Self {
        Self::Upstream {
            kind: UpstreamFailureKind::AckUnknown,
            message: msg.to_string(),
        }
    }

    pub fn upstream_error(msg: impl fmt::Display) -> Self {
        Self::Upstream {
            kind: UpstreamFailureKind::UpstreamError,
            message: msg.to_string(),
        }
    }

    pub fn post_dispatch(msg: impl fmt::Display) -> Self {
        Self::Upstream {
            kind: UpstreamFailureKind::PostDispatch,
            message: msg.to_string(),
        }
    }

    pub fn kind(&self) -> UpstreamFailureKind {
        match self {
            Self::Upstream { kind, .. } => *kind,
            Self::Io(_) => UpstreamFailureKind::PreDispatch,
            Self::Json(_) => UpstreamFailureKind::PostDispatch,
            Self::ProcessExited { .. } => UpstreamFailureKind::AckUnknown,
        }
    }

    pub fn to_sidecar_error(&self) -> SidecarError {
        SidecarError::with_failure_kind("WORKER_ERROR", self.to_string(), self.kind())
    }
}
