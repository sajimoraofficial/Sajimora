use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn sjm_path(root: &Path) -> PathBuf {
    root.join("target").join("debug").join("sjm.exe")
}

fn temp_file(name: &str, contents: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "sajimora-test-{}-{}.sjm",
        std::process::id(),
        name
    ));
    fs::write(&p, contents).expect("write temp source");
    p
}

fn exit_status(output: &std::process::Output) -> i32 {
    output.status.code().unwrap_or(-1)
}

/// Stage 0 must be a real, fail-closed front end: it accepts a valid module and
/// rejects an ordinary type error. This test deliberately does not treat
/// `sjm check` success on the mock driver as bootstrap evidence.
#[test]
fn test_stage0_is_a_real_fail_closed_front_end() {
    let root = workspace_root();
    let sjm = sjm_path(&root);
    assert!(sjm.exists(), "Stage 0 compiler missing at {:?}", sjm);

    let ok = Command::new(&sjm)
        .arg("check")
        .arg("sjm-core/cli/sjm_driver.sjm")
        .current_dir(&root)
        .output()
        .expect("run sjm check");
    assert_eq!(exit_status(&ok), 0, "valid module must check cleanly");

    let bad = temp_file(
        "type-error",
        "to f with a as Int -> returns Int:\n    return \"not an int\"\n",
    );
    let rejected = Command::new(&sjm)
        .arg("check")
        .arg(&bad)
        .current_dir(&root)
        .output()
        .expect("run sjm check on invalid module");
    assert_eq!(
        exit_status(&rejected),
        1,
        "Stage 0 must reject an ordinary type error; stdout/stderr:\n{}\n{}",
        String::from_utf8_lossy(&rejected.stdout),
        String::from_utf8_lossy(&rejected.stderr)
    );

    let unexpanded = temp_file(
        "intent",
        "to f -> returns Int:\n    ?> make it fast\n    return 1\n",
    );
    let gate = Command::new(&sjm)
        .arg("check")
        .arg(&unexpanded)
        .current_dir(&root)
        .output()
        .expect("run sjm check on unexpanded intent");
    assert_eq!(
        exit_status(&gate),
        1,
        "unexpanded intent blocks must fail closed"
    );
}

/// Stage 0 JIT and AOT must agree on an existing Revision 3 construct:
/// a record containing a list, updated by a function. This is a parity test
/// for the reference backend, not a bootstrap certificate.
#[test]
fn test_stage0_jit_aot_parity_for_records_and_lists() {
    let root = workspace_root();
    let sjm = sjm_path(&root);
    let src = r#"define record Vec:
    xs as List of Int

to vset4 with v as Vec, idx as Int, val as Int -> returns Vec:
    let xs be v.xs
    let mutable y0 be xs[0]
    let mutable y1 be xs[1]
    let mutable y2 be xs[2]
    let mutable y3 be xs[3]
    if idx == 0:
        set y0 to val
    if idx == 1:
        set y1 to val
    if idx == 2:
        set y2 to val
    if idx == 3:
        set y3 to val
    let ny be List of Int [y0, y1, y2, y3]
    return Vec { xs: ny }

to start application -> returns Int:
    let z be List of Int [0, 0, 0, 0]
    let v be Vec { xs: z }
    let v2 be vset4(v, 1, 7)
    let xs be v2.xs
    return xs[1] + 100
"#;
    let source = temp_file("jit-aot-parity", src);

    let jit = Command::new(&sjm)
        .arg("run")
        .arg(&source)
        .current_dir(&root)
        .output()
        .expect("run JIT");
    let jit_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&jit.stdout),
        String::from_utf8_lossy(&jit.stderr)
    );
    let jit_code = jit_text
        .lines()
        .find_map(|line| line.split("Exit Status Code:").nth(1))
        .and_then(|v| v.trim().parse::<i32>().ok())
        .unwrap_or_else(|| panic!("no JIT exit status in:\n{}", jit_text));
    assert_eq!(jit_code, 107, "JIT parity baseline");

    let build_dir = std::env::temp_dir().join(format!("sajimora-aot-{}", std::process::id()));
    fs::create_dir_all(&build_dir).expect("create build dir");
    let exe = build_dir.join("parity.exe");
    let build = Command::new(&sjm)
        .arg("build")
        .arg(&source)
        .arg("-o")
        .arg(&exe)
        .current_dir(&build_dir)
        .output()
        .expect("build AOT");
    assert!(
        build.status.success() && exe.exists(),
        "AOT build failed:\n{}\n{}",
        String::from_utf8_lossy(&build.stdout),
        String::from_utf8_lossy(&build.stderr)
    );
    let run = Command::new(&exe).output().expect("run AOT binary");
    assert_eq!(
        exit_status(&run),
        107,
        "AOT must agree with JIT on records and lists"
    );
}

