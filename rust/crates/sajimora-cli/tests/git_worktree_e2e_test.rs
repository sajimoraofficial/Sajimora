//! git_worktree_e2e_test.rs
//!
//! Enterprise QA test for Git Worktree support:
//! In advanced developer and CI workflows, teams use `git worktree add` to check out
//! multiple branches concurrently in parallel directories.
//!
//! In a Git worktree:
//! - `.git` is a regular file containing `gitdir: <path>`, NOT a directory.
//! - Hook resolution must use `git rev-parse --git-path hooks`.
//! - Init, Doctor, and Verify must operate cleanly without assuming `.git` is a directory.

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
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
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

#[test]
fn test_git_worktree_full_lifecycle() {
    let main_guard = TempDirGuard::new("main_repo");
    let main_repo = main_guard.path();

    // 1. Initialize main git repo
    git(main_repo, &["init"]);
    git(main_repo, &["config", "user.name", "Worktree QA"]);
    git(main_repo, &["config", "user.email", "worktree@example.com"]);

    // Create minimal backend and frontend
    let backend_src = main_repo.join("backend/src/main/java/com/example");
    fs::create_dir_all(&backend_src).unwrap();
    fs::write(
        backend_src.join("OrderController.java"),
        r#"package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
    @GetMapping("/api/orders")
    public String getOrders() { return "orders"; }
}
"#,
    )
    .unwrap();

    let frontend_src = main_repo.join("frontend/src");
    fs::create_dir_all(&frontend_src).unwrap();
    fs::write(
        main_repo.join("frontend/package.json"),
        r#"{"name": "frontend", "dependencies": {"axios": "^1.0.0"}}"#,
    )
    .unwrap();
    fs::write(
        frontend_src.join("api.ts"),
        r#"import axios from 'axios';
export const getOrders = () => axios.get<string>('/api/orders');
"#,
    )
    .unwrap();

    git(main_repo, &["add", "."]);
    git(main_repo, &["commit", "-m", "Initial commit on main"]);

    // 2. Create a secondary branch
    git(main_repo, &["branch", "feature-worktree"]);

    // 3. Add a worktree pointing to the secondary branch
    let wt_guard = TempDirGuard::new("worktree_repo");
    let worktree_dir = wt_guard.path().join("linked_worktree");

    git(
        main_repo,
        &[
            "worktree",
            "add",
            worktree_dir.to_str().unwrap(),
            "feature-worktree",
        ],
    );

    // Verify .git is indeed a FILE in the worktree, not a directory
    let git_item = worktree_dir.join(".git");
    assert!(git_item.is_file(), ".git in a worktree must be a file, not a directory");

    let bin = cli_bin();

    // 4. Run `sajimora doctor` in worktree
    let doc_out = Command::new(&bin)
        .arg("doctor")
        .current_dir(&worktree_dir)
        .output()
        .expect("doctor must execute in worktree");
    let doc_stdout = String::from_utf8_lossy(&doc_out.stdout);
    assert!(
        doc_out.status.success(),
        "sajimora doctor must exit 0 in worktree. Got:\n{}",
        doc_stdout
    );
    assert!(
        doc_stdout.contains("valid worktree detected"),
        "doctor must detect valid worktree"
    );

    // 5. Run `sajimora init --apply` in worktree
    let init_out = Command::new(&bin)
        .args(["init", "--apply"])
        .current_dir(&worktree_dir)
        .output()
        .expect("init must execute in worktree");
    let init_stdout = String::from_utf8_lossy(&init_out.stdout);
    assert!(
        init_out.status.success(),
        "sajimora init must succeed in worktree. Got:\n{}",
        init_stdout
    );

    // 6. Run `sajimora verify` in worktree
    let verify_out = Command::new(&bin)
        .args(["verify", "--trusted-local"])
        .current_dir(&worktree_dir)
        .output()
        .expect("verify must execute in worktree");
    let verify_stdout = String::from_utf8_lossy(&verify_out.stdout);
    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed in worktree. Got:\n{}",
        verify_stdout
    );
    assert!(
        verify_stdout.contains("PASS") || verify_stdout.contains("LikelyPreserved"),
        "verify must report clean contract verification in worktree. Got:\n{}",
        verify_stdout
    );
}
