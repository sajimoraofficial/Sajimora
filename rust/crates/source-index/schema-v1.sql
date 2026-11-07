PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = FILE;
PRAGMA cache_size = -32768;
PRAGMA mmap_size = 0;
PRAGMA busy_timeout = 5000;

CREATE TABLE builds (
    build_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    indexer_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    discovered_files INTEGER NOT NULL,
    terminal_files INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE source_blobs (
    source_sha256 TEXT PRIMARY KEY,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    physical_lines INTEGER NOT NULL CHECK(physical_lines >= 0),
    state TEXT NOT NULL
);

CREATE TABLE source_chunks (
    source_sha256 TEXT NOT NULL REFERENCES source_blobs(source_sha256),
    chunk_ordinal INTEGER NOT NULL CHECK(chunk_ordinal >= 0),
    bytes BLOB NOT NULL CHECK(length(bytes) <= 1048576),
    PRIMARY KEY(source_sha256, chunk_ordinal)
) WITHOUT ROWID;

CREATE TABLE parse_units (
    unit_id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL REFERENCES source_blobs(source_sha256),
    language TEXT NOT NULL,
    grammar_fingerprint TEXT NOT NULL,
    extractor_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE files (
    build_id TEXT NOT NULL REFERENCES builds(build_id),
    file_id INTEGER NOT NULL CHECK(file_id > 0),
    path TEXT NOT NULL,
    git_object_id TEXT NOT NULL,
    git_byte_length INTEGER NOT NULL CHECK(git_byte_length >= 0),
    language TEXT NOT NULL,
    unit_id TEXT REFERENCES parse_units(unit_id),
    status TEXT NOT NULL,
    PRIMARY KEY(build_id, file_id),
    UNIQUE(build_id, path)
);

CREATE TABLE declarations (
    unit_id TEXT NOT NULL REFERENCES parse_units(unit_id),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    parent_ordinal INTEGER,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
    end_byte INTEGER NOT NULL CHECK(end_byte >= start_byte),
    facts_json TEXT NOT NULL,
    PRIMARY KEY(unit_id, ordinal),
    FOREIGN KEY(unit_id, parent_ordinal) REFERENCES declarations(unit_id, ordinal)
);

CREATE INDEX declaration_lookup ON declarations(qualified_name) WHERE qualified_name IS NOT NULL;

CREATE TABLE references_ir (
    unit_id TEXT NOT NULL REFERENCES parse_units(unit_id),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    scope_ordinal INTEGER,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
    end_byte INTEGER NOT NULL CHECK(end_byte >= start_byte),
    metadata TEXT NOT NULL,
    PRIMARY KEY(unit_id, ordinal)
);

CREATE TABLE resolutions (
    build_id TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    unit_id TEXT NOT NULL,
    reference_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY(build_id, file_id, reference_ordinal),
    FOREIGN KEY(build_id, file_id) REFERENCES files(build_id, file_id),
    FOREIGN KEY(unit_id, reference_ordinal) REFERENCES references_ir(unit_id, ordinal)
);

CREATE TABLE resolution_targets (
    build_id TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    reference_ordinal INTEGER NOT NULL,
    target_file_id INTEGER NOT NULL,
    target_unit_id TEXT NOT NULL,
    target_ordinal INTEGER NOT NULL,
    PRIMARY KEY(build_id, file_id, reference_ordinal, target_file_id, target_ordinal),
    FOREIGN KEY(build_id, file_id) REFERENCES files(build_id, file_id),
    FOREIGN KEY(build_id, target_file_id) REFERENCES files(build_id, file_id),
    FOREIGN KEY(target_unit_id, target_ordinal) REFERENCES declarations(unit_id, ordinal)
);

CREATE TABLE obligations (
    build_id TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    obligation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    metadata TEXT NOT NULL,
    PRIMARY KEY(build_id, file_id, obligation_id),
    UNIQUE(build_id, obligation_id),
    FOREIGN KEY(build_id, file_id) REFERENCES files(build_id, file_id)
);
