use manager_protocol::UpstreamFailureKind;

pub struct RetryPolicy;

impl RetryPolicy {
    pub fn can_replay(failure_kind: UpstreamFailureKind) -> bool {
        matches!(failure_kind, UpstreamFailureKind::PreDispatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_policy_only_allows_pre_dispatch() {
        assert!(RetryPolicy::can_replay(UpstreamFailureKind::PreDispatch));
        assert!(!RetryPolicy::can_replay(UpstreamFailureKind::AckUnknown));
        assert!(!RetryPolicy::can_replay(UpstreamFailureKind::UpstreamError));
        assert!(!RetryPolicy::can_replay(UpstreamFailureKind::PostDispatch));
    }
}
