//! change_evaluate.rs — end-to-end tests for the Expected Change Model evaluator.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

struct Temp {
    path: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-change-eval-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn repo(&self) -> PathBuf {
        let repo = self.path.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        git(&repo, &["config", "user.name", "Fixture"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        repo
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn write(repo: &Path, relative: &str, content: &str) {
    let path = repo.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn remove(repo: &Path, relative: &str) {
    fs::remove_file(repo.join(relative)).unwrap();
}

fn commit(repo: &Path, message: &str) -> String {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

fn write_ecm(repo: &Path, name: &str, ecm: &Value) -> PathBuf {
    let path = repo.join(".sajimora").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_string_pretty(ecm).unwrap()).unwrap();
    path
}

fn run(repo: &Path, ecm: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .arg("change-evaluate")
        .arg("--repo")
        .arg(repo)
        .arg("--ecm")
        .arg(ecm)
        .args(extra)
        .output()
        .unwrap()
}

fn read_report(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn actual<'a>(report: &'a Value, path: &str) -> &'a Value {
    report["actualMutations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|mutation| mutation["filePath"] == path)
        .unwrap_or_else(|| panic!("missing actual mutation for {path}: {report:#}"))
}

fn expectation<'a>(
    report: &'a Value,
    file_path: &str,
    change_type: &str,
    symbol: Option<&str>,
) -> &'a Value {
    report["expectations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|expectation| {
            expectation["declared"]["filePath"] == file_path
                && expectation["declared"]["changeType"] == change_type
                && match symbol {
                    Some(symbol) => expectation["declared"]["symbolName"] == symbol,
                    None => expectation["declared"]["symbolName"].is_null(),
                }
        })
        .unwrap_or_else(|| {
            panic!("missing expectation {file_path} {change_type} {symbol:?}: {report:#}")
        })
}

#[test]
fn intended_unintended_unobserved_and_boundary_are_distinguished() {
    let temp = Temp::new("classification");
    let repo = temp.repo();
    write(&repo, "src/A.java", "package demo;\npublic class A { }\n");
    write(&repo, "src/B.java", "package demo;\npublic class B { }\n");
    write(&repo, "docs/guide.md", "guide\n");
    let base = commit(&repo, "base");

    write(
        &repo,
        "src/A.java",
        "package demo;\npublic class A { public void added() { } }\n",
    );
    remove(&repo, "src/B.java");
    write(&repo, "src/C.java", "package demo;\npublic class C { }\n");
    write(&repo, "docs/guide.md", "guide updated\n");
    let candidate = commit(&repo, "candidate");

    let ecm = json!({
        "ecmVersion": 1,
        "expectedFiles": [
            {"filePath": "src/A.java", "changeType": "MODIFIED"},
            {"filePath": "src/B.java", "changeType": "DELETED"},
            {"filePath": "src/D.java", "changeType": "MODIFIED"}
        ],
        "changeBoundary": {
            "forbiddenPaths": ["docs"],
            "reason": "Documentation is generated elsewhere."
        }
    });
    let ecm_path = write_ecm(&repo, "ecm.json", &ecm);
    let out = temp.path.join("report.json");

    let output = run(
        &repo,
        &ecm_path,
        &[
            "--base",
            &base,
            "--candidate",
            &candidate,
            "--out",
            out.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = read_report(&out);

    assert_eq!(report["schemaVersion"], "SAJIMORA_CHANGE_EVALUATION_V1");
    assert_eq!(report["verdict"], "UNINTENDED_REGRESSION");
    assert_eq!(report["ecm"]["base"]["source"], "OVERRIDE");
    assert_eq!(report["ecm"]["candidate"]["resolved"], candidate);

    let a = actual(&report, "src/A.java");
    assert_eq!(a["verdict"], "INTENDED_MUTATION");
    assert_eq!(a["matchedExpectationIndex"], 0);
    assert_eq!(a["symbols"]["status"], "COMPLETE");
    assert!(
        a["symbols"]["added"]
            .as_array()
            .unwrap()
            .iter()
            .any(|symbol| symbol == "A#added"),
        "{a:#}"
    );

    let b = actual(&report, "src/B.java");
    assert_eq!(b["changeType"], "DELETED");
    assert_eq!(b["verdict"], "INTENDED_MUTATION");

    let c = actual(&report, "src/C.java");
    assert_eq!(c["changeType"], "ADDED");
    assert_eq!(c["verdict"], "UNINTENDED_REGRESSION");
    assert_eq!(c["reasonCode"], "UNDECLARED_FILE_MUTATION");
    assert!(c["symbols"]["added"]
        .as_array()
        .unwrap()
        .iter()
        .any(|symbol| symbol == "C"));

    let docs = actual(&report, "docs/guide.md");
    assert_eq!(docs["verdict"], "UNINTENDED_REGRESSION");
    assert_eq!(docs["reasonCode"], "BOUNDARY_VIOLATION");
    assert_eq!(docs["boundary"]["prefix"], "docs");
    assert!(
        docs["symbols"].is_null(),
        "non-Java file carries no symbols"
    );

    let unobserved = expectation(&report, "src/D.java", "MODIFIED", None);
    assert_eq!(unobserved["verdict"], "UNOBSERVED_EXPECTATION");
    assert_eq!(unobserved["reasonCode"], "FILE_NOT_OBSERVED");

    let summary = &report["summary"];
    assert_eq!(summary["observedFileMutations"], 4);
    assert_eq!(summary["intendedFileMutations"], 2);
    assert_eq!(summary["unintendedFileMutations"], 2);
    assert_eq!(summary["boundaryViolations"], 1);
    assert_eq!(summary["expectationsIntended"], 2);
    assert_eq!(summary["expectationsUnobserved"], 1);
    assert_eq!(summary["expectationsUnverifiable"], 0);
    assert_eq!(summary["symbolEvidenceIncomplete"], false);
    assert_eq!(report["completeness"]["symbolEvidence"]["complete"], true);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("change-evaluate: UNINTENDED_REGRESSION"),
        "{stderr}"
    );
}

#[test]
fn rename_and_symbol_expectations_are_evaluated_structurally() {
    let temp = Temp::new("symbols");
    let repo = temp.repo();
    write(
        &repo,
        "src/UserManager.java",
        "package demo;\npublic class UserManager { public void save() { } }\n",
    );
    write(
        &repo,
        "src/UserDto.java",
        "package demo;\npublic class UserDto {\n    private int count;\n    public void rename(String value) { }\n    public void untouched() { }\n    public String oldLabel() { return \"\"; }\n}\n",
    );
    commit(&repo, "base");

    remove(&repo, "src/UserManager.java");
    write(
        &repo,
        "src/UserService.java",
        "package demo;\npublic class UserManager { public void save() { } }\n",
    );
    write(
        &repo,
        "src/UserDto.java",
        "package demo;\npublic class UserDto {\n    private String name;\n    public void rename(String value, int retries) { }\n    public void untouched() { }\n    public void added() { }\n    public String newLabel() { return \"\"; }\n}\n",
    );
    let candidate = commit(&repo, "candidate");

    let ecm = json!({
        "base": "HEAD~1",
        "candidate": "HEAD",
        "expectedFiles": [
            {
                "filePath": "src/UserService.java",
                "oldFilePath": "src/UserManager.java",
                "changeType": "RENAMED"
            }
        ],
        "expectedSymbols": [
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#added", "changeType": "ADDED"},
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#count", "changeType": "REMOVED"},
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#rename", "changeType": "SIGNATURE_CHANGED"},
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#untouched", "changeType": "SIGNATURE_CHANGED"},
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#missing", "changeType": "ADDED"},
            {"filePath": "src/UserDto.java", "symbolName": "UserDto#newLabel", "oldSymbolName": "UserDto#oldLabel", "changeType": "RENAMED"},
            {"filePath": "src/client.ts", "symbolName": "Client#boot", "changeType": "ADDED"}
        ]
    });
    let ecm_path = write_ecm(&repo, "ecm.json", &ecm);
    let out = temp.path.join("report.json");

    let output = run(&repo, &ecm_path, &["--out", out.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = read_report(&out);
    assert_eq!(report["ecm"]["base"]["source"], "ECM");
    assert_eq!(report["ecm"]["candidate"]["resolved"], candidate);

    let rename = actual(&report, "src/UserService.java");
    assert_eq!(rename["changeType"], "RENAMED");
    assert_eq!(rename["oldFilePath"], "src/UserManager.java");
    assert_eq!(rename["verdict"], "INTENDED_MUTATION");
    assert_eq!(rename["symbols"]["status"], "UNCHANGED_CONTENT");

    let dto = actual(&report, "src/UserDto.java");
    assert_eq!(dto["changeType"], "MODIFIED");
    assert_eq!(dto["verdict"], "INTENDED_MUTATION");
    assert_eq!(dto["reasonCode"], "SYMBOL_EXPECTATION_OBSERVED");
    let added: Vec<&str> = dto["symbols"]["added"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(added.contains(&"UserDto#added"), "{added:?}");
    assert!(added.contains(&"UserDto#name"), "{added:?}");
    assert_eq!(
        dto["symbols"]["removed"],
        json!(["UserDto#count", "UserDto#oldLabel"])
    );
    assert_eq!(
        dto["symbols"]["signatureChanged"][0]["symbol"],
        "UserDto#rename"
    );

    let added_expectation =
        expectation(&report, "src/UserDto.java", "ADDED", Some("UserDto#added"));
    assert_eq!(added_expectation["verdict"], "INTENDED_MUTATION");
    assert_eq!(added_expectation["matched"]["changeType"], "ADDED");
    let removed_expectation = expectation(
        &report,
        "src/UserDto.java",
        "REMOVED",
        Some("UserDto#count"),
    );
    assert_eq!(removed_expectation["verdict"], "INTENDED_MUTATION");
    let signature_expectation = expectation(
        &report,
        "src/UserDto.java",
        "SIGNATURE_CHANGED",
        Some("UserDto#rename"),
    );
    assert_eq!(signature_expectation["verdict"], "INTENDED_MUTATION");

    let unchanged = expectation(
        &report,
        "src/UserDto.java",
        "SIGNATURE_CHANGED",
        Some("UserDto#untouched"),
    );
    assert_eq!(unchanged["verdict"], "UNOBSERVED_EXPECTATION");
    assert_eq!(unchanged["reasonCode"], "SIGNATURE_UNCHANGED");

    let missing = expectation(
        &report,
        "src/UserDto.java",
        "ADDED",
        Some("UserDto#missing"),
    );
    assert_eq!(missing["verdict"], "UNOBSERVED_EXPECTATION");
    assert_eq!(missing["reasonCode"], "SYMBOL_NOT_FOUND");

    let symbol_rename = expectation(
        &report,
        "src/UserDto.java",
        "RENAMED",
        Some("UserDto#newLabel"),
    );
    assert_eq!(symbol_rename["verdict"], "INTENDED_MUTATION");
    assert_eq!(symbol_rename["reasonCode"], "SYMBOL_RENAMED_OBSERVED");
    assert_eq!(symbol_rename["signaturePreserved"], true);

    let non_java = expectation(&report, "src/client.ts", "ADDED", Some("Client#boot"));
    assert_eq!(non_java["verdict"], "UNVERIFIABLE");
    assert_eq!(non_java["reasonCode"], "NON_JAVA_SYMBOL_EVIDENCE");

    assert_eq!(report["verdict"], "INCOMPLETE_EVIDENCE");
    let summary = &report["summary"];
    assert_eq!(summary["intendedFileMutations"], 2);
    assert_eq!(summary["unintendedFileMutations"], 0);
    assert_eq!(summary["expectationsIntended"], 5);
    assert_eq!(summary["expectationsUnobserved"], 2);
    assert_eq!(summary["expectationsUnverifiable"], 1);
    assert_eq!(summary["observedSymbolMutations"], 6);
}

#[test]
fn content_changing_rename_is_reported_as_a_declared_rename() {
    let temp = Temp::new("rename");
    let repo = temp.repo();
    write(
        &repo,
        "src/Old.java",
        "package demo;\npublic class Old { }\n",
    );
    commit(&repo, "base");
    remove(&repo, "src/Old.java");
    write(
        &repo,
        "src/New.java",
        "package demo;\npublic class New { }\n",
    );
    commit(&repo, "candidate");

    let ecm = json!({
        "base": "HEAD~1",
        "candidate": "HEAD",
        "expectedFiles": [
            {"filePath": "src/New.java", "oldFilePath": "src/Old.java", "changeType": "RENAMED"}
        ],
        "expectedSymbols": [
            {"filePath": "src/New.java", "symbolName": "New", "oldSymbolName": "Old", "changeType": "RENAMED"}
        ]
    });
    let ecm_path = write_ecm(&repo, "ecm.json", &ecm);
    let out = temp.path.join("report.json");
    let output = run(&repo, &ecm_path, &["--out", out.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = read_report(&out);

    assert_eq!(report["verdict"], "INTENDED_CHANGE");
    let rename_expectation = expectation(&report, "src/New.java", "RENAMED", None);
    assert_eq!(rename_expectation["verdict"], "INTENDED_MUTATION");
    assert_eq!(
        rename_expectation["reasonCode"],
        "DECLARED_RENAME_CONTENT_CHANGED"
    );
    assert_eq!(rename_expectation["matched"]["contentPreserved"], false);

    let added = actual(&report, "src/New.java");
    assert_eq!(added["changeType"], "ADDED");
    assert_eq!(added["verdict"], "INTENDED_MUTATION");
    assert_eq!(added["matchedExpectationIndex"], 0);
    let removed = actual(&report, "src/Old.java");
    assert_eq!(removed["changeType"], "DELETED");
    assert_eq!(removed["verdict"], "INTENDED_MUTATION");
    assert_eq!(removed["matchedExpectationIndex"], 0);

    let symbol = expectation(&report, "src/New.java", "RENAMED", Some("New"));
    assert_eq!(symbol["verdict"], "INTENDED_MUTATION");
    assert_eq!(symbol["signaturePreserved"], true);
    assert_eq!(report["summary"]["unintendedFileMutations"], 0);
}

#[test]
fn invalid_ecms_are_rejected_before_any_report_is_written() {
    let temp = Temp::new("invalid");
    let repo = temp.repo();
    write(&repo, "src/A.java", "package demo;\npublic class A { }\n");
    commit(&repo, "base");

    let cases: Vec<(&str, String, &str)> = vec![
        ("malformed", "{ not json".to_string(), "Invalid ECM JSON"),
        (
            "unknown-field",
            serde_json::to_string(&json!({
                "base": "HEAD",
                "candidate": "HEAD",
                "expectedFile": []
            }))
            .unwrap(),
            "unknown field",
        ),
        (
            "rename-without-old-path",
            serde_json::to_string(&json!({
                "base": "HEAD",
                "candidate": "HEAD",
                "expectedFiles": [{"filePath": "src/A.java", "changeType": "RENAMED"}]
            }))
            .unwrap(),
            "requires oldFilePath",
        ),
        (
            "duplicate-path",
            serde_json::to_string(&json!({
                "base": "HEAD",
                "candidate": "HEAD",
                "expectedFiles": [
                    {"filePath": "src/A.java", "changeType": "MODIFIED"},
                    {"filePath": "src/A.java", "changeType": "DELETED"}
                ]
            }))
            .unwrap(),
            "more than one file expectation",
        ),
        (
            "expectation-inside-boundary",
            serde_json::to_string(&json!({
                "base": "HEAD",
                "candidate": "HEAD",
                "expectedFiles": [{"filePath": "docs/a.md", "changeType": "MODIFIED"}],
                "changeBoundary": {"forbiddenPaths": ["docs"], "reason": "generated"}
            }))
            .unwrap(),
            "contradicts itself",
        ),
        (
            "missing-revisions",
            serde_json::to_string(&json!({"expectedFiles": []})).unwrap(),
            "does not declare base",
        ),
    ];

    for (name, body, needle) in cases {
        let ecm = repo.join(".sajimora").join(format!("{name}.json"));
        fs::create_dir_all(ecm.parent().unwrap()).unwrap();
        fs::write(&ecm, body).unwrap();
        let out = temp.path.join(format!("{name}-report.json"));
        let output = run(&repo, &ecm, &["--out", out.to_str().unwrap()]);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{name} unexpectedly succeeded: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(needle),
            "{name}: expected {needle:?} in {stderr}"
        );
        assert!(!out.exists(), "{name} wrote a report despite failing");
    }
}

#[test]
fn output_paths_are_guarded_and_reports_are_byte_deterministic() {
    let temp = Temp::new("output");
    let repo = temp.repo();
    fs::create_dir_all(repo.join(".sajimora")).unwrap();
    write(&repo, "src/A.java", "package demo;\npublic class A { }\n");
    commit(&repo, "base");
    write(
        &repo,
        "src/A.java",
        "package demo;\npublic class A { public void run() { } }\n",
    );
    commit(&repo, "candidate");

    let ecm = json!({
        "base": "HEAD~1",
        "candidate": "HEAD",
        "expectedFiles": [{"filePath": "src/A.java", "changeType": "MODIFIED"}]
    });
    let ecm_path = write_ecm(&repo, "ecm.json", &ecm);

    let first = temp.path.join("first.json");
    let second = temp.path.join("second.json");
    let run_first = run(&repo, &ecm_path, &["--out", first.to_str().unwrap()]);
    let run_second = run(&repo, &ecm_path, &["--out", second.to_str().unwrap()]);
    assert!(run_first.status.success());
    assert!(run_second.status.success());
    assert_eq!(
        fs::read(&first).unwrap(),
        fs::read(&second).unwrap(),
        "two runs over the same tree must be byte-identical"
    );

    let default_out = run(&repo, &ecm_path, &[]);
    assert!(
        default_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&default_out.stderr)
    );
    assert!(repo.join(".sajimora/change-evaluation.json").is_file());

    let reserved = repo.join(".sajimora/endpoint-impact.json");
    let output = run(&repo, &ecm_path, &["--out", reserved.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("reserved"));

    let wrong_extension = temp.path.join("report.txt");
    let output = run(
        &repo,
        &ecm_path,
        &["--out", wrong_extension.to_str().unwrap()],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains(".json"));

    let foreign = temp.path.join("foreign.json");
    fs::write(
        &foreign,
        r#"{"schemaVersion":"SAJIMORA_ENDPOINT_IMPACT_V1"}"#,
    )
    .unwrap();
    let output = run(&repo, &ecm_path, &["--out", foreign.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("not a SAJIMORA_CHANGE_EVALUATION_V1 report"));
    assert_eq!(
        fs::read_to_string(&foreign).unwrap(),
        r#"{"schemaVersion":"SAJIMORA_ENDPOINT_IMPACT_V1"}"#
    );
}

#[test]
fn a_symbol_rename_on_a_new_file_is_unverifiable_not_absent_from_base() {
    let temp = Temp::new("rename-base");
    let repo = temp.repo();
    write(
        &repo,
        "src/Keep.java",
        "package demo;\npublic class Keep { }\n",
    );
    commit(&repo, "base");
    write(
        &repo,
        "src/Fresh.java",
        "package demo;\npublic class Fresh { }\n",
    );
    commit(&repo, "candidate");

    let ecm = json!({
        "base": "HEAD~1",
        "candidate": "HEAD",
        "expectedFiles": [
            {"filePath": "src/Fresh.java", "changeType": "ADDED"}
        ],
        "expectedSymbols": [
            {"filePath": "src/Fresh.java", "symbolName": "Fresh", "oldSymbolName": "Legacy", "changeType": "RENAMED"}
        ]
    });
    let ecm_path = write_ecm(&repo, "ecm.json", &ecm);
    let out = temp.path.join("report.json");
    let output = run(&repo, &ecm_path, &["--out", out.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = read_report(&out);
    let rename = expectation(&report, "src/Fresh.java", "RENAMED", Some("Fresh"));
    assert_eq!(rename["verdict"], "UNVERIFIABLE");
    assert_eq!(rename["reasonCode"], "RENAME_BASE_FILE_NOT_OBSERVED");
    assert_eq!(report["verdict"], "INCOMPLETE_EVIDENCE");
    assert_eq!(report["summary"]["unintendedFileMutations"], 0);
}
