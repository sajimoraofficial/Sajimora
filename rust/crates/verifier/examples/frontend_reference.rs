//! Reference oracle for the source-driven frontend differential harness.
//!
//! Uses the existing Stage 0 lexer/parser/typechecker crates only. It never
//! compiles or executes source; it exposes the reference token stream, parse
//! diagnostics and type diagnostics so the `.sjm` frontend can be compared
//! against the reference implementation.
//!
//! Usage:
//!   cargo run -p verifier --example frontend_reference -- <corpus-dir> <out.json>

use std::fs;
use std::path::{Path, PathBuf};
use std::panic::{catch_unwind, AssertUnwindSafe};

use sajimora_syntax::{tokenize, SyntaxKind};
use serde_json::{json, Value};

fn category(kind: SyntaxKind) -> u32 {
    match kind {
        SyntaxKind::Whitespace => 1,
        SyntaxKind::Newline => 2,
        SyntaxKind::Comment => 3,
        SyntaxKind::IntentPrompt => 4,
        SyntaxKind::KwDefine
        | SyntaxKind::KwChoices
        | SyntaxKind::KwFor
        | SyntaxKind::KwSchema
        | SyntaxKind::KwVersion
        | SyntaxKind::KwIs
        | SyntaxKind::KwDefault
        | SyntaxKind::KwPreviously
        | SyntaxKind::KwIn
        | SyntaxKind::KwUpcast
        | SyntaxKind::KwFrom
        | SyntaxKind::KwAs
        | SyntaxKind::KwSet
        | SyntaxKind::KwTo
        | SyntaxKind::KwDowncast
        | SyntaxKind::KwError
        | SyntaxKind::KwWith
        | SyntaxKind::KwStatus
        | SyntaxKind::KwNative
        | SyntaxKind::KwLibrary
        | SyntaxKind::KwSource
        | SyntaxKind::KwIsolation
        | SyntaxKind::KwRequires
        | SyntaxKind::KwCapabilities
        | SyntaxKind::KwInProcess
        | SyntaxKind::KwSubprocessWorker
        | SyntaxKind::KwService
        | SyntaxKind::KwUsing
        | SyntaxKind::KwReturns
        | SyntaxKind::KwOr
        | SyntaxKind::KwAnd
        | SyntaxKind::KwNot
        | SyntaxKind::KwBody
        | SyntaxKind::KwIf
        | SyntaxKind::KwOtherwise
        | SyntaxKind::KwFail
        | SyntaxKind::KwReturn
        | SyntaxKind::KwHas
        | SyntaxKind::KwRecord
        | SyntaxKind::KwWhere
        | SyntaxKind::KwSave
        | SyntaxKind::KwInto
        | SyntaxKind::KwFind
        | SyntaxKind::KwRun
        | SyntaxKind::KwConcurrently
        | SyntaxKind::KwSend
        | SyntaxKind::KwVia
        | SyntaxKind::KwRead
        | SyntaxKind::KwStart
        | SyntaxKind::KwApplication
        | SyntaxKind::KwSecret
        | SyntaxKind::KwEnv
        | SyntaxKind::KwConnect
        | SyntaxKind::KwDatabase
        | SyntaxKind::KwMailer
        | SyntaxKind::KwAt
        | SyntaxKind::KwPassword
        | SyntaxKind::KwServer
        | SyntaxKind::KwOn
        | SyntaxKind::KwPort
        | SyntaxKind::KwMount
        | SyntaxKind::KwDetach
        | SyntaxKind::KwSelf
        | SyntaxKind::KwTrue
        | SyntaxKind::KwFalse
        | SyntaxKind::KwNull
        | SyntaxKind::KwPublic
        | SyntaxKind::KwPermission
        | SyntaxKind::KwEach
        | SyntaxKind::KwOf
        | SyntaxKind::KwBreak
        | SyntaxKind::KwContinue
        | SyntaxKind::KwGet
        | SyntaxKind::KwPost
        | SyntaxKind::KwPut
        | SyntaxKind::KwPatch
        | SyntaxKind::KwDelete => 5,
        SyntaxKind::Colon => 6,
        SyntaxKind::Comma => 7,
        SyntaxKind::Dot => 8,
        SyntaxKind::LParen => 9,
        SyntaxKind::RParen => 10,
        SyntaxKind::LBracket => 11,
        SyntaxKind::RBracket => 12,
        SyntaxKind::LBrace => 13,
        SyntaxKind::RBrace => 14,
        SyntaxKind::Arrow => 15,
        SyntaxKind::EqEq => 16,
        SyntaxKind::BangEq => 17,
        SyntaxKind::LtEq => 18,
        SyntaxKind::GtEq => 19,
        SyntaxKind::Lt => 20,
        SyntaxKind::Gt => 21,
        SyntaxKind::Plus => 22,
        SyntaxKind::Minus => 23,
        SyntaxKind::Star => 24,
        SyntaxKind::Slash => 25,
        SyntaxKind::Amp => 26,
        SyntaxKind::Ident => 27,
        SyntaxKind::StringLit => 28,
        SyntaxKind::FloatLit => 29,
        SyntaxKind::IntLit => 30,
        SyntaxKind::Indent => 31,
        SyntaxKind::Dedent => 32,
        SyntaxKind::Error => 33,
        _ => 99,
    }
}

