//! Real allocation-denial check in a child inherited into the supervisor's job.
fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--child") {
        let mut bytes = Vec::<u8>::new();
        if bytes.try_reserve_exact(128 * 1024 * 1024).is_err() {
            println!("ALLOCATION_DENIED");
            return Ok(());
        }
        println!("ALLOCATION_ALLOWED");
        return Ok(());
    }
    let control = std::process::Command::new(std::env::current_exe()?)
        .arg("--child")
        .output()?;
    anyhow::ensure!(
        control.status.success()
            && String::from_utf8_lossy(&control.stdout).contains("ALLOCATION_ALLOWED"),
        "uncapped control allocation failed"
    );
    let budget = source_index::budget::ProcessBudget::enforce(64)?;
    let output = std::process::Command::new(std::env::current_exe()?)
        .arg("--child")
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    anyhow::ensure!(
        String::from_utf8_lossy(&output.stdout).contains("ALLOCATION_DENIED"),
        "cap was not enforced"
    );
    println!(
        "{}",
        serde_json::json!({"status":"PASS","uncapped_control_allocation_allowed":true,"allocation_denied_in_child":true,"requested_bytes":128*1024*1024,"budget":budget.report()?})
    );
    Ok(())
}
