use manager_platform::{PlatformError, ProcessIdentity};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, FILETIME};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

pub fn get_process_identity(pid: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let err = unsafe { GetLastError() };
        if err == ERROR_ACCESS_DENIED {
            return Err(PlatformError::AccessDenied(
                pid,
                "OpenProcess failed with ERROR_ACCESS_DENIED".to_string(),
            ));
        }
        return Ok(None);
    }

    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0 && exit_code != 259 {
        unsafe { CloseHandle(handle) };
        return Ok(None);
    }

    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };

    let success =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };

    if success == 0 {
        unsafe { CloseHandle(handle) };
        return Ok(None);
    }

    let creation_time_100ns =
        ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);

    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    let image_path =
        if unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) } != 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        };

    unsafe { CloseHandle(handle) };

    Ok(Some(ProcessIdentity {
        pid,
        creation_time_100ns,
        image_path,
    }))
}
