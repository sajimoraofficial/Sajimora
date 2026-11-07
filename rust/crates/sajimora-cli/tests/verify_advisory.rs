//! verify_advisory.rs — `sajimora verify` local-mode contract.
//!
//! Two invariants under test:
//! 1. Local verification is advisory by default: a detected breaking change is
//!    reported but does not block the commit. Enforcement is opt-in via
//!    `--fail-on-violation` or `--strict`.
//! 2. Trust anchors come from the caller only. A trust policy or waiver ledger
//!    dropped into the analyzed repository must not govern verification; only
//!    the explicit `--trust-policy` / `--waiver-ledger` flags do, and an explicit
//!    policy must actually be enforced against every artifact.

use contract_core::envelope::compute_envelope_digest_from_value;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
}

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "sajimora-verify-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Re-seal an envelope after mutating it so integrity reflects the new bytes.
fn reseal(mut value: Value) -> String {
    let digest = compute_envelope_digest_from_value(value.clone()).unwrap();
    value["integrity"] = json!({ "sha256": digest });
    serde_json::to_string_pretty(&value).unwrap()
}

/// A repository whose extracted candidate renames `name` to `displayName`,
/// while the sealed baseline and frontend client still expect `name`.
fn breaking_repo(tag: &str) -> PathBuf {
    let repo = unique_dir(tag);
    fs::create_dir_all(repo.join("src/main/java/com/example")).unwrap();
    seal_baseline_and_client(&repo);

    fs::write(
        repo.join("src/main/java/com/example/UserController.java"),
        r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping("/api/users")
    public User getUsers() {
        return new User();
    }
}

class User {
    public Long id;
    public String displayName;
}
"#,
    )
    .unwrap();

    repo
}

/// The sealed baseline and the client contract both expect `name`; every repository built by
/// these tests renames it to `displayName`.
fn seal_baseline_and_client(repo: &Path) {
    fs::create_dir_all(repo.join(".sajimora")).unwrap();

    let mut base: Value = serde_json::from_str(
        &fs::read_to_string(fixtures().join("envelopes/backend_complete.json")).unwrap(),
    )
    .unwrap();
    // The Java extractor reports these values for a checkout without a remote.
    base["envelopeVersion"] = json!("SAJIMORA_CONTRACT_ARTIFACT_V2");
    base["snapshot"]["repositoryId"] = json!("git-root:native");
    fs::write(repo.join(".sajimora/backend-contract.json"), reseal(base)).unwrap();

    let mut frontend: Value = serde_json::from_str(
        &fs::read_to_string(fixtures().join("envelopes/frontend_complete.json")).unwrap(),
    )
    .unwrap();
    // The extractor emits relative routes, no API version, and V2 envelopes
    // for this fixture.
    frontend["envelopeVersion"] = json!("SAJIMORA_CONTRACT_ARTIFACT_V2");
    let client = &mut frontend["payload"]["clientContracts"][0];
    client["normalizedRoute"] = json!("/api/users");
    client.as_object_mut().unwrap().remove("targetApiVersion");
    fs::write(
        repo.join(".sajimora/frontend-contract.json"),
        reseal(frontend),
    )
    .unwrap();
}

