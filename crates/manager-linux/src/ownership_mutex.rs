use manager_platform::{PlatformError, SupervisorOwnershipGuard};
use std::fs::{File, OpenOptions};
use std::path::PathBuf;

pub const DEFAULT_SUPERVISOR_MUTEX_NAME: &str = "DesktopCommanderManager.WorkerSupervisor";

pub struct LinuxSupervisorOwnershipGuard {
    _file: Option<File>,
    path: PathBuf,
    held: bool,
}

impl LinuxSupervisorOwnershipGuard {
    pub fn acquire(name: &str) -> Result<Self, PlatformError> {
        let lock_name = if name.contains('\\') {
            name.rsplit('\\').next().unwrap_or(name)
        } else {
            name
        };

        let temp_dir = std::env::temp_dir();
        let lock_path = temp_dir.join(format!("{}.lock", lock_name));

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| {
                PlatformError::Internal(format!(
                    "Failed to open lockfile '{}': {}",
                    lock_path.display(),
                    e
                ))
            })?;

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::io::AsRawFd;
            let fd = file.as_raw_fd();
            let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if ret != 0 {
                let err = std::io::Error::last_os_error();
                return Err(PlatformError::Internal(format!(
                    "Supervisor mutex '{}' is already held by another process (flock error: {})",
                    name, err
                )));
            }
        }

        Ok(Self {
            _file: Some(file),
            path: lock_path,
            held: true,
        })
    }

    pub fn lock_path(&self) -> &PathBuf {
        &self.path
    }
}

unsafe impl Send for LinuxSupervisorOwnershipGuard {}
unsafe impl Sync for LinuxSupervisorOwnershipGuard {}

impl SupervisorOwnershipGuard for LinuxSupervisorOwnershipGuard {
    fn is_held(&self) -> bool {
        self.held
    }
}

impl Drop for LinuxSupervisorOwnershipGuard {
    fn drop(&mut self) {
        if self.held {
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::io::AsRawFd;
                if let Some(ref file) = self._file {
                    let fd = file.as_raw_fd();
                    unsafe {
                        libc::flock(fd, libc::LOCK_UN);
                    }
                }
            }
            self.held = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_and_release() {
        let name = "TestSupervisorGuard";
        let guard = LinuxSupervisorOwnershipGuard::acquire(name);
        assert!(guard.is_ok());
        let guard = guard.unwrap();
        assert!(guard.is_held());
    }
}
