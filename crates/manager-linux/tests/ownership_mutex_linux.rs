use manager_linux::ownership_mutex::LinuxSupervisorOwnershipGuard;
use manager_platform::SupervisorOwnershipGuard;

#[test]
fn test_ownership_mutex_single_holder_and_release() {
    let mutex_name = format!(
        "DesktopCommanderManager.TestLinuxMutex.{}",
        std::process::id()
    );

    // 1. Acquire guard
    let guard1 = LinuxSupervisorOwnershipGuard::acquire(&mutex_name)
        .expect("guard1 should acquire ownership");
    assert!(guard1.is_held());

    // 2. Drop guard1 to release lockfile
    drop(guard1);

    // 3. Acquire again after drop must succeed
    let guard2 = LinuxSupervisorOwnershipGuard::acquire(&mutex_name)
        .expect("guard2 should acquire after guard1 is dropped");
    assert!(guard2.is_held());
}