/// The same break declared in a sibling Maven module that the served application only depends on.
/// While the type index covered only the served module, `User` stayed an unresolved leaf, the
/// renamed field was never compared, and the break went unreported.
#[test]
fn a_break_in_a_sibling_module_dto_is_detected() {
    let repo = unique_dir("sibling-break");
    fs::write(
        repo.join("pom.xml"),
        "<project>\n  <modules>\n    <module>api</module>\n    <module>app</module>\n  </modules>\n</project>\n",
    )
    .unwrap();
    fs::create_dir_all(repo.join("api/src/main/java/com/example")).unwrap();
    fs::create_dir_all(repo.join("app/src/main/java/com/example")).unwrap();
    seal_baseline_and_client(&repo);

    fs::write(
        repo.join("api/src/main/java/com/example/User.java"),
        "package com.example;\n\npublic class User {\n    public Long id;\n    public String displayName;\n}\n",
    )
    .unwrap();
    fs::write(
        repo.join("app/src/main/java/com/example/UserController.java"),
        r#"package com.example;

import com.example.User;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping("/api/users")
    public User getUsers() {
        return new User();
    }
}
"#,
    )
    .unwrap();

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sajimora"));
    cmd.args([
        "verify",
        "--repo",
        repo.to_str().unwrap(),
        "--backend",
        "app",
    ]);
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

    let candidate = read_candidate(&repo);
    let body = endpoint_body(&candidate, "/api/users");
    assert_eq!(
        body["kind"],
        json!("REF"),
        "the declared sibling module must resolve the DTO instead of leaving it unresolved"
    );
    assert_eq!(
        body["provenance"]["file"],
        json!("api/src/main/java/com/example/User.java"),
        "the resolved type must keep its own module as provenance, not the served module"
    );

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        out.status.code().unwrap_or(-1),
        0,
        "advisory by default even for a cross-module break.\nstdout:\n{stdout}"
    );
}

/// Control for the test above: the same two modules with the DTO module left out of the build
/// declaration. Discovery reads the module list from `pom.xml`/`settings.gradle`, so an undeclared
/// directory is not indexed and the renamed field stays invisible. This pins where the detection in
/// `a_break_in_a_sibling_module_dto_is_detected` comes from, and records the real boundary: a
/// repository whose sources are not declared by its build file gets no cross-module coverage.
#[test]
fn a_dto_module_the_build_file_does_not_declare_stays_unindexed() {
    let repo = unique_dir("undeclared-sibling-break");
    fs::write(
        repo.join("pom.xml"),
        "<project>\n  <modules>\n    <module>app</module>\n  </modules>\n</project>\n",
    )
    .unwrap();
    fs::create_dir_all(repo.join("api/src/main/java/com/example")).unwrap();
    fs::create_dir_all(repo.join("app/src/main/java/com/example")).unwrap();
    seal_baseline_and_client(&repo);

    fs::write(
        repo.join("api/src/main/java/com/example/User.java"),
        "package com.example;\n\npublic class User {\n    public Long id;\n    public String displayName;\n}\n",
    )
    .unwrap();
    fs::write(
        repo.join("app/src/main/java/com/example/UserController.java"),
        r#"package com.example;

import com.example.User;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping("/api/users")
    public User getUsers() {
        return new User();
    }
}
"#,
    )
    .unwrap();

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sajimora"));
    cmd.args([
        "verify",
        "--repo",
        repo.to_str().unwrap(),
        "--backend",
        "app",
    ]);
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

    assert!(
        !breaking_change_reported(&stdout, &stderr),
        "an unindexed DTO cannot be compared, so reporting a break here would be a fabrication.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    let candidate = read_candidate(&repo);
    let body = endpoint_body(&candidate, "/api/users");
    assert_eq!(
        body["kind"],
        json!("UNKNOWN"),
        "the DTO lives in a directory no build file declares; the extractor must say it could not \
         resolve the type rather than invent a shape. body: {body}"
    );

    let pool = &candidate["payload"]["type_pool"];
    assert!(
        pool.is_null()
            || pool
                .as_object()
                .map(|p| !p.contains_key("java:com.example.User"))
                .unwrap_or(false),
        "an undeclared module must not be indexed. type_pool: {pool}"
    );
}

fn read_candidate(repo: &Path) -> Value {
    let path = repo.join(".sajimora/candidate-contract.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("candidate artifact missing at {path:?}: {e}"));
    serde_json::from_str(&text).expect("candidate artifact must be valid JSON")
}

fn endpoint_body<'a>(candidate: &'a Value, route: &str) -> &'a Value {
    candidate["payload"]["endpoints"]
        .as_array()
        .expect("candidate must carry endpoints")
        .iter()
        .find(|ep| ep["identity"]["normalizedRoute"]["rawPath"].as_str() == Some(route))
        .unwrap_or_else(|| panic!("no endpoint for {route} in candidate"))
        .get("body")
        .expect("endpoint must carry a body")
}

