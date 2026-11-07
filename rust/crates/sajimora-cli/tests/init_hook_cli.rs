//! init_hook_cli.rs — `sajimora init-hook` contract.
//!
//! 1. Advisory by default: the installed hook runs `sajimora verify` without
//!    enforcement flags. `--blocking` opts into `--fail-on-violation --strict`.
//! 2. The command can switch an existing Sajimora hook between modes without
//!    stacking hooks or losing user content.
//! 3. Pre-existing user hooks are preserved (wrapped or chained), and hook
//!    paths are never written outside the repository.
//! 4. An existing init-manifest records the hook so `sajimora clean` can revert it.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "sajimora-init-hook-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap_or_else(|e| panic!("failed to run git {args:?}: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_repo(tag: &str) -> PathBuf {
    let repo = unique_dir(tag);
    git(&repo, &["init", "-q"]);
    repo
}

fn run_init_hook(repo: &Path, extra: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["init-hook", "--repo", repo.to_str().unwrap()])
        .args(extra)
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

fn read_hook(repo: &Path) -> String {
    fs::read_to_string(repo.join(".git/hooks/pre-commit")).unwrap()
}

#[test]
fn installs_an_advisory_hook_by_default() {
    let repo = git_repo("advisory");
    let (code, stdout, stderr) = run_init_hook(&repo, &[]);

    assert_eq!(
        code, 0,
        "init-hook failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    let hook = read_hook(&repo);
    assert!(
        hook.contains("sajimora verify"),
        "hook must invoke verify:\n{hook}"
    );
    assert!(
        !hook.contains("--fail-on-violation"),
        "the default hook must not enforce:\n{hook}"
    );
    assert!(
        hook.contains("Sajimora cross-language verification"),
        "hook must carry the managed marker:\n{hook}"
    );
    assert!(
        hook.contains("|| echo"),
        "an advisory hook must swallow verification failures instead of blocking:\n{hook}"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(repo.join(".git/hooks/pre-commit"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0, "hook must be executable");
    }
}

#[test]
fn blocking_opts_into_enforcement_and_switches_back() {
    let repo = git_repo("modes");
    let (code, _, stderr) = run_init_hook(&repo, &["--blocking"]);
    assert_eq!(code, 0, "init-hook --blocking failed: {stderr}");

    let hook = read_hook(&repo);
    assert!(
        hook.contains("--fail-on-violation") && hook.contains("--strict"),
        "a blocking hook must enforce both violation and fail-closed verdicts:\n{hook}"
    );
    assert!(
        !hook.contains("|| echo"),
        "a blocking hook must propagate verification failures:\n{hook}"
    );

    let (code, _, stderr) = run_init_hook(&repo, &[]);
    assert_eq!(code, 0, "switching back to advisory failed: {stderr}");
    let hook = read_hook(&repo);
    assert!(
        !hook.contains("--fail-on-violation"),
        "re-running without --blocking must revert the managed hook to advisory:\n{hook}"
    );
    assert_eq!(
        hook.matches("Sajimora cross-language verification").count(),
        1,
        "mode switching must replace the managed hook, not stack a second one:\n{hook}"
    );
}

#[test]
fn preserves_a_pre_existing_hook_as_the_original() {
    let repo = git_repo("existing");
    let hooks = repo.join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    let original = "#!/bin/sh\necho user-hook-ran\n";
    fs::write(hooks.join("pre-commit"), original).unwrap();

    let (code, stdout, stderr) = run_init_hook(&repo, &[]);
    assert_eq!(
        code, 0,
        "init-hook failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    assert_eq!(
        fs::read_to_string(hooks.join("pre-commit.sajimora-orig")).unwrap(),
        original,
        "the user hook must be preserved byte-identically"
    );
    let hook = read_hook(&repo);
    assert!(
        hook.contains("pre-commit.sajimora-orig"),
        "the wrapper must delegate to the preserved hook:\n{hook}"
    );
    assert!(
        hook.contains("sajimora verify"),
        "the wrapper must still run verification:\n{hook}"
    );
}

#[test]
fn chains_into_an_active_husky_hook() {
    let repo = git_repo("husky");
    let husky = repo.join(".husky");
    fs::create_dir_all(&husky).unwrap();
    let user_hook = "#!/bin/sh\necho husky-user-hook\n";
    fs::write(husky.join("pre-commit"), user_hook).unwrap();
    git(&repo, &["config", "core.hooksPath", ".husky"]);

    let (code, _, stderr) = run_init_hook(&repo, &[]);
    assert_eq!(code, 0, "init-hook in husky repo failed: {stderr}");

    let chained = fs::read_to_string(husky.join("pre-commit")).unwrap();
    assert!(
        chained.contains("echo husky-user-hook"),
        "user content must be preserved:\n{chained}"
    );
    assert!(
        chained.contains("sajimora verify") && !chained.contains("--fail-on-violation"),
        "husky chain must be advisory by default:\n{chained}"
    );

    let (code, _, stderr) = run_init_hook(&repo, &["--blocking"]);
    assert_eq!(code, 0, "switching husky hook to blocking failed: {stderr}");
    let chained = fs::read_to_string(husky.join("pre-commit")).unwrap();
    assert!(
        chained.contains("--fail-on-violation"),
        "the managed husky block must be upgraded in place:\n{chained}"
    );
    assert_eq!(
        chained
            .matches("Sajimora cross-language verification")
            .count(),
        1,
        "upgrading must not duplicate the managed block:\n{chained}"
    );
    assert!(
        chained.contains("echo husky-user-hook"),
        "user content must survive the upgrade:\n{chained}"
    );
}

#[test]
fn refuses_a_directory_that_is_not_a_git_repository() {
    let dir = unique_dir("no-git");
    let (code, stdout, stderr) = run_init_hook(&dir, &[]);
    assert_ne!(code, 0, "init-hook must fail outside a git repository");
    assert!(
        stdout.contains("Not a git repository") || stderr.contains("Not a git repository"),
        "the failure must explain the missing repository.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

#[test]
fn refuses_to_write_hooks_outside_the_repository() {
    let repo = git_repo("external");
    let external = unique_dir("external-hooks");
    git(
        &repo,
        &["config", "core.hooksPath", external.to_str().unwrap()],
    );

    let (code, stdout, stderr) = run_init_hook(&repo, &[]);
    assert_ne!(code, 0, "an external hooksPath must be refused");
    assert!(
        stdout.contains("outside") || stderr.contains("outside"),
        "the refusal must name the escape.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert_eq!(
        fs::read_dir(&external).unwrap().count(),
        0,
        "nothing may be written outside the repository"
    );
}

fn write_manifest(repo: &Path) -> PathBuf {
    fs::create_dir_all(repo.join(".sajimora")).unwrap();
    let manifest_path = repo.join(".sajimora/init-manifest.json");
    let manifest = json!({
        "manifest_version": 1,
        "status": "complete",
        "sajimora_version": "0.1.0",
        "initialized_at": "2026-10-24T00:00:00Z",
        "roots": {
            "repo_root": repo.to_string_lossy(),
            "backend_root": "backend",
            "frontend_root": null,
            "service_id": "backend-service"
        },
        "owned": { "package_json": null, "hook": null, "gitignore": null },
        "artifacts": []
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest_path
}

fn run_clean(repo: &Path) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_sajimora"))
        .args(["clean", "--repo", repo.to_str().unwrap()])
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

#[test]
fn clean_removes_a_hook_installed_by_init_hook() {
    let repo = git_repo("clean-greenfield");
    write_manifest(&repo);

    let (code, _, stderr) = run_init_hook(&repo, &["--blocking"]);
    assert_eq!(code, 0, "init-hook failed: {stderr}");
    assert!(repo.join(".git/hooks/pre-commit").exists());

    let (code, stdout, stderr) = run_clean(&repo);
    assert_eq!(
        code, 0,
        "clean failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        !repo.join(".git/hooks/pre-commit").exists(),
        "clean must remove the recorded greenfield hook.\nstdout:\n{stdout}"
    );
}

#[test]
fn clean_restores_the_original_hook_wrapped_by_init_hook() {
    let repo = git_repo("clean-wrapper");
    write_manifest(&repo);
    let hooks = repo.join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    let original = "#!/bin/sh\necho user-hook-ran\n";
    fs::write(hooks.join("pre-commit"), original).unwrap();

    let (code, _, stderr) = run_init_hook(&repo, &[]);
    assert_eq!(code, 0, "init-hook failed: {stderr}");

    let (code, stdout, stderr) = run_clean(&repo);
    assert_eq!(
        code, 0,
        "clean failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert_eq!(
        fs::read_to_string(hooks.join("pre-commit")).unwrap(),
        original,
        "clean must restore the user's original hook.\nstdout:\n{stdout}"
    );
}

#[test]
fn records_the_hook_in_an_existing_manifest() {
    let repo = git_repo("manifest");
    let manifest_path = write_manifest(&repo);

    let (code, _, stderr) = run_init_hook(&repo, &[]);
    assert_eq!(code, 0, "init-hook failed: {stderr}");

    let updated: Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        updated["owned"]["hook"]["strategy"], "greenfield",
        "manifest must record the installed hook"
    );
    assert_eq!(
        updated["owned"]["hook"]["target_hook"], ".git/hooks/pre-commit",
        "manifest must record the hook path clean will revert"
    );
    assert_eq!(
        updated["roots"]["service_id"], "backend-service",
        "updating the hook must not disturb other manifest fields"
    );
}
