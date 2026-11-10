//! git_branch_and_shallow_clone_test.rs
//!
//! Production-grade E2E verification of Git repository states:
//! 1. PR Branch Committed Change: Changes already committed to a feature branch
//!    MUST NOT be falsely skipped by the Git-diff fast path.
//! 2. Shallow Clone (`--depth 1`): CI checkouts with zero commit history must not panic.
//! 3. Detached HEAD: Checking out a detached commit in CI must verify cleanly.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}-{}-{nanos}", prefix, std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn cli_bin() -> PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // drop test binary name
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("sajimora")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("Failed to run git {:?}: {}", args, e));
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn setup_sample_repo(dir: &Path) {
    git(dir, &["init"]);
    git(dir, &["config", "user.name", "QA Bot"]);
    git(dir, &["config", "user.email", "qa@example.com"]);

    // Java backend
    let backend_src = dir.join("backend/src/main/java/com/example");
    fs::create_dir_all(&backend_src).unwrap();
    fs::write(
        backend_src.join("ApiController.java"),
        r#"package com.example;
import org.springframework.web.bind.annotation.*;

class ItemDto {
    public String id;
    public String title;
}

@RestController
public class ApiController {
    @GetMapping("/api/item")
    public ItemDto getItem() { return new ItemDto(); }
}
"#,
    )
    .unwrap();

    // TypeScript frontend
    let frontend_src = dir.join("frontend/src");
    fs::create_dir_all(&frontend_src).unwrap();
    fs::write(
        dir.join("frontend/package.json"),
        r#"{"name": "frontend", "dependencies": {"axios": "^1.0.0"}}"#,
    )
    .unwrap();
    fs::write(
        frontend_src.join("api.ts"),
        r#"import axios from 'axios';
interface ItemDto { id: string; title: string; }
export const fetchItem = () => axios.get<ItemDto>('/api/item');
"#,
    )
    .unwrap();

    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "Initial fullstack application"]);
}

#[test]
fn test_pr_branch_committed_change_detected_against_baseline() {
    let td = TempDirGuard::new("pr_branch");
    let repo = td.path();
    setup_sample_repo(repo);

    let bin = cli_bin();

    // 1. Seal baseline contract with `sajimora init --apply`
    let init_out = Command::new(&bin)
        .args(["init", "--apply"])
        .current_dir(repo)
        .output()
        .expect("sajimora init must execute");
    assert!(init_out.status.success(), "init --apply must succeed");

    // Commit baseline to git
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "chore: seal Sajimora baseline contract"]);

    // 2. Developer checks out a feature branch
    git(repo, &["checkout", "-b", "feature/breaking-api-change"]);

    // 3. Developer introduces a breaking change (deletes `title` field) and COMMITS IT
    let backend_java = repo.join("backend/src/main/java/com/example/ApiController.java");
    fs::write(
        &backend_java,
        r#"package com.example;
import org.springframework.web.bind.annotation.*;

class ItemDto {
    public String id;
    // title removed!
}

@RestController
public class ApiController {
    @GetMapping("/api/item")
    public ItemDto getItem() { return new ItemDto(); }
}
"#,
    )
    .unwrap();

    // Commit the change to the branch
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "feat: remove title field from item"]);

    // At this point, working tree is 100% clean with respect to HEAD!
    // A naive `git diff HEAD` would be empty.
    // Sajimora MUST compare against the baseline commit and catch the breaking change.
    let verify_out = Command::new(&bin)
        .args(["verify", "--trusted-local", "--fail-on-violation"])
        .current_dir(repo)
        .output()
        .expect("sajimora verify must execute");

    let stdout = String::from_utf8_lossy(&verify_out.stdout);
    let stderr = String::from_utf8_lossy(&verify_out.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    // Fast-path MUST NOT be taken!
    assert!(
        !combined.contains("[Fast Path] Zero backend changes detected"),
        "Fast path must not be taken when branch commits modify backend!"
    );

    // Verification MUST detect the breaking change on the committed branch!
    assert_eq!(
        verify_out.status.code(),
        Some(1),
        "sajimora verify must exit 1 on breaking committed branch changes. Output:\n{}",
        combined
    );
    assert!(
        combined.contains("BREAKING CONTRACT REGRESSIONS DETECTED") || combined.contains("❌"),
        "Output must report breaking contract regression. Got:\n{}",
        combined
    );
    assert!(
        combined.contains("title"),
        "Output must name the broken `title` field. Got:\n{}",
        combined
    );
}

#[test]
fn test_shallow_clone_depth_1_resilience() {
    let origin_td = TempDirGuard::new("origin");
    let origin = origin_td.path();
    setup_sample_repo(origin);

    // Make a second commit in origin so history exists
    fs::write(origin.join("README.md"), "# Project\n").unwrap();
    git(origin, &["add", "README.md"]);
    git(origin, &["commit", "-m", "docs: add readme"]);

    // Clone with --depth 1 to simulate CI shallow clone
    let clone_td = TempDirGuard::new("shallow");
    let clone_dir = clone_td.path().join("shallow_repo");
    Command::new("git")
        .args(["clone", "--depth", "1", origin.to_str().unwrap(), clone_dir.to_str().unwrap()])
        .output()
        .expect("git clone --depth 1 must succeed");

    let bin = cli_bin();

    // In a depth-1 clone, HEAD has no parents. `sajimora init --apply` must still succeed cleanly.
    let init_out = Command::new(&bin)
        .args(["init", "--apply"])
        .current_dir(&clone_dir)
        .output()
        .expect("sajimora init must execute in shallow clone");

    assert!(
        init_out.status.success(),
        "sajimora init must succeed in shallow clone (--depth 1). Output:\n{}",
        String::from_utf8_lossy(&init_out.stderr)
    );

    // Verify must also succeed cleanly in shallow clone
    let verify_out = Command::new(&bin)
        .args(["verify", "--trusted-local"])
        .current_dir(&clone_dir)
        .output()
        .expect("sajimora verify must execute in shallow clone");

    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed in shallow clone (--depth 1). Output:\n{}",
        String::from_utf8_lossy(&verify_out.stderr)
    );
}

#[test]
fn test_detached_head_resilience() {
    let td = TempDirGuard::new("detached");
    let repo = td.path();
    setup_sample_repo(repo);

    let head_sha = git(repo, &["rev-parse", "HEAD"]);
    // Checkout specific commit hash to enter detached HEAD
    git(repo, &["checkout", &head_sha]);

    let bin = cli_bin();

    // sajimora doctor in detached HEAD
    let doctor_out = Command::new(&bin)
        .arg("doctor")
        .current_dir(repo)
        .output()
        .expect("sajimora doctor must execute in detached HEAD");
    assert!(
        doctor_out.status.success(),
        "sajimora doctor must succeed in detached HEAD"
    );

    // sajimora init in detached HEAD
    let init_out = Command::new(&bin)
        .args(["init", "--apply"])
        .current_dir(repo)
        .output()
        .expect("sajimora init must execute in detached HEAD");
    assert!(
        init_out.status.success(),
        "sajimora init must succeed in detached HEAD"
    );

    // sajimora verify in detached HEAD
    let verify_out = Command::new(&bin)
        .args(["verify", "--trusted-local"])
        .current_dir(repo)
        .output()
        .expect("sajimora verify must execute in detached HEAD");
    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed in detached HEAD"
    );
}
