import type { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ProofObligation,
  LanguageContractIR,
  canonicalJson
} from '@sajimora/core';
import { TypeScriptTypeIR } from '../languages/typescript/ir/TypeScriptTypeIR';
import {
  ProviderCandidateContract,
  ProviderHistoricalObligation
} from '../compatibility/Phase4SemanticProvider';
import {
  CURRENT_SCHEMA_VERSION,
  CURRENT_ENGINE_VERSION,
  PRAGMA_STATEMENTS,
  WAL_PRAGMA_STATEMENTS,
  SCHEMA_STATEMENTS
} from './SemanticIndexSchema';

export interface SemanticIndexDatabaseOptions {
  location?: string;
  readOnly?: boolean;
}

export interface CompletenessCertificate {
  readonly repoName: string;
  readonly commitSha: string;
  readonly projectKey: string;
  readonly closureKind: string;
  readonly isComplete: boolean;
  readonly failureCount: number;
  readonly timestamp: number;
}

export interface CompletenessMetadata {
  readonly repoName: string;
  readonly commitSha: string;
  readonly projectKey: string;
  readonly targetSymbolId: string;
  readonly enumerationStatus: string;
  readonly resolutionStatus: string;
  readonly isPoisoned: boolean;
  readonly targetFile?: string;
  readonly discovery?: any;
  readonly sites?: any[];
  readonly lifecycleEvidence?: {
    readonly discoveredHistoricalConsumerIds: readonly string[];
    readonly candidateAddedConsumerIds: readonly string[];
    readonly ambiguousLifecycleConsumerIds: readonly string[];
    readonly mappedHistoricalConsumerIds: ReadonlyArray<readonly [string, string]>;
  };
}

export interface PairLifecycleRecord {
  readonly repoName: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly projectKey: string;
  readonly targetSymbolId: string;
  readonly discoveredHistoricalConsumerIds: readonly string[];
  readonly candidateAddedConsumerIds: readonly string[];
  readonly ambiguousLifecycleConsumerIds: readonly string[];
  readonly mappedHistoricalConsumerIds: ReadonlyArray<readonly [string, string]>;
}

export interface IdentityMappingRecord {
  readonly repoName: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly oldOccurrenceId: string;
  readonly newOccurrenceId?: string;
  readonly mappingStatus: string;
  readonly confidence: string;
}

export class SemanticIndexDatabase {
  private readonly db: DatabaseSync;
  private readonly location: string;
  private inTransaction = false;

