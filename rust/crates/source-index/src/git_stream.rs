use anyhow::{bail, Context, Result};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub const RECORD_LIMIT: usize = 64 * 1024;
pub const CHUNK_SIZE: usize = 1024 * 1024;

pub fn command(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("--no-replace-objects").arg("-C").arg(repo);
    // Never fetch promisor objects or run optional index maintenance.
    cmd.env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// Bounded record reader: read_until would allocate before checking the bound.
pub fn record(reader: &mut impl BufRead, delimiter: u8, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            if output.is_empty() {
                return Ok(None);
            }
            bail!("Truncated Git record");
        }
        let end = bytes.iter().position(|byte| *byte == delimiter);
        let length = end.map_or(bytes.len(), |offset| offset + 1);
        if output.len() + length > limit {
            bail!("Git record exceeds {limit} bytes");
        }
        output.extend_from_slice(&bytes[..length]);
        reader.consume(length);
        if end.is_some() {
            output.pop();
            return Ok(Some(output));
        }
    }
}

pub struct GitChild {
    pub child: Child,
}
impl GitChild {
    pub fn spawn(mut command: Command) -> Result<Self> {
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self { child })
    }
    pub fn finish(&mut self) -> Result<()> {
        if !self.child.wait()?.success() {
            bail!("Git subprocess failed");
        }
        Ok(())
    }
}
impl Drop for GitChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn scalar(repo: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = command(repo);
    cmd.args(args).stdin(Stdio::null());
    let mut process = GitChild::spawn(cmd)?;
    let mut reader = BufReader::new(process.child.stdout.take().context("Git stdout missing")?);
    let value = record(&mut reader, b'\n', RECORD_LIMIT)?.context("Git scalar missing")?;
    if record(&mut reader, b'\n', RECORD_LIMIT)?.is_some() {
        bail!("Unexpected extra Git scalar output");
    }
    process.finish()?;
    Ok(String::from_utf8(value)?.trim_end_matches('\r').to_owned())
}

#[derive(Debug)]
pub struct Entry {
    pub mode: String,
    pub kind: String,
    pub oid: String,
    pub bytes: u64,
    pub path: String,
}
pub fn entry(bytes: &[u8], oid_len: usize) -> Result<Entry> {
    let tab = bytes
        .iter()
        .position(|byte| *byte == b'\t')
        .context("Tree record has no separator")?;
    let header = std::str::from_utf8(&bytes[..tab])?;
    let columns: Vec<_> = header.split_whitespace().collect();
    if columns.len() != 4 {
        bail!("Invalid tree header");
    }
    let oid = columns[2];
    if oid.len() != oid_len || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("Invalid object ID");
    }
    let path = String::from_utf8(bytes[tab + 1..].to_vec())?;
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("Invalid repository path: {path:?}");
    }
    let bytes = if columns[1] == "commit" && columns[3] == "-" {
        0
    } else {
        columns[3].parse()?
    };
    if bytes > i64::MAX as u64 {
        bail!("Tree object length exceeds ledger range");
    }
    Ok(Entry {
        mode: columns[0].into(),
        kind: columns[1].into(),
        oid: oid.to_lowercase(),
        bytes,
        path,
    })
}

pub struct Batch {
    process: GitChild,
    input: Option<ChildStdin>,
    pub output: BufReader<ChildStdout>,
}
impl Batch {
    pub fn start(repo: &Path) -> Result<Self> {
        let mut cmd = command(repo);
        cmd.arg("cat-file").arg("--batch").stdin(Stdio::piped());
        let mut process = GitChild::spawn(cmd)?;
        let input = process.child.stdin.take();
        let output = BufReader::with_capacity(
            64 * 1024,
            process.child.stdout.take().context("Git stdout missing")?,
        );
        Ok(Self {
            process,
            input,
            output,
        })
    }
    pub fn request(&mut self, oid: &str, bytes: u64) -> Result<()> {
        let input = self.input.as_mut().context("Git batch closed")?;
        writeln!(input, "{oid}")?;
        input.flush()?;
        let header =
            record(&mut self.output, b'\n', RECORD_LIMIT)?.context("Missing batch header")?;
        let header = std::str::from_utf8(&header)?;
        let columns: Vec<_> = header.split_whitespace().collect();
        if columns.len() != 3
            || columns[0] != oid
            || columns[1] != "blob"
            || columns[2].parse::<u64>()? != bytes
        {
            bail!("Invalid/missing blob batch header: {header}");
        }
        Ok(())
    }
    pub fn trailer(&mut self) -> Result<()> {
        let mut byte = [0];
        self.output.read_exact(&mut byte)?;
        if byte[0] != b'\n' {
            bail!("Invalid batch blob trailer");
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<()> {
        self.input.take();
        if record(&mut self.output, b'\n', RECORD_LIMIT)?.is_some() {
            bail!("Unexpected batch output");
        }
        self.process.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn records_are_bounded_and_require_complete_framing() {
        assert!(record(&mut Cursor::new(b"123456\0"), 0, 4).is_err());
        assert!(record(&mut Cursor::new(b"truncated"), 0, 32).is_err());
        let mut reader = BufReader::with_capacity(2, Cursor::new(b"a\0b\0"));
        assert_eq!(record(&mut reader, 0, 8).unwrap().unwrap(), b"a");
        assert_eq!(record(&mut reader, 0, 8).unwrap().unwrap(), b"b");
        assert!(record(&mut reader, 0, 8).unwrap().is_none());
    }
    #[test]
    fn tree_records_preserve_tabs_and_newlines_in_paths() {
        let bytes = format!("100644 blob {} 7\tpath\twith\nnewline.java", "a".repeat(40));
        assert_eq!(
            entry(bytes.as_bytes(), 40).unwrap().path,
            "path\twith\nnewline.java"
        );
        let invalid = format!("100644 blob {} 7\t../escape.java", "a".repeat(40));
        assert!(entry(invalid.as_bytes(), 40).is_err());
    }
}
