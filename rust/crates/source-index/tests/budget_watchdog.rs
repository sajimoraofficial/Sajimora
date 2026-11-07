#[cfg(target_os = "linux")]
mod linux_tests {
    use source_index::budget::LinuxWatchdog;
    use std::path::Path;

    #[test]
    fn test_linux_watchdog_new_self_pid_does_not_panic() {
        let wd = LinuxWatchdog::new(std::process::id(), 256 * 1024 * 1024);
        let _rx = wd.signal_receiver();
    }

    #[test]
    fn test_reading_proc_self_statm_returns_valid_rss() {
        let rss = LinuxWatchdog::read_statm_path(Path::new("/proc/self/statm"))
            .expect("failed to read /proc/self/statm");
        assert!(rss > 0, "RSS must be greater than 0");
    }

    #[test]
    fn test_oom_score_adj_write_failure_is_non_fatal() {
        // Non-existent PID e.g. 999_999_999 to verify non-fatal behavior
        let wd = LinuxWatchdog::new(999_999_999, 256 * 1024 * 1024);
        let _rx = wd.signal_receiver();
    }
}

#[test]
fn test_parse_statm_rss_synthetic() {
    let sample = "12345 6789 234 10 0 50 0\n";
    let rss = source_index::budget::parse_statm_rss(sample, 4096).unwrap();
    assert_eq!(rss, 6789 * 4096);
    assert!(rss > 0);
}

#[cfg(not(target_os = "linux"))]
#[test]
fn test_budget_watchdog_non_linux_platform_status() {
    // On non-Linux platforms, ProcessBudget report accurately reflects best-effort watchdog status
    let budget = source_index::budget::ProcessBudget::enforce(64).unwrap();
    let report = budget.report().unwrap();
    assert!(report.get("enforcement").is_some());
}