/// There is no genuine Stage 1 compiler in this repository. This test is
/// fail-closed: it requires a committed Stage 1 binary plus a build transcript
/// that contains real commands and distinct stage hashes. It currently fails
/// with an explicit blocker instead of claiming success from stub exit codes.
#[test]
fn test_stage1_sequential_compilation_evidence_required() {
    let root = workspace_root();
    let dir = root.join("verification").join("bootstrap");
    let stage1 = dir.join("stage1_compiler.exe");
    let transcript = dir.join("build-transcript.json");
    if !stage1.exists() || !transcript.exists() {
        panic!(
            "BLOCKED: no genuine Stage 1 compiler/transcript. Required: {:?} and {:?}. \
             The previous acceptance test only checked a 2.5 KB ExitProcess stub; that is \
             not bootstrap evidence. Provide a real compiler built from sjm-core source, \
             a recorded Stage 0->1->2->3 command transcript, and executable output proof.",
            stage1, transcript
        );
    }
    let text = fs::read_to_string(&transcript).expect("read transcript");
    let json: serde_json::Value = serde_json::from_str(&text).expect("valid transcript JSON");
    for key in [
        "stage0_command",
        "stage1_command",
        "stage2_command",
        "stage3_command",
        "stage1_sha256",
        "stage2_sha256",
        "stage3_sha256",
    ] {
        assert!(
            json.get(key).and_then(|v| v.as_str()).is_some(),
            "transcript missing string field '{}'",
            key
        );
    }
    assert_ne!(
        json["stage1_sha256"], json["stage3_sha256"],
        "Stage 1 and Stage 3 must be independently produced binaries"
    );
    let run = Command::new(&stage1)
        .arg("--version")
        .output()
        .expect("execute Stage 1");
    assert!(
        run.status.success(),
        "Stage 1 binary must execute: {}",
        String::from_utf8_lossy(&run.stderr)
    );
}

/// Metadata must not claim L3 behavioral parity without evidence, and every
/// non-null rust_reference must exist on disk.
#[test]
fn test_module_inventory_has_no_unproven_pass_claims() {
    let root = workspace_root();
    let path = root.join("sjm-core").join("module_inventory.json");
    let text = fs::read_to_string(&path).expect("read module inventory");
    let json: serde_json::Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).expect("valid JSON");
    let modules = json["modules"].as_array().expect("modules array");
    for m in modules {
        let id = m["id"].as_str().unwrap_or("");
        let subsystem = m["subsystem"].as_str().unwrap_or("");
        if let Some(reference) = m.get("rust_reference").and_then(|v| v.as_str()) {
            assert!(
                root.join(reference).exists(),
                "module '{}' references missing rust file '{}'",
                id,
                reference
            );
        }
        let scoped = subsystem == "codegen" || id == "verifier_solver";
        if scoped && m["l3_status"] == "PASS" {
            let evidence = m.get("differential_evidence").and_then(|v| v.as_str());
            assert!(
                evidence.is_some(),
                "module '{}' claims L3 PASS without differential evidence",
                id
            );
            assert!(
                root.join(evidence.unwrap()).exists(),
                "module '{}' differential evidence file is missing",
                id
            );
        }
    }
}
