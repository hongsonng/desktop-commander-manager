use manager_worker::{WorkerLifecycleEvent, WorkerState, WorkerStateMachine};

#[test]
fn test_happy_path_start_and_tool_call() {
    let mut sm = WorkerStateMachine::new(WorkerState::Stopped);
    assert_eq!(sm.state(), WorkerState::Stopped);

    // 1. Start requested
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::StartRequested).unwrap(),
        WorkerState::Starting
    );

    // 2. Process spawned
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::Started { pid: 1234 })
            .unwrap(),
        WorkerState::Starting
    );
    assert_eq!(sm.pid(), Some(1234));

    // 3. Handshake succeeded
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::HandshakeSucceeded)
            .unwrap(),
        WorkerState::Ready
    );
    assert_eq!(sm.failure_count(), 0);

    // 4. Tool call started -> Busy
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::ToolCallStarted)
            .unwrap(),
        WorkerState::Busy
    );

    // 5. Tool call completed -> Ready
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::ToolCallCompleted)
            .unwrap(),
        WorkerState::Ready
    );
}

#[test]
fn test_crash_and_exhaustion_recovery() {
    let mut sm = WorkerStateMachine::new(WorkerState::Ready);

    // Crash while ready -> Degraded
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::ProcessExited {
            code: Some(1),
            signal: None
        })
        .unwrap(),
        WorkerState::Degraded
    );
    assert_eq!(sm.pid(), None);
    assert_eq!(sm.failure_count(), 1);

    // Recovery retry -> Starting
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::StartRequested).unwrap(),
        WorkerState::Starting
    );

    // Handshake fails -> Degraded again
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::HandshakeFailed {
            reason: "timeout".into()
        })
        .unwrap(),
        WorkerState::Degraded
    );
    assert_eq!(sm.failure_count(), 2);

    // Exhaustion -> Offline
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::RecoveryExhausted)
            .unwrap(),
        WorkerState::Offline
    );
}

#[test]
fn test_disable_and_enable() {
    let mut sm = WorkerStateMachine::new(WorkerState::Ready);

    // Disable from Ready -> Disabled
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::DisableRequested)
            .unwrap(),
        WorkerState::Disabled
    );
    assert_eq!(sm.pid(), None);

    // Cannot start directly while Disabled
    assert!(sm.transition(WorkerLifecycleEvent::StartRequested).is_err());

    // Enable -> Stopped
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::EnableRequested)
            .unwrap(),
        WorkerState::Stopped
    );

    // Now start works
    assert_eq!(
        sm.transition(WorkerLifecycleEvent::StartRequested).unwrap(),
        WorkerState::Starting
    );
}

#[test]
fn test_invalid_transitions() {
    let mut sm = WorkerStateMachine::new(WorkerState::Stopped);

    // Cannot complete tool call while stopped
    assert!(sm
        .transition(WorkerLifecycleEvent::ToolCallCompleted)
        .is_err());

    // Cannot handshake while stopped
    assert!(sm
        .transition(WorkerLifecycleEvent::HandshakeSucceeded)
        .is_err());
}
