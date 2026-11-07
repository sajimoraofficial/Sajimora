use std::process::Command;

#[test]
fn source_capture_help_exposes_required_database_and_pinned_revision() {
    for binary in [
        env!("CARGO_BIN_EXE_sajimora"),
        env!("CARGO_BIN_EXE_sajimora-source-pilot"),
    ] {
        let output = Command::new(binary)
            .args(["index-source", "--help"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("--database"));
        assert!(help.contains("--revision"));
        assert!(help.contains("--max-blob-bytes"));
    }
}

#[test]
fn source_capture_rejects_missing_required_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_sajimora-source-pilot"))
        .arg("index-source")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
