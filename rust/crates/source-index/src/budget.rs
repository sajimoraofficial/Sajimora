//! A hard aggregate private-commit budget inherited by Git and parser children.
use anyhow::{bail, Context, Result};

/// OS handles release automatically on process death; the harmless lock file
/// remains so removing/recreating it cannot race another writer.
pub struct BuildLease {
    _file: std::fs::File,
}
impl BuildLease {
    pub fn acquire(database: &std::path::Path) -> Result<Self> {
        let mut path = database.as_os_str().to_os_string();
        path.push(".lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options
            .open(std::path::Path::new(&path))
            .map_err(|error| anyhow::anyhow!("BUILD_LEASE_UNAVAILABLE: {error}"))?;
        file.try_lock()
            .map_err(|error| anyhow::anyhow!("BUILD_LEASE_UNAVAILABLE: {error}"))?;
        Ok(Self { _file: file })
    }
}

pub struct ProcessBudget {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    limit_mib: usize,
}
impl ProcessBudget {
    pub fn enforce(limit_mib: usize) -> Result<Self> {
        if !(64..=16384).contains(&limit_mib) {
            bail!("Invalid process-tree memory limit");
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::GetCurrentProcess},
            };
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    bail!(
                        "TREE_JOB_CREATE_FAILED: {}",
                        std::io::Error::last_os_error()
                    );
                }
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = limit_mib * 1024 * 1024;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, GetCurrentProcess()) == 0
                {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(handle);
                    bail!("TREE_JOB_ASSIGN_FAILED: {error}");
                }
                Ok(Self { handle, limit_mib })
            }
        }
        #[cfg(not(windows))]
        {
            Ok(Self { limit_mib })
        }
    }
    pub fn report(&self) -> Result<serde_json::Value> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::*;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                bail!("TREE_JOB_QUERY_FAILED: {}", std::io::Error::last_os_error());
            }
            if info.JobMemoryLimit != self.limit_mib * 1024 * 1024
                || info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY == 0
            {
                bail!("TREE_JOB_LIMIT_READBACK_FAILED");
            }
            Ok(
                serde_json::json!({"limit_mib":self.limit_mib,"limit_readback_bytes":info.JobMemoryLimit,"enforcement":"Windows Job Object aggregate private-commit allocation limit","os_peak_job_memory_bytes":info.PeakJobMemoryUsed}),
            )
        }
        #[cfg(target_os = "linux")]
        {
            Ok(serde_json::json!({
                "limit_mib": self.limit_mib,
                "enforcement": "unsupported: no OS memory hard cap on Linux; timeout and external cgroups only",
                "oom_score_adj_attempted": false
            }))
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            Ok(serde_json::json!({
                "limit_mib": self.limit_mib,
                "enforcement": "unsupported: no OS memory hard cap on this platform; timeout only",
                "oom_score_adj_attempted": false
            }))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessBudget {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

pub fn parse_statm_rss(content: &str, page_size: usize) -> Result<usize> {
    let mut parts = content.split_whitespace();
    let _total = parts.next().context("missing total pages")?;
    let resident_str = parts.next().context("missing resident pages")?;
    let resident_pages: usize = resident_str.parse().context("invalid resident pages")?;
    Ok(resident_pages * page_size)
}

#[cfg(target_os = "linux")]
extern "C" {
    fn sysconf(name: std::ffi::c_int) -> std::ffi::c_long;
}

#[cfg(target_os = "linux")]
const _SC_PAGE_SIZE: std::ffi::c_int = 30;

#[cfg(target_os = "linux")]
pub fn linux_page_size() -> usize {
    let res = unsafe { sysconf(_SC_PAGE_SIZE) };
    if res > 0 {
        res as usize
    } else {
        4096
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogSignal {
    SoftCap { rss_bytes: usize },
    HardCap { rss_bytes: usize },
    Dead,
}

/// Best-effort process-tree memory watchdog for Linux.
/// This is NOT a hard memory cap. It samples /proc/<pid>/statm
/// (RSS in pages × PAGE_SIZE) for the watched process every 50ms.
/// Shared pages may be double-counted. A sudden spike between polls
/// may trigger kernel OOM before the watchdog reacts.
///
/// The watchdog sends soft-cap (Pause) and hard-cap (Kill) signals
/// via a channel when the observed RSS crosses thresholds.
///
/// oom_score_adj is set to 1000 on the watched process as a best-effort
/// preference to make the kernel OOM killer target the worker before the
/// supervisor. This is NOT guaranteed; it is a probabilistic bias.
#[cfg(target_os = "linux")]
pub struct LinuxWatchdog {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    receiver: std::sync::mpsc::Receiver<WatchdogSignal>,
}

#[cfg(target_os = "linux")]
impl LinuxWatchdog {
    pub fn new(child_pid: u32, budget_bytes: usize) -> Self {
        let oom_path = format!("/proc/{child_pid}/oom_score_adj");
        if let Err(err) = std::fs::write(&oom_path, b"1000") {
            eprintln!("Warning: failed to write 1000 to {oom_path}: {err}");
        }

        let (sender, receiver) = std::sync::mpsc::channel();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_clone = std::sync::Arc::clone(&stop);

        let thread = std::thread::spawn(move || {
            let soft_threshold = (budget_bytes as u128 * 80 / 100) as usize;
            let hard_threshold = (budget_bytes as u128 * 95 / 100) as usize;
            while !stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::park_timeout(std::time::Duration::from_millis(50));
                if stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match Self::read_proc_statm_rss(child_pid) {
                    Ok(rss) => {
                        if rss >= hard_threshold {
                            if sender
                                .send(WatchdogSignal::HardCap { rss_bytes: rss })
                                .is_err()
                            {
                                break;
                            }
                        } else if rss >= soft_threshold {
                            if sender
                                .send(WatchdogSignal::SoftCap { rss_bytes: rss })
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(WatchdogSignal::Dead);
                        break;
                    }
                }
            }
        });

        Self {
            stop,
            thread: Some(thread),
            receiver,
        }
    }

    pub fn signal_receiver(&self) -> &std::sync::mpsc::Receiver<WatchdogSignal> {
        &self.receiver
    }

    pub fn read_proc_statm_rss(pid: u32) -> Result<usize> {
        let path = format!("/proc/{pid}/statm");
        Self::read_statm_path(std::path::Path::new(&path))
    }

    pub fn read_statm_path(path: &std::path::Path) -> Result<usize> {
        let content = std::fs::read_to_string(path)?;
        parse_statm_rss(&content, linux_page_size())
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            handle.thread().unpark();
            let _ = handle.join();
        }
    }
}
