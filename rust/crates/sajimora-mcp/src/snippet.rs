use std::path::Path;

/// Extracts a source code snippet around `target_line` (1-indexed).
/// Returns a string with line numbers formatted, e.g.:
///   "  44 |   this.userService.getUser(id)\n> 45 |     .subscribe(user => this.email = user.email);\n  46 | }"
/// If the file cannot be opened or target_line is out of bounds, returns None.
pub fn extract_source_snippet(
    repo_root: &Path,
    rel_path: &str,
    target_line: i64,
    context_lines: usize,
) -> Option<String> {
    if target_line <= 0 {
        return None;
    }
    let target_line = target_line as usize;
    let clean_rel = rel_path
        .trim_start_matches('/')
        .trim_start_matches('\\');
    let full_path = repo_root.join(clean_rel);

    let content = std::fs::read_to_string(&full_path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    if target_line > total {
        return None;
    }

    let start = target_line.saturating_sub(context_lines + 1);
    let end = (target_line + context_lines).min(total);

    let mut snippet = String::new();
    for (idx, line) in lines[start..end].iter().enumerate() {
        let line_num = start + idx + 1;
        let prefix = if line_num == target_line { ">" } else { " " };
        if !snippet.is_empty() {
            snippet.push('\n');
        }
        snippet.push_str(&format!("{prefix} {:4} | {}", line_num, line));
    }
    Some(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_extract_source_snippet() {
        let temp_dir = std::env::temp_dir().join("sajimora_snippet_test");
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("test.ts");
        fs::write(
            &file_path,
            "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
        )
        .unwrap();

        let snip = extract_source_snippet(&temp_dir, "test.ts", 5, 2).unwrap();
        assert!(snip.contains(">    5 | line5"));
        assert!(snip.contains("     3 | line3"));
        assert!(snip.contains("     7 | line7"));
        assert!(!snip.contains("line2"));
        assert!(!snip.contains("line8"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_out_of_bounds() {
        let temp_dir = std::env::temp_dir().join("sajimora_snippet_test_oob");
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("test.ts");
        fs::write(&file_path, "line1\nline2").unwrap();

        assert!(extract_source_snippet(&temp_dir, "test.ts", 0, 1).is_none());
        assert!(extract_source_snippet(&temp_dir, "test.ts", -5, 1).is_none());
        assert!(extract_source_snippet(&temp_dir, "test.ts", 100, 1).is_none());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
