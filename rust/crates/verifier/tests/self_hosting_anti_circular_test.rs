use std::fs;
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap() // platform
        .parent()
        .unwrap() // crates
        .parent()
        .unwrap() // workspace root
        .to_path_buf()
}

/// Anti-circular evidence requires a genuine Stage 1 compiler that reads a
/// compiler source file and emits a distinct artifact. Comparing two identical
/// literal strings, or accepting a stub exit code, is not evidence.
#[test]
fn test_anti_circular_compilation_evidence_required() {
    let root = workspace_root();
    let dir = root.join("verification").join("bootstrap");
    let stage1 = dir.join("stage1_compiler.exe");
    let transcript = dir.join("anti_circular_transcript.json");
    if !stage1.exists() || !transcript.exists() {
        panic!(
            "BLOCKED: no genuine anti-circular transcript. Required: {:?} and {:?}. \
             The previous tests compared identical AST/envelope literals and accepted a \
             fixed exit code 200 from a stub. Those tests were removed.",
            stage1, transcript
        );
    }
    let text = fs::read_to_string(&transcript).expect("read anti-circular transcript");
    let json: serde_json::Value = serde_json::from_str(&text).expect("valid transcript JSON");
    let input = json["input_sha256"].as_str().expect("input_sha256");
    let output = json["output_sha256"].as_str().expect("output_sha256");
    assert_ne!(
        input, output,
        "input and output hashes must differ for a real compilation"
    );
    let command = json["command"].as_str().expect("command");
    assert!(
        command.contains("stage1_compiler"),
        "transcript must record the Stage 1 compile command"
    );
}
