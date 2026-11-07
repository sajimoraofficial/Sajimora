export const CURRENT_SCHEMA_VERSION = '1.1.0';
export const CURRENT_ENGINE_VERSION = '0.1.0';

export const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA temp_store = MEMORY;'
];

export const WAL_PRAGMA_STATEMENTS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;'
];

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS type_ir_artifacts (
    ir_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    display TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS language_contract_artifacts (
    contract_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    symbol_id TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    declaration_kind TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_lang_contract_query 
   ON language_contract_artifacts(repo_name, commit_sha, project_key, symbol_id);`,

  `CREATE TABLE IF NOT EXISTS candidate_contract_artifacts (
    candidate_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    target_symbol_id TEXT NOT NULL,
    target_name TEXT NOT NULL,
    target_location TEXT,
    is_deleted INTEGER NOT NULL,
    blocker_id TEXT,
    error_detail TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_cand_contract_query 
   ON candidate_contract_artifacts(repo_name, commit_sha, project_key, target_symbol_id);`,

  `CREATE TABLE IF NOT EXISTS usage_contract_artifacts (
    usage_site_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    usage_role TEXT NOT NULL,
    expected_type_hash TEXT NOT NULL,
    selected_signature_index INTEGER,
    blocker_id TEXT,
    error_detail TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_usage_contract_query 
   ON usage_contract_artifacts(repo_name, commit_sha, project_key, usage_site_id);`,

  `CREATE TABLE IF NOT EXISTS obligation_artifacts (
    obligation_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    parent_sha TEXT NOT NULL,
    candidate_sha TEXT NOT NULL,
    invariant_id TEXT NOT NULL,
    target_symbol_id TEXT NOT NULL,
    target_file TEXT NOT NULL DEFAULT '',
    declaration_line INTEGER NOT NULL DEFAULT 0,
    symbol_name TEXT NOT NULL DEFAULT '',
    target_kind TEXT NOT NULL DEFAULT '',
    classification TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_obligation_query 
   ON obligation_artifacts(repo_name, parent_sha, candidate_sha, target_file, declaration_line, symbol_name);`,

  `CREATE TABLE IF NOT EXISTS identity_mapping_artifacts (
    mapping_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    parent_sha TEXT NOT NULL,
    candidate_sha TEXT NOT NULL,
    old_occurrence_id TEXT NOT NULL,
    new_occurrence_id TEXT,
    mapping_status TEXT NOT NULL,
    confidence TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_identity_mapping_query 
   ON identity_mapping_artifacts(repo_name, parent_sha, candidate_sha, old_occurrence_id);`,

  `CREATE TABLE IF NOT EXISTS completeness_metadata (
    meta_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    target_symbol_id TEXT NOT NULL,
    enumeration_status TEXT NOT NULL,
    resolution_status TEXT NOT NULL,
    is_poisoned INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_completeness_query 
   ON completeness_metadata(repo_name, commit_sha, project_key, target_symbol_id);`,

  `CREATE TABLE IF NOT EXISTS pair_lifecycle_artifacts (
    lifecycle_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    parent_sha TEXT NOT NULL,
    candidate_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    target_symbol_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_pair_lifecycle_query 
   ON pair_lifecycle_artifacts(repo_name, parent_sha, candidate_sha, project_key, target_symbol_id);`,

  `CREATE TABLE IF NOT EXISTS completeness_certificates (
    cert_id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    project_key TEXT NOT NULL,
    closure_kind TEXT NOT NULL,
    is_complete INTEGER NOT NULL,
    failure_count INTEGER NOT NULL,
    cert_hash TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_completeness_cert_query 
   ON completeness_certificates(repo_name, commit_sha, project_key, closure_kind);`
];
