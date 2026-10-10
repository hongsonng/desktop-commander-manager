use manager_platform::PlatformError;
use manager_worker::SupervisorOwnershipGuard;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

pub const DEFAULT_SUPERVISOR_MUTEX_NAME: &str = "Local\\DesktopCommanderManager.WorkerSupervisor";

pub struct WindowsSupervisorOwnershipGuard {
    handle: HANDLE,
    held: bool,
}

impl WindowsSupervisorOwnershipGuard {
    pub fn acquire(name: &str) -> Result<Self, PlatformError> {
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let handle = CreateMutexW(std::ptr::null_mut(), 0, wide_name.as_ptr());
            if handle.is_null() {
                return Err(PlatformError::Internal(
                    "CreateMutexW returned NULL".to_string(),
                ));
            }

            // WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80 (128)
            let wait_res = WaitForSingleObject(handle, 0);
            if wait_res == 0 || wait_res == 128 {
                Ok(Self { handle, held: true })
            } else {
                CloseHandle(handle);
                Err(PlatformError::Internal(format!(
                    "Supervisor mutex '{}' is already held by another process (wait result: {:#x})",
                    name, wait_res
                )))
            }
        }
    }
}

unsafe impl Send for WindowsSupervisorOwnershipGuard {}
unsafe impl Sync for WindowsSupervisorOwnershipGuard {}

impl SupervisorOwnershipGuard for WindowsSupervisorOwnershipGuard {
    fn is_held(&self) -> bool {
        self.held
    }
}

impl Drop for WindowsSupervisorOwnershipGuard {
    fn drop(&mut self) {
        if self.held && !self.handle.is_null() {
            unsafe {
                ReleaseMutex(self.handle);
                CloseHandle(self.handle);
            }
            self.held = false;
        }
    }
}