fn caller_policy_requiring_signatures() -> String {
    serde_json::to_string_pretty(&json!({
        "producers": [{
            "repositoryId": "git-root:native",
            "serviceId": "user-service"
        }],
        "requireSignatures": true
    }))
    .unwrap()
}

fn run_verify(repo: &Path, extra: &[&str]) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sajimora"));
    cmd.args(["verify", "--repo", repo.to_str().unwrap(), "--backend", "."]);
    cmd.args(extra);
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn breaking_change_reported(stdout: &str, stderr: &str) -> bool {
    stdout.contains("LIKELY VIOLATED") || stderr.contains("LIKELY VIOLATED")
}

fn assert_breaking_change_detected(stdout: &str, stderr: &str) {
    assert!(
        breaking_change_reported(stdout, stderr),
        "expected a reported breaking change.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        !stdout.contains("ANALYSIS ERROR"),
        "fixture must reach a comparison verdict, not an analysis error.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn breaking_change_is_advisory_by_default() {
    let repo = breaking_repo("advisory");
    let (code, stdout, stderr) = run_verify(&repo, &[]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 0,
        "local verification must not block by default.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains("Advisory") || stderr.contains("Advisory"),
        "advisory mode must say that the commit is not blocked.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn fail_on_violation_flag_opts_into_blocking() {
    let repo = breaking_repo("fail-flag");
    let (code, stdout, stderr) = run_verify(&repo, &["--fail-on-violation"]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 1,
        "--fail-on-violation must block.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn strict_opts_into_blocking() {
    let repo = breaking_repo("strict");
    let (code, stdout, stderr) = run_verify(&repo, &["--strict"]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 1,
        "--strict must block on a detected violation.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn repo_local_trust_policy_is_not_a_trust_anchor() {
    let repo = breaking_repo("repo-policy");
    fs::write(
        repo.join(".sajimora/trust-policy.json"),
        caller_policy_requiring_signatures(),
    )
    .unwrap();

    let (code, stdout, stderr) = run_verify(&repo, &[]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 0,
        "local advisory run must not block.\nstdout:\n{stdout}"
    );
}

#[test]
fn frontend_override_path_is_used() {
    let repo = breaking_repo("frontend-override");
    let contracts = repo.join("artifacts");
    fs::create_dir_all(&contracts).unwrap();
    fs::rename(
        repo.join(".sajimora/frontend-contract.json"),
        contracts.join("frontend.json"),
    )
    .unwrap();

    let (code, stdout, stderr) = run_verify(&repo, &["--frontend", "artifacts/frontend.json"]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 0,
        "the --frontend override must reach the comparison engine.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn trusted_local_flag_is_explicit_and_advisory() {
    let repo = breaking_repo("trusted-local");
    let (code, stdout, stderr) = run_verify(&repo, &["--trusted-local"]);

    assert_breaking_change_detected(&stdout, &stderr);
    assert_eq!(
        code, 0,
        "explicit local trust must still be advisory.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn trusted_local_conflicts_with_a_caller_trust_policy() {
    let repo = breaking_repo("trusted-local-conflict");
    let policy_path = repo.join("policy.json");
    fs::write(&policy_path, caller_policy_requiring_signatures()).unwrap();

    let (code, stdout, stderr) = run_verify(
        &repo,
        &[
            "--trusted-local",
            "--trust-policy",
            policy_path.to_str().unwrap(),
        ],
    );

    assert_eq!(
        code, 2,
        "clap must reject contradictory trust declarations.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn caller_supplied_trust_policy_governs_admission() {
    let repo = breaking_repo("caller-policy");
    let policy_path = repo.join("caller-trust-policy.json");
    fs::write(&policy_path, caller_policy_requiring_signatures()).unwrap();

    let (code, stdout, stderr) =
        run_verify(&repo, &["--trust-policy", policy_path.to_str().unwrap()]);

    assert!(
        stdout.contains("admission failed") || stderr.contains("admission failed"),
        "a caller-supplied policy requiring signatures must reject the unsigned local artifacts.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert_eq!(
        code, 0,
        "analysis errors stay advisory unless --strict is passed.\nstdout:\n{stdout}"
    );
}
