//! High-speed HTML template scanner for Angular, Vue, and frontend web templates.
//! Detects dynamic template property expressions like `[innerHTML]="user.email"` or `{{ user.email }}`.

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateConsumerMatch {
    pub file: String,
    pub line: usize,
    pub expression: String,
    pub kind: String,
}

const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".sajimora",
    ".idea",
    ".vscode",
    "bin",
    "out",
];

/// Collect all `.html` files in the repository, skipping excluded directories.
fn collect_html_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if path.is_dir() {
            if EXCLUDED_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            collect_html_files(&path, files)?;
        } else if path.is_file() && name_str.ends_with(".html") {
            files.push(path);
        }
    }

    Ok(())
}

/// Scan frontend HTML templates for dynamic property accesses matching a target DTO and field.
pub fn scan_html_templates(
    repo_root: &Path,
    target_dto: &str,
    field: &str,
) -> Result<Vec<TemplateConsumerMatch>> {
    let mut html_files = Vec::new();
    collect_html_files(repo_root, &mut html_files)?;

    if html_files.is_empty() {
        return Ok(Vec::new());
    }

    // Dynamic template expression boundaries:
    // 1. Interpolation: {{ expr }}
    // 2. Property / Banana-in-a-box binding: [prop]="expr" or [(prop)]="expr"
    // 3. Structural directives: *ngIf="expr" or *ngFor="expr"
    let binding_re = Regex::new(
        r#"(?s)\{\{\s*(.*?)\s*\}\}|\[[\w\.-]+\]="([^"]+)"|\*[\w\.-]+="([^"]+)""#,
    )?;

    // Member access: identifier.field (e.g. user.email, user?.email, assignee.email)
    let escaped_field = regex::escape(field);
    let member_pattern = format!(
        r#"\b[a-zA-Z_$][\w$]*(?:\?|\s*)?\.{}\b"#,
        escaped_field
    );
    let member_re = Regex::new(&member_pattern)?;

    // String literal stripping pattern: '...'
    let string_lit_re = Regex::new(r#"'[^']*'"#)?;

    let _dto_lower = target_dto.to_lowercase();
    let mut matches = Vec::new();

    for file_path in html_files {
        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Quick check: if file doesn't contain the field name at all, skip parsing lines
        if !content.contains(field) {
            continue;
        }

        let rel_path = file_path
            .strip_prefix(repo_root)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .replace('\\', "/");

        for (line_idx, line) in content.lines().enumerate() {
            // Quick line filter
            if !line.contains(field) {
                continue;
            }

            for cap in binding_re.captures_iter(line) {
                let expr = cap.get(1).or_else(|| cap.get(2)).or_else(|| cap.get(3));
                if let Some(m) = expr {
                    let expr_text = m.as_str().trim();
                    // Strip quoted literals so `'user.email-required'` is not mistaken for a property access
                    let stripped = string_lit_re.replace_all(expr_text, "");
                    if member_re.is_match(&stripped) {
                        matches.push(TemplateConsumerMatch {
                            file: rel_path.clone(),
                            line: line_idx + 1,
                            expression: expr_text.to_string(),
                            kind: "ANGULAR_TEMPLATE_BINDING".to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(matches)
}