fn line_col(source: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut col = 1usize;
    for (i, b) in source.bytes().enumerate() {
        if i >= offset {
            break;
        }
        if b == b'\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

fn parse_error_json(source: &str, err: &sajimora_parser::ParseError) -> Value {
    use sajimora_parser::ParseError;
    let (offset, len, message) = match err {
        ParseError::UnexpectedToken {
            expected,
            found,
            span,
        } => (
            span.offset(),
            span.len(),
            format!("expected {expected}, found {found}"),
        ),
        ParseError::UnclosedBlock { span } => (
            span.offset(),
            span.len(),
            "unclosed indentation block".to_string(),
        ),
        ParseError::General { message, span } => {
            (span.offset(), span.len(), message.clone())
        }
    };
    let (line, col) = line_col(source, offset);
    json!({
        "offset": offset,
        "len": len,
        "line": line,
        "col": col,
        "message": message,
    })
}

fn collect_sources(root: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = match fs::read_dir(root) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_sources(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("sjm") {
            out.push(path);
        }
    }
}

fn file_stem_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn analyze(root: &Path, path: &Path) -> Value {
    let rel = file_stem_rel(root, path);
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "file": rel,
                "read_error": e.to_string(),
                "tokens": [],
                "parse_errors": [],
                "type_errors": [],
                "accepted": false,
            })
        }
    };

    let tokens: Vec<Value> = tokenize(&content)
        .into_iter()
        .map(|t| {
            json!({
                "cat": category(t.kind),
                "start": t.range.start,
                "len": t.range.len(),
                "hex": hex::encode(t.text.as_bytes()),
            })
        })
        .collect();

    let (parse_errors, accepted_parse) = match catch_unwind(AssertUnwindSafe(|| {
        let (_tree, errors) = sajimora_parser::parse(&content);
        errors
    })) {
        Ok(errors) => {
            let accepted = errors.is_empty();
            let values: Vec<Value> = errors
                .iter()
                .map(|e| parse_error_json(&content, e))
                .collect();
            (values, accepted)
        }
        Err(_) => (
            vec![json!({"panic": "reference parser panicked"})],
            false,
        ),
    };

    let (type_errors, accepted_types, typecheck_panicked) = if !accepted_parse {
        (Vec::new(), false, false)
    } else {
        match catch_unwind(AssertUnwindSafe(|| {
            let db = sajimora_hir::Database::default();
            let source_file =
                sajimora_hir::SourceFile::new(&db, rel.clone(), content.clone());
            let table = sajimora_hir::lower_hir_query(&db, source_file);
            sajimora_types::check_types(&table)
        })) {
            Ok(errors) => {
                let accepted = errors.is_empty();
                let values = errors
                    .iter()
                    .map(|e| json!({"debug": format!("{:?}", e)}))
                    .collect::<Vec<_>>();
                (values, accepted, false)
            }
            Err(_) => (Vec::new(), false, true),
        }
    };

    json!({
        "file": rel,
        "tokens": tokens,
        "parse_errors": parse_errors,
        "type_errors": type_errors,
        "accepted_parse": accepted_parse,
        "accepted_types": accepted_types,
        "typecheck_panicked": typecheck_panicked,
        "accepted": accepted_parse && accepted_types,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: frontend_reference <corpus-dir> <out.json>");
        std::process::exit(2);
    }
    let root = Path::new(&args[1]);
    let out_path = Path::new(&args[2]);

    let mut files = Vec::new();
    collect_sources(root, &mut files);

    let mut results = Vec::new();
    for path in &files {
        results.push(analyze(root, path));
    }

    let accepted = results
        .iter()
        .filter(|v| v["accepted"].as_bool().unwrap_or(false))
        .count();
    let document = json!({
        "schema": "sajimora-frontend-reference-v1",
        "corpus": root.to_string_lossy(),
        "file_count": files.len(),
        "accepted_count": accepted,
        "rejected_count": files.len() - accepted,
        "files": results,
    });

    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(&document).expect("serialize reference");
    fs::write(out_path, text).expect("write reference JSON");
}
