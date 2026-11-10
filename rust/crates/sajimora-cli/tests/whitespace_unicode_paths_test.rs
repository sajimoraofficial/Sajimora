//! whitespace_unicode_paths_test.rs — Edge case testing for repositories with whitespace and non-ASCII Unicode paths.
//!
//! Validates:
//! 1. Directory paths with spaces: e.g. `/tmp/sajimora project with spaces/`
//! 2. Directory paths with non-ASCII UTF-8 characters: e.g. `/tmp/sajimora_üñîçødé_pröjéct/`
//! 3. Internal source filenames with spaces: e.g. `frontend/src/order client.ts`
//! 4. Full CLI execution (`init --apply`, `verify`) works seamlessly without path-encoding panics.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(dir_name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}-{}-{nanos}", dir_name, std::process::id()));
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

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Unicode Tester",
            "-c",
            "user.email=unicode@test.com",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.quotepath=false",
        ])
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git command failed");
    assert!(status.success(), "git command {:?} failed", args);
}

#[test]
fn test_repository_with_spaces_in_path() {
    let guard = TempDirGuard::new("sajimora project with spaces in name");
    let repo = guard.path();

    git(repo, &["init"]);

    let backend_dir = repo.join("backend service/src/main/java/com/example/api");
    fs::create_dir_all(&backend_dir).unwrap();
    fs::write(
        repo.join("backend service/pom.xml"),
        r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>space-backend</artifactId>
  <version>1.0.0</version>
</project>"#,
    )
    .unwrap();

    fs::write(
        backend_dir.join("SpaceController.java"),
        r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SpaceController {
    @GetMapping("/api/space/items")
    public SpaceItem getItems() {
        return new SpaceItem();
    }
}

class SpaceItem {
    public Long id;
    public String label;
}
"#,
    )
    .unwrap();

    let fe_dir = repo.join("frontend app/src");
    fs::create_dir_all(&fe_dir).unwrap();
    fs::write(
        repo.join("frontend app/package.json"),
        r#"{"name": "space-fe", "dependencies": {"axios": "^1.6.0"}}"#,
    )
    .unwrap();

    fs::write(
        fe_dir.join("space client.ts"),
        r#"import axios from 'axios';

export interface SpaceItem {
    id: number;
    label: string;
}

export async function fetchSpace(): Promise<SpaceItem> {
    const res = await axios.get<SpaceItem>('/api/space/items');
    return res.data;
}
"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Initial commit with spaces in paths"]);

    // Test sajimora init --apply on path with spaces
    let init_out = Command::new(cli_bin())
        .arg("init")
        .arg("--apply")
        .current_dir(repo)
        .output()
        .expect("sajimora init");

    let stdout = String::from_utf8_lossy(&init_out.stdout);
    let stderr = String::from_utf8_lossy(&init_out.stderr);
    assert!(
        init_out.status.success(),
        "sajimora init must succeed on paths with spaces!\nstdout: {}\nstderr: {}",
        stdout,
        stderr
    );

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Baseline sealed"]);

    // Test sajimora verify on path with spaces
    let verify_out = Command::new(cli_bin())
        .arg("verify")
        .current_dir(repo)
        .output()
        .expect("sajimora verify");

    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed on paths with spaces: {}",
        String::from_utf8_lossy(&verify_out.stderr)
    );
}

#[test]
fn test_repository_with_unicode_characters_in_path() {
    let guard = TempDirGuard::new("sajimora_üñîçødé_tëst_pröjéct_🚀");
    let repo = guard.path();

    git(repo, &["init"]);

    let backend_dir = repo.join("backend/src/main/java/com/example/api");
    fs::create_dir_all(&backend_dir).unwrap();
    fs::write(
        repo.join("backend/pom.xml"),
        r#"<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>unicode-backend</artifactId>
  <version>1.0.0</version>
</project>"#,
    )
    .unwrap();

    fs::write(
        backend_dir.join("UnicodeController.java"),
        r#"package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UnicodeController {
    @GetMapping("/api/unicode")
    public UnicodeDto getUnicode() {
        return new UnicodeDto();
    }
}

class UnicodeDto {
    public Long id;
    public String description;
}
"#,
    )
    .unwrap();

    let fe_dir = repo.join("frontend/src");
    fs::create_dir_all(&fe_dir).unwrap();
    fs::write(
        repo.join("frontend/package.json"),
        r#"{"name": "unicode-fe", "dependencies": {"axios": "^1.6.0"}}"#,
    )
    .unwrap();

    fs::write(
        fe_dir.join("unicodeClient.ts"),
        r#"import axios from 'axios';

export interface UnicodeDto {
    id: number;
    description: string;
}

export async function fetchUnicode(): Promise<UnicodeDto> {
    const res = await axios.get<UnicodeDto>('/api/unicode');
    return res.data;
}
"#,
    )
    .unwrap();

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Initial commit with unicode repo path"]);

    // Test sajimora init --apply on unicode path
    let init_out = Command::new(cli_bin())
        .arg("init")
        .arg("--apply")
        .current_dir(repo)
        .output()
        .expect("sajimora init");

    let stdout = String::from_utf8_lossy(&init_out.stdout);
    let stderr = String::from_utf8_lossy(&init_out.stderr);
    assert!(
        init_out.status.success(),
        "sajimora init must succeed on non-ASCII unicode paths!\nstdout: {}\nstderr: {}",
        stdout,
        stderr
    );

    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "Baseline sealed"]);

    // Test sajimora verify on unicode path
    let verify_out = Command::new(cli_bin())
        .arg("verify")
        .current_dir(repo)
        .output()
        .expect("sajimora verify");

    assert!(
        verify_out.status.success(),
        "sajimora verify must succeed on non-ASCII unicode paths: {}",
        String::from_utf8_lossy(&verify_out.stderr)
    );
}