  constructor(options?: SemanticIndexDatabaseOptions) {
    this.location = options?.location ?? ':memory:';
    if (this.location !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.location)), { recursive: true });
    }

    let DatabaseSyncClass: typeof import('node:sqlite').DatabaseSync;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      DatabaseSyncClass = require('node:sqlite').DatabaseSync;
    } catch {
      throw new Error('SemanticIndexDatabase requires Node.js >= 22.5.0 with built-in node:sqlite support.');
    }

    this.db = new DatabaseSyncClass(this.location, {
      readOnly: options?.readOnly ?? false,
      enableForeignKeyConstraints: true
    });

    this.initialize();
  }

  public close(): void {
    this.db.close();
  }

  public transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE;');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      this.inTransaction = false;
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      this.inTransaction = false;
      throw err;
    }
  }

  private initialize(): void {
    // 1. Configure PRAGMAs
    for (const pragma of PRAGMA_STATEMENTS) {
      this.db.exec(pragma);
    }
    if (this.location !== ':memory:') {
      for (const pragma of WAL_PRAGMA_STATEMENTS) {
        this.db.exec(pragma);
      }
    }

    // 2. Initialize Schema DDL
    for (const ddl of SCHEMA_STATEMENTS) {
      this.db.exec(ddl);
    }

    // 3. Check / Register Schema Metadata
    const selectVersion = this.db.prepare(
      'SELECT value FROM schema_metadata WHERE key = ?'
    );
    const existingVersion = selectVersion.get('schema_version') as { value: string } | undefined;

    if (!existingVersion) {
      const insertMeta = this.db.prepare(
        'INSERT INTO schema_metadata(key, value) VALUES (?, ?)'
      );
      insertMeta.run('schema_version', CURRENT_SCHEMA_VERSION);
      insertMeta.run('engine_version', CURRENT_ENGINE_VERSION);
      insertMeta.run('initialized_at', new Date().toISOString());
    } else if (existingVersion.value !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `SCHEMA_VERSION_MISMATCH: Database schema version ${existingVersion.value} does not match expected version ${CURRENT_SCHEMA_VERSION}`
      );
    }
  }

  // --- Strict Compiler Isolation Guard ---
  public static assertNoCompilerObjects(obj: unknown, path = 'root'): void {
    if (!obj || typeof obj !== 'object') {
      if (typeof obj === 'function' || typeof obj === 'symbol') {
        throw new Error(`COMPILER_OBJECT_LEAK_DETECTED: Disallowed non-serializable type at ${path}`);
      }
      return;
    }

    const rec = obj as Record<string, unknown>;
    const markers = [
      'getSourceFile',
      'getSourceFiles',
      'getTypeChecker',
      'getSymbol',
      'getTypeAtLocation',
      'getDeclarations',
      'getProperties',
      'getReturnType',
      'flowNode'
    ];
    for (const marker of markers) {
      if (typeof rec[marker] === 'function') {
        throw new Error(`COMPILER_OBJECT_LEAK_DETECTED: Live compiler object detected at ${path} (method ${marker})`);
      }
    }

    for (const [key, value] of Object.entries(rec)) {
      if (value && typeof value === 'object') {
        SemanticIndexDatabase.assertNoCompilerObjects(value, `${path}.${key}`);
      }
    }
  }

  // --- Canonical JSON Serialization & Checksum Verification ---
  private serializeCanonical(value: unknown): string {
    SemanticIndexDatabase.assertNoCompilerObjects(value);
    return canonicalJson(value);
  }

  private deserializeCanonical<T>(rawJson: string, expectedKind?: string): T {
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`STORAGE_RECORD_MALFORMED: Expected object payload, received ${typeof parsed}`);
      }
      return parsed as T;
    } catch (err: any) {
      throw new Error(`STORAGE_INTEGRITY_FAILURE: JSON parse failed for record: ${err.message}`);
    }
  }

  public static stripTypeIROrigins<T>(value: T, visited: Set<any> = new Set()): T {
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      return value.map(item => SemanticIndexDatabase.stripTypeIROrigins(item, visited)) as unknown as T;
    }

    const rec = value as Record<string, any>;
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'origin') {
        continue;
      }
      result[k] = SemanticIndexDatabase.stripTypeIROrigins(v, visited);
    }
    return result as T;
  }

  // ==========================================================================
  // 1. TypeIR Artifacts
  // ==========================================================================
  public putTypeIR(typeIR: TypeScriptTypeIR): void {
    if (!typeIR || !typeIR.irContentHash || !typeIR.kind) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required TypeIR fields (irContentHash, kind)');
    }

    const stripped = SemanticIndexDatabase.stripTypeIROrigins(typeIR);
    const payload = this.serializeCanonical(stripped);
    const existing = this.db.prepare('SELECT payload_json FROM type_ir_artifacts WHERE ir_hash = ?').get(typeIR.irContentHash) as { payload_json: string } | undefined;

    if (existing) {
      const existingObj = JSON.parse(existing.payload_json);
      const newObj = JSON.parse(payload);
      const c1 = canonicalJson(SemanticIndexDatabase.stripTypeIROrigins(existingObj));
      const c2 = canonicalJson(SemanticIndexDatabase.stripTypeIROrigins(newObj));
      if (c1 !== c2) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for TypeIR hash ${typeIR.irContentHash}`);
      }
      return;
    }
    const insert = this.db.prepare(
      'INSERT INTO type_ir_artifacts (ir_hash, kind, display, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run(typeIR.irContentHash, typeIR.kind, typeIR.display ?? '', payload, Date.now());
  }

  public getTypeIR(irContentHash: string): TypeScriptTypeIR | undefined {
    const row = this.db.prepare('SELECT payload_json FROM type_ir_artifacts WHERE ir_hash = ?').get(irContentHash) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const deserialized = this.deserializeCanonical<TypeScriptTypeIR>(row.payload_json);
    if (deserialized.irContentHash !== irContentHash) {
      throw new Error(`STORAGE_INTEGRITY_FAILURE: TypeIR hash mismatch on read. Expected ${irContentHash}, got ${deserialized.irContentHash}`);
    }
    return deserialized;
  }

  // ==========================================================================
  // 2. LanguageContractIR Artifacts
  // ==========================================================================
  public putLanguageContract(
    repoName: string,
    commitSha: string,
    projectKey: string,
    contract: LanguageContractIR<TypeScriptTypeIR>
  ): void {
    if (!contract || !contract.symbolId || !contract.contractType) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required LanguageContractIR fields');
    }

    const contractId = `${repoName}:${commitSha}:${projectKey}:${contract.symbolId}`;
    const payload = this.serializeCanonical(contract);

    // Also persist nested TypeIR
    this.putTypeIR(contract.contractType);

    const existing = this.db.prepare('SELECT payload_json FROM language_contract_artifacts WHERE contract_id = ?').get(contractId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for LanguageContract ${contractId}`);
      }
      return;
    }

    const contractHash = createHash('sha256').update(payload).digest('hex');
    const insert = this.db.prepare(
      `INSERT INTO language_contract_artifacts 
       (contract_id, repo_name, commit_sha, project_key, symbol_id, qualified_name, declaration_kind, contract_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      contractId,
      repoName,
      commitSha,
      projectKey,
      contract.symbolId,
      contract.qualifiedName ?? '',
      contract.declarationKind ?? 'VARIABLE',
      contractHash,
      payload,
      Date.now()
    );
  }

  public getLanguageContract(
    repoName: string,
    commitSha: string,
    projectKey: string,
    symbolId: string
  ): LanguageContractIR<TypeScriptTypeIR> | undefined {
    const contractId = `${repoName}:${commitSha}:${projectKey}:${symbolId}`;
    const row = this.db.prepare('SELECT payload_json, contract_hash FROM language_contract_artifacts WHERE contract_id = ?').get(contractId) as { payload_json: string; contract_hash: string } | undefined;
    if (!row) return undefined;

    const actualHash = createHash('sha256').update(row.payload_json).digest('hex');
    if (actualHash !== row.contract_hash) {
      throw new Error(`STORAGE_INTEGRITY_FAILURE: Checksum mismatch for LanguageContract ${contractId}`);
    }

    return this.deserializeCanonical<LanguageContractIR<TypeScriptTypeIR>>(row.payload_json);
  }

  // ==========================================================================
  // 3. ProviderCandidateContract Artifacts
  // ==========================================================================
  public putCandidateContract(
    repoName: string,
    commitSha: string,
    projectKey: string,
    candidateContract: ProviderCandidateContract
  ): void {
    if (!candidateContract || !candidateContract.targetSymbolId) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required ProviderCandidateContract fields');
    }

    const candidateId = `${repoName}:${commitSha}:${projectKey}:${candidateContract.targetSymbolId}`;
    const payload = this.serializeCanonical(candidateContract);

    if (candidateContract.contractIR) {
      this.putLanguageContract(repoName, commitSha, projectKey, candidateContract.contractIR);
    }

    const existing = this.db.prepare('SELECT payload_json FROM candidate_contract_artifacts WHERE candidate_id = ?').get(candidateId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for CandidateContract ${candidateId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO candidate_contract_artifacts 
       (candidate_id, repo_name, commit_sha, project_key, target_symbol_id, target_name, target_location, is_deleted, blocker_id, error_detail, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      candidateId,
      repoName,
      commitSha,
      projectKey,
      candidateContract.targetSymbolId,
      candidateContract.targetName ?? '',
      candidateContract.declarationLocation?.filePath ?? null,
      candidateContract.isDeleted ? 1 : 0,
      candidateContract.blockerId ?? null,
      candidateContract.errorDetail ?? null,
      payload,
      Date.now()
    );
  }

  public getCandidateContract(
    repoName: string,
    commitSha: string,
    projectKey: string,
    targetSymbolId: string
  ): ProviderCandidateContract | undefined {
    const candidateId = `${repoName}:${commitSha}:${projectKey}:${targetSymbolId}`;
    let row = this.db.prepare('SELECT payload_json FROM candidate_contract_artifacts WHERE candidate_id = ?').get(candidateId) as { payload_json: string } | undefined;
    if (!row) {
      row = this.db.prepare(
        'SELECT payload_json FROM candidate_contract_artifacts WHERE repo_name = ? AND commit_sha = ? AND project_key = ? AND (target_symbol_id = ? OR target_name = ?)'
      ).get(repoName, commitSha, projectKey, targetSymbolId, targetSymbolId) as { payload_json: string } | undefined;
    }
    if (!row) return undefined;

    return this.deserializeCanonical<ProviderCandidateContract>(row.payload_json);
  }

  // ==========================================================================
  // 4. ProviderHistoricalObligation Artifacts
  // ==========================================================================
  public putHistoricalObligation(
    repoName: string,
    commitSha: string,
    projectKey: string,
    histObligation: ProviderHistoricalObligation
  ): void {
    if (!histObligation || !histObligation.usageSiteId) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required ProviderHistoricalObligation fields');
    }

    const payload = this.serializeCanonical(histObligation);
    if (histObligation.specializedContract?.expectedType) {
      this.putTypeIR(histObligation.specializedContract.expectedType);
    }

    const existing = this.db.prepare('SELECT payload_json FROM usage_contract_artifacts WHERE usage_site_id = ?').get(histObligation.usageSiteId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for HistoricalObligation ${histObligation.usageSiteId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO usage_contract_artifacts
       (usage_site_id, repo_name, commit_sha, project_key, occurrence_id, usage_role, expected_type_hash, selected_signature_index, blocker_id, error_detail, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      histObligation.usageSiteId,
      repoName,
      commitSha,
      projectKey,
      histObligation.occurrenceId ?? '',
      histObligation.specializedContract?.usageRole ?? 'CALL_SITE',
      histObligation.specializedContract?.expectedType?.irContentHash ?? '',
      histObligation.selectedSignatureIndex ?? null,
      histObligation.blockerId ?? null,
      histObligation.errorDetail ?? null,
      payload,
      Date.now()
    );
  }

  public getHistoricalObligation(usageSiteId: string): ProviderHistoricalObligation | undefined {
    const row = this.db.prepare('SELECT payload_json FROM usage_contract_artifacts WHERE usage_site_id = ?').get(usageSiteId) as { payload_json: string } | undefined;
    if (!row) return undefined;

    return this.deserializeCanonical<ProviderHistoricalObligation>(row.payload_json);
  }

  // ==========================================================================
  // 5. ProofObligation Artifacts
  // ==========================================================================
  public putObligation(
    repoName: string,
    parentSha: string,
    candidateSha: string,
    obligation: ProofObligation
  ): void {
    if (!obligation || !obligation.invariantId || !obligation.mutatedSymbol) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required ProofObligation fields');
    }

    const targetSymbolId = obligation.mutatedSymbol.persistentSymbolId ?? obligation.mutatedSymbol.symbolId;
    const obligationId = `${repoName}:${parentSha}:${candidateSha}:${obligation.invariantId}:${targetSymbolId}`;
    const payload = this.serializeCanonical(obligation);

    const targetFile = (obligation.mutatedSymbol.declarationLocation?.filePath ?? '').replace(/\\/g, '/');
    const declarationLine = obligation.mutatedSymbol.declarationLocation?.line ?? 0;
    const symbolName = obligation.mutatedSymbol.qualifiedName ?? obligation.mutatedSymbol.symbolId ?? '';
    const targetKind = obligation.mutatedSymbol.kind ?? '';
    const classification = obligation.providerMutation?.classification ?? '';

    const existing = this.db.prepare('SELECT payload_json FROM obligation_artifacts WHERE obligation_id = ?').get(obligationId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for Obligation ${obligationId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO obligation_artifacts
       (obligation_id, repo_name, parent_sha, candidate_sha, invariant_id, target_symbol_id, target_file, declaration_line, symbol_name, target_kind, classification, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      obligationId,
      repoName,
      parentSha,
      candidateSha,
      obligation.invariantId,
      targetSymbolId,
      targetFile,
      declarationLine,
      symbolName,
      targetKind,
      classification,
      payload,
      Date.now()
    );
  }

  public getObligation(
    repoName: string,
    parentSha: string,
    candidateSha: string,
    targetSymbolId: string
  ): ProofObligation | undefined {
    const row = this.db.prepare(
      'SELECT payload_json FROM obligation_artifacts WHERE repo_name = ? AND parent_sha = ? AND candidate_sha = ? AND target_symbol_id = ?'
    ).get(repoName, parentSha, candidateSha, targetSymbolId) as { payload_json: string } | undefined;
    if (!row) return undefined;

    return this.deserializeCanonical<ProofObligation>(row.payload_json);
  }

  public static compareObligations(a: ProofObligation, b: ProofObligation): number {
    const fileA = (a.mutatedSymbol?.declarationLocation?.filePath ?? '').replace(/\\/g, '/');
    const fileB = (b.mutatedSymbol?.declarationLocation?.filePath ?? '').replace(/\\/g, '/');
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;

    const lineA = a.mutatedSymbol?.declarationLocation?.line ?? 0;
    const lineB = b.mutatedSymbol?.declarationLocation?.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;

    const colA = 0;
    const colB = 0;
    if (colA !== colB) return colA - colB;

    const nameA = a.mutatedSymbol?.qualifiedName ?? a.mutatedSymbol?.symbolId ?? '';
    const nameB = b.mutatedSymbol?.qualifiedName ?? b.mutatedSymbol?.symbolId ?? '';
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;

    const kindA = a.mutatedSymbol?.kind ?? '';
    const kindB = b.mutatedSymbol?.kind ?? '';
    if (kindA !== kindB) return kindA < kindB ? -1 : 1;

    const classA = a.providerMutation?.classification ?? '';
    const classB = b.providerMutation?.classification ?? '';
    if (classA !== classB) return classA < classB ? -1 : 1;

    // Collision-safe deterministic tie-breaker
    const invA = a.invariantId ?? '';
    const invB = b.invariantId ?? '';
    return invA < invB ? -1 : invA > invB ? 1 : 0;
  }

  public getObligations(
    repoName: string,
    parentSha: string,
    candidateSha: string
  ): ProofObligation[] {
    const rows = this.db.prepare(
      `SELECT payload_json FROM obligation_artifacts 
       WHERE repo_name = ? AND parent_sha = ? AND candidate_sha = ? 
       ORDER BY target_file ASC, declaration_line ASC, symbol_name ASC, target_kind ASC, classification ASC, obligation_id ASC`
    ).all(repoName, parentSha, candidateSha) as Array<{ payload_json: string }>;
    const list = rows.map(r => this.deserializeCanonical<ProofObligation>(r.payload_json));
    return list.sort(SemanticIndexDatabase.compareObligations);
  }

  // ==========================================================================
  // 6. Identity Mapping Artifacts
  // ==========================================================================
  public putIdentityMapping(mapping: IdentityMappingRecord): void {
    if (!mapping || !mapping.oldOccurrenceId || !mapping.mappingStatus) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required IdentityMapping fields');
    }

    const mappingId = `${mapping.repoName}:${mapping.parentSha}:${mapping.candidateSha}:${mapping.oldOccurrenceId}`;
    const payload = this.serializeCanonical(mapping);

    const existing = this.db.prepare('SELECT payload_json FROM identity_mapping_artifacts WHERE mapping_id = ?').get(mappingId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for IdentityMapping ${mappingId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO identity_mapping_artifacts
       (mapping_id, repo_name, parent_sha, candidate_sha, old_occurrence_id, new_occurrence_id, mapping_status, confidence, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      mappingId,
      mapping.repoName,
      mapping.parentSha,
      mapping.candidateSha,
      mapping.oldOccurrenceId,
      mapping.newOccurrenceId ?? null,
      mapping.mappingStatus,
      mapping.confidence,
      payload,
      Date.now()
    );
  }

  public getIdentityMapping(
    repoName: string,
    parentSha: string,
    candidateSha: string,
    oldOccurrenceId: string
  ): IdentityMappingRecord | undefined {
    const mappingId = `${repoName}:${parentSha}:${candidateSha}:${oldOccurrenceId}`;
    const row = this.db.prepare('SELECT payload_json FROM identity_mapping_artifacts WHERE mapping_id = ?').get(mappingId) as { payload_json: string } | undefined;
    if (!row) return undefined;

    return this.deserializeCanonical<IdentityMappingRecord>(row.payload_json);
  }

  public getIdentityMappings(
    repoName: string,
    parentSha: string,
    candidateSha: string
  ): IdentityMappingRecord[] {
    const rows = this.db.prepare(
      'SELECT payload_json FROM identity_mapping_artifacts WHERE repo_name = ? AND parent_sha = ? AND candidate_sha = ? ORDER BY created_at ASC, mapping_id ASC'
    ).all(repoName, parentSha, candidateSha) as Array<{ payload_json: string }>;
    return rows.map(r => this.deserializeCanonical<IdentityMappingRecord>(r.payload_json));
  }

  // ==========================================================================
  // 7. Authoritative Completeness Certificates
  // ==========================================================================
  public putCompletenessCertificate(cert: CompletenessCertificate): void {
    if (!cert || !cert.repoName || !cert.commitSha || !cert.closureKind) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required CompletenessCertificate fields');
    }

    const certId = `${cert.repoName}:${cert.commitSha}:${cert.projectKey}:${cert.closureKind}`;
    const payload = this.serializeCanonical(cert);
    const certHash = createHash('sha256').update(payload).digest('hex');

    const existing = this.db.prepare('SELECT payload_json FROM completeness_certificates WHERE cert_id = ?').get(certId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for CompletenessCertificate ${certId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO completeness_certificates
       (cert_id, repo_name, commit_sha, project_key, closure_kind, is_complete, failure_count, cert_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      certId,
      cert.repoName,
      cert.commitSha,
      cert.projectKey,
      cert.closureKind,
      cert.isComplete ? 1 : 0,
      cert.failureCount,
      certHash,
      payload,
      Date.now()
    );
  }

  public getCompletenessCertificate(
    repoName: string,
    commitSha: string,
    projectKey: string,
    closureKind: string
  ): CompletenessCertificate | undefined {
    const certId = `${repoName}:${commitSha}:${projectKey}:${closureKind}`;
    const row = this.db.prepare(
      'SELECT is_complete, failure_count, cert_hash, payload_json FROM completeness_certificates WHERE cert_id = ?'
    ).get(certId) as { is_complete: number; failure_count: number; cert_hash: string; payload_json: string } | undefined;
    if (!row) return undefined;

    // Cryptographic Checksum Integrity Gate (Corruption Detection)
    if (row.cert_hash) {
      const actualHash = createHash('sha256').update(row.payload_json).digest('hex');
      if (actualHash !== row.cert_hash) {
        throw new Error(`STORAGE_INTEGRITY_FAILURE: Certificate checksum mismatch for ${certId}. Expected ${row.cert_hash}, calculated ${actualHash}`);
      }
    }

    // Dual Invariant Consistency Gate (Adversarial Relational Tampering Detection)
    const cert = this.deserializeCanonical<CompletenessCertificate>(row.payload_json);
    const expectedIsComplete = cert.isComplete ? 1 : 0;
    if (row.is_complete !== expectedIsComplete || row.failure_count !== cert.failureCount) {
      throw new Error(
        `STORAGE_INTEGRITY_FAILURE: Certificate relational columns desynchronized from payload for ${certId}. SQL: (is_complete=${row.is_complete}, failures=${row.failure_count}), Payload: (is_complete=${expectedIsComplete}, failures=${cert.failureCount})`
      );
    }

    return cert;
  }

  public assertCompleteness(
    repoName: string,
    commitSha: string,
    projectKey: string,
    closureKind: string
  ): boolean {
    const cert = this.getCompletenessCertificate(repoName, commitSha, projectKey, closureKind);
    if (!cert) {
      throw new Error(
        `COMPLETENESS_CERTIFICATE_MISSING: Authoritative certificate for ${closureKind} not found on commit ${commitSha}. Missing records cannot be interpreted as proof of absence.`
      );
    }
    if (!cert.isComplete) {
      throw new Error(
        `COMPLETENESS_CERTIFICATE_INCOMPLETE: Closure ${closureKind} on commit ${commitSha} was marked incomplete (${cert.failureCount} failures recorded).`
      );
    }
    return true;
  }

  // ==========================================================================
  // 8. Completeness Metadata Artifacts (Pure Parent Discovery)
  // ==========================================================================
  public putCompletenessMetadata(metadata: CompletenessMetadata): void {
    if (!metadata || !metadata.repoName || !metadata.commitSha || !metadata.targetSymbolId) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required CompletenessMetadata fields');
    }

    const projectKey = metadata.projectKey ?? 'root';
    const metaId = `${metadata.repoName}:${metadata.commitSha}:${projectKey}:${metadata.targetSymbolId}`;
    const payload = this.serializeCanonical(metadata);

    const existing = this.db.prepare('SELECT payload_json FROM completeness_metadata WHERE meta_id = ?').get(metaId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for CompletenessMetadata ${metaId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO completeness_metadata
       (meta_id, repo_name, commit_sha, project_key, target_symbol_id, enumeration_status, resolution_status, is_poisoned, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      metaId,
      metadata.repoName,
      metadata.commitSha,
      projectKey,
      metadata.targetSymbolId,
      metadata.enumerationStatus,
      metadata.resolutionStatus,
      metadata.isPoisoned ? 1 : 0,
      payload,
      Date.now()
    );
  }

  public getCompletenessMetadata(
    repoName: string,
    commitSha: string,
    projectKey: string,
    targetSymbolId: string
  ): CompletenessMetadata | undefined {
    const metaId = `${repoName}:${commitSha}:${projectKey}:${targetSymbolId}`;
    const row = this.db.prepare('SELECT payload_json FROM completeness_metadata WHERE meta_id = ?').get(metaId) as { payload_json: string } | undefined;
    if (!row) return undefined;

    return this.deserializeCanonical<CompletenessMetadata>(row.payload_json);
  }

  // ==========================================================================
  // 9. Pair Lifecycle Artifacts (Pair-Scoped Lifecycle Evidence)
  // ==========================================================================
  public putPairLifecycle(record: PairLifecycleRecord): void {
    if (!record || !record.repoName || !record.parentSha || !record.candidateSha || !record.targetSymbolId) {
      throw new Error('STORAGE_RECORD_MALFORMED: Missing required PairLifecycleRecord fields');
    }

    const projectKey = record.projectKey ?? 'root';
    const lifecycleId = `${record.repoName}:${record.parentSha}:${record.candidateSha}:${projectKey}:${record.targetSymbolId}`;
    const payload = this.serializeCanonical(record);

    const existing = this.db.prepare('SELECT payload_json FROM pair_lifecycle_artifacts WHERE lifecycle_id = ?').get(lifecycleId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== payload) {
        throw new Error(`IMMUTABLE_ARTIFACT_CONFLICT: Conflicting payload for PairLifecycle ${lifecycleId}`);
      }
      return;
    }

    const insert = this.db.prepare(
      `INSERT INTO pair_lifecycle_artifacts
       (lifecycle_id, repo_name, parent_sha, candidate_sha, project_key, target_symbol_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      lifecycleId,
      record.repoName,
      record.parentSha,
      record.candidateSha,
      projectKey,
      record.targetSymbolId,
      payload,
      Date.now()
    );
  }

  public getPairLifecycle(
    repoName: string,
    parentSha: string,
    candidateSha: string,
    projectKey: string,
    targetSymbolId: string
  ): PairLifecycleRecord | undefined {
    const lifecycleId = `${repoName}:${parentSha}:${candidateSha}:${projectKey}:${targetSymbolId}`;
    const row = this.db.prepare('SELECT payload_json FROM pair_lifecycle_artifacts WHERE lifecycle_id = ?').get(lifecycleId) as { payload_json: string } | undefined;
    if (!row) return undefined;

    return this.deserializeCanonical<PairLifecycleRecord>(row.payload_json);
  }
}
