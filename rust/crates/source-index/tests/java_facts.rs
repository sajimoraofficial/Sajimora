use source_index::java::extract;

#[test]
fn comments_are_not_modifier_flags_and_enum_members_are_retained() {
    let source = b"enum E { ONE; E(){} void f(){} class Nested { @Deprecated // comment\n private final String field = null; } }";
    let mut facts = Vec::new();
    let (_, error) = extract(source, |fact| {
        facts.push(fact);
        Ok(())
    })
    .unwrap();
    assert!(!error);
    let field = facts.iter().find(|f| f.kind == "FIELD").unwrap();
    assert_eq!(
        field.metadata["flags"],
        serde_json::json!(["private", "final"])
    );
    assert_eq!(
        field.metadata["annotations"],
        serde_json::json!(["Deprecated"])
    );
    assert!(facts.iter().any(|f| f.kind == "METHOD" && f.name == "f"));
    assert!(facts
        .iter()
        .any(|f| f.kind == "CONSTRUCTOR" && f.name == "E"));
}

#[test]
fn lambda_and_anonymous_members_have_separate_owners() {
    let source = b"class A { void run(int outer) { java.util.function.Function<Integer,Integer> f = (Integer inner) -> inner; Runnable r = new Runnable() { public void run() {} }; } }";
    let mut facts = Vec::new();
    let (_, error) = extract(source, |fact| {
        facts.push(fact);
        Ok(())
    })
    .unwrap();
    assert!(!error);
    let inner = facts.iter().find(|f| f.name == "inner").unwrap();
    let owner = facts
        .iter()
        .find(|f| Some(f.ordinal) == inner.parent_ordinal)
        .unwrap();
    assert_eq!(owner.kind, "LAMBDA");
    let anonymous = facts.iter().find(|f| f.kind == "ANONYMOUS_CLASS").unwrap();
    assert!(facts
        .iter()
        .any(|f| f.kind == "METHOD" && f.parent_ordinal == Some(anonymous.ordinal)));
}

#[test]
fn structural_facts_preserve_owners_generics_annotations_and_unicode_offsets() {
    let source="package demo;\r\nimport java.util.List;\r\n@Deprecated public class Box<T extends Number> {\r\n String emoji = \"😀\"; int a, b[];\r\n @Deprecated public <U> List<U> get(final String... names) throws Exception { return null; }\r\n class Nested {}\r\n}\r\nrecord Pair(int left, String right) {}\r\nenum Kind { ONE, TWO }\r\n";
    let mut facts = Vec::new();
    let (count, error) = extract(source.as_bytes(), |fact| {
        facts.push(fact);
        Ok(())
    })
    .unwrap();
    assert!(!error);
    assert_eq!(count, facts.len() as u64);
    let class = facts
        .iter()
        .find(|f| f.qualified_name.as_deref() == Some("demo.Box"))
        .unwrap();
    assert_eq!(class.metadata["type_parameters"], "<T extends Number>");
    let method = facts
        .iter()
        .find(|f| f.kind == "METHOD" && f.name == "get")
        .unwrap();
    assert_eq!(method.parent_ordinal, Some(class.ordinal));
    let parameter = facts
        .iter()
        .find(|f| f.kind == "PARAMETER" && f.name == "names")
        .unwrap();
    assert_eq!(parameter.parent_ordinal, Some(method.ordinal));
    assert!(facts
        .iter()
        .any(|f| f.qualified_name.as_deref() == Some("demo.Box.Nested")));
    let b = facts
        .iter()
        .find(|f| f.kind == "FIELD" && f.name == "b")
        .unwrap();
    assert_eq!(b.metadata["dimensions"], "[]");
    // Astral character precedes b on the same line; byte/UTF-16 columns differ.
    assert!(
        b.metadata["byte_column"].as_u64().unwrap() > b.metadata["utf16_column"].as_u64().unwrap()
    );
    for fact in &facts {
        assert!(source.is_char_boundary(fact.start_byte));
        assert!(source.is_char_boundary(fact.end_byte));
        assert!(fact.end_byte <= source.len());
        if let Some(parent) = fact.parent_ordinal {
            assert!(parent < fact.ordinal);
        }
    }
    assert!(facts
        .iter()
        .any(|f| f.kind == "ENUM_CONSTANT" && f.name == "TWO"));
}

#[test]
fn malformed_sources_keep_recovered_facts_and_error_status() {
    let mut facts = Vec::new();
    let (_, error) = extract(b"class Broken { int field; void method( {", |fact| {
        facts.push(fact);
        Ok(())
    })
    .unwrap();
    assert!(error);
    assert!(!facts.is_empty());
}

#[test]
fn invalid_utf8_and_oversized_fact_text_are_explicit_errors() {
    assert!(extract(&[255], |_| Ok(())).is_err());
    let source = format!("class {} {{}}", "A".repeat(17000));
    assert!(extract(source.as_bytes(), |_| Ok(())).is_err());
}

#[test]
fn file_analysis_status_table_exists_after_database_initialization() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    source_index::java::ensure_schema(&db).unwrap();
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_analysis_status')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        exists,
        "file_analysis_status table must exist after database initialization"
    );
}

#[test]
fn file_analysis_status_recording_lifecycle() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    source_index::java::ensure_schema(&db).unwrap();
    db.execute(
        "INSERT INTO file_analysis_status(file_id, status, reason, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(file_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated_at=excluded.updated_at",
        rusqlite::params!["1", "INDEXED", Option::<String>::None, 123456789i64],
    ).unwrap();

    let (status, reason, updated_at): (String, Option<String>, i64) = db
        .query_row(
            "SELECT status, reason, updated_at FROM file_analysis_status WHERE file_id=?1",
            ["1"],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "INDEXED");
    assert_eq!(reason, None);
    assert_eq!(updated_at, 123456789);

    db.execute(
        "INSERT INTO file_analysis_status(file_id, status, reason, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(file_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated_at=excluded.updated_at",
        rusqlite::params!["1", "BLOCKED", Some("RESOURCE_LIMIT_TIMEOUT"), 123456999i64],
    ).unwrap();

    let (status, reason, updated_at): (String, Option<String>, i64) = db
        .query_row(
            "SELECT status, reason, updated_at FROM file_analysis_status WHERE file_id=?1",
            ["1"],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "BLOCKED");
    assert_eq!(reason.as_deref(), Some("RESOURCE_LIMIT_TIMEOUT"));
    assert_eq!(updated_at, 123456999);
}
