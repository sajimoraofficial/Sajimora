use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_label() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[test]
fn extract_frontend_rejects_a_repository_that_does_not_exist() {
    let tmp = std::env::temp_dir().join(format!("sajimora-fe-missing-{}", temp_label()));
    fs::create_dir_all(&tmp).unwrap();
    let out_file = tmp.join("fe.contract.json");
    let missing = tmp.join("no-such-repo");

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-frontend",
            "--repo",
            missing.to_str().unwrap(),
            "--out",
            out_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "a repository path that cannot be read must not exit successfully"
    );
    assert!(
        !out_file.exists(),
        "no artifact may be written for a repository that was never read"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("does not exist"),
        "expected an explicit path error, got: {stderr}"
    );

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn extract_frontend_rejects_a_ts_root_that_does_not_exist() {
    let tmp = std::env::temp_dir().join(format!("sajimora-fe-tsroot-{}", temp_label()));
    let repo = tmp.join("repo");
    fs::create_dir_all(&repo).unwrap();
    let out_file = tmp.join("fe.contract.json");

    let output = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args([
            "extract-frontend",
            "--repo",
            repo.to_str().unwrap(),
            "--ts-root",
            "src/app/absent",
            "--out",
            out_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "an empty scan root is a wrong path, not a frontend with no calls"
    );
    assert!(!out_file.exists(), "no artifact may be written");

    let _ = fs::remove_dir_all(&tmp);
}
