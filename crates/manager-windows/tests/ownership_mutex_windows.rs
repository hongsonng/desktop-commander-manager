#![cfg(windows)]

use manager_platform::SupervisorOwnershipGuard;
use manager_windows::ownership_mutex::WindowsSupervisorOwnershipGuard;

#[test]
fn test_ownership_mutex_single_holder_and_release() {
    let mutex_name = format!(
        "Local\\DesktopCommanderManager.TestMutex.{}",
        std::process::id()
    );

    // 1. Acquire guard
    let guard1 = WindowsSupervisorOwnershipGuard::acquire(&mutex_name)
        .expect("guard1 should acquire ownership");
    assert!(guard1.is_held());

    // 2. Second attempt from another thread while held must fail
    let name_clone = mutex_name.clone();
    let thread_attempt =
        std::thread::spawn(move || WindowsSupervisorOwnershipGuard::acquire(&name_clone));
    let guard2_res = thread_attempt.join().unwrap();
    assert!(
        guard2_res.is_err(),
        "Second acquire from separate thread while held must return error, got {:?}",
        guard2_res.err()
    );

    // 3. Drop guard1 to release mutex
    drop(guard1);

    // 4. Third attempt after release must succeed
    let guard3 = WindowsSupervisorOwnershipGuard::acquire(&mutex_name)
        .expect("guard3 should acquire after guard1 is dropped");
    assert!(guard3.is_held());
}
