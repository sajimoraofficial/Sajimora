import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '@sajimora/core';
import {
  CommitIndexIdentity,
  GenerationIdentity,
  ProjectIndexIdentity,
  assertIdentityComplete,
  hashCanonical
} from './IndexIdentity';
import { DependencyLookupReceipt } from './DependencyLookupReceipt';

export type GenerationStatus = 'BUILDING' | 'VALIDATING' | 'PUBLISHED' | 'FAILED' | 'QUARANTINED';

export interface IndexedArtifact<T = unknown> {
  readonly artifactHash: string;
  readonly kind: string;
  readonly payload: T;
}

export interface ProjectManifest {
  readonly identity: ProjectIndexIdentity;
  readonly generationId: string;
  readonly projectManifestHash: string;
  readonly rootFilesHash: string;
  readonly includedFilesHash: string;
  readonly projectReferencesHash: string;
  readonly moduleGraphHash: string;
  readonly declarationRootHash: string;
  readonly consumerRootHash: string;
  readonly typeIRRootHash: string;
  readonly diagnosticRootHash: string;
  readonly certificateHash: string;
  readonly artifactHashes: readonly string[];
  readonly artifactCounts: Readonly<Record<string, number>>;
}

export interface CommitManifest {
  readonly identity: CommitIndexIdentity;
  readonly generationId: string;
  readonly manifestHash: string;
  readonly generationContentHash: string;
  readonly projectManifestHashes: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly certificateHashes: readonly string[];
  readonly dependencyLookupReceipt?: DependencyLookupReceipt;
}

export interface BoundCompletenessCertificate {
  readonly generationId: string;
  readonly generationContentHash: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly projectId: string;
  readonly includedFilesHash: string;
  readonly projectReferencesHash: string;
  readonly moduleGraphHash: string;
  readonly declarationRootHash: string;
  readonly consumerRootHash: string;
  readonly diagnosticRootHash: string;
  readonly supportedRelationshipClasses: readonly string[];
  readonly unsupportedRelationshipClasses: readonly string[];
  readonly blockers: readonly string[];
  readonly isComplete: boolean;
  readonly certificateHash: string;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS v2_generations (
    generation_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
    identity_json TEXT NOT NULL, status TEXT NOT NULL, failure_json TEXT,
    created_at INTEGER NOT NULL, published_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS v2_artifacts (
    artifact_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS v2_generation_artifacts (
    generation_id TEXT NOT NULL, project_id TEXT NOT NULL, semantic_id TEXT NOT NULL,
    artifact_hash TEXT NOT NULL, artifact_kind TEXT NOT NULL,
    PRIMARY KEY (generation_id, project_id, artifact_kind, semantic_id),
    FOREIGN KEY (generation_id) REFERENCES v2_generations(generation_id),
    FOREIGN KEY (artifact_hash) REFERENCES v2_artifacts(artifact_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS v2_project_manifests (
    project_manifest_hash TEXT NOT NULL, generation_id TEXT NOT NULL, project_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY (generation_id, project_id),
    FOREIGN KEY (generation_id) REFERENCES v2_generations(generation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS v2_certificates (
    certificate_hash TEXT NOT NULL, generation_id TEXT NOT NULL, project_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY (generation_id, project_id),
    FOREIGN KEY (generation_id) REFERENCES v2_generations(generation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS v2_commit_manifests (
    manifest_hash TEXT NOT NULL, generation_id TEXT NOT NULL PRIMARY KEY, repository_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL, payload_json TEXT NOT NULL,
    FOREIGN KEY (generation_id) REFERENCES v2_generations(generation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS v2_published_generations (
    repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, schema_version TEXT NOT NULL,
    generation_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
    PRIMARY KEY (repository_id, commit_sha, schema_version),
    FOREIGN KEY (generation_id) REFERENCES v2_generations(generation_id),
    FOREIGN KEY (generation_id) REFERENCES v2_commit_manifests(generation_id)
  )`
];

export class GenerationIndexDatabase {
  private readonly db: DatabaseSync;
  private readonly verifiedManifests = new Map<string, CommitManifest>();
  private verifiedRevision = '';

  public constructor(location = ':memory:', readOnly = false) {
    if (location !== ':memory:' && !readOnly) fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
    let DatabaseSyncClass: typeof import('node:sqlite').DatabaseSync;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      DatabaseSyncClass = require('node:sqlite').DatabaseSync;
    } catch {
      throw new Error('GenerationIndexDatabase requires Node.js >= 22.5.0 with built-in node:sqlite support.');
    }
    this.db = new DatabaseSyncClass(location, { readOnly, enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA foreign_keys = ON');
    if (!readOnly) for (const ddl of DDL) this.db.exec(ddl);
  }

  public close(): void { this.db.close(); }

  public beginGeneration(identity: GenerationIdentity): void {
    assertIdentityComplete(identity);
    this.db.prepare(
      `INSERT INTO v2_generations
       (generation_id, repository_id, commit_sha, identity_json, status, created_at)
       VALUES (?, ?, ?, ?, 'BUILDING', ?)`
    ).run(identity.generationId, identity.repositoryId, identity.commitSha, canonicalJson(identity), Date.now());
  }

  public putArtifact<T>(
    generationId: string,
    projectId: string,
    semanticId: string,
    kind: string,
    payload: T
  ): string {
    this.assertGenerationWritable(generationId);
    const artifactHash = hashCanonical(`SAJIMORA_ARTIFACT_${kind}_V1`, payload);
    const payloadJson = canonicalJson(payload);
    const existing = this.db.prepare('SELECT kind, payload_json FROM v2_artifacts WHERE artifact_hash = ?')
      .get(artifactHash) as { kind: string; payload_json: string } | undefined;
    if (existing && (existing.kind !== kind || existing.payload_json !== payloadJson)) {
      throw new Error(`INDEX_ARTIFACT_HASH_CONFLICT: ${artifactHash}`);
    }
    if (!existing) this.db.prepare('INSERT INTO v2_artifacts VALUES (?, ?, ?)').run(artifactHash, kind, payloadJson);
    this.db.prepare(
      `INSERT INTO v2_generation_artifacts
       (generation_id, project_id, semantic_id, artifact_hash, artifact_kind) VALUES (?, ?, ?, ?, ?)`
    ).run(generationId, projectId, semanticId, artifactHash, kind);
    return artifactHash;
  }

  public putProjectManifest(manifest: ProjectManifest): void {
    this.assertGenerationWritable(manifest.generationId);
    const expected = calculateProjectManifestHash(manifest);
    if (manifest.projectManifestHash !== expected) throw new Error('INDEX_PROJECT_MANIFEST_HASH_INVALID');
    this.db.prepare('INSERT INTO v2_project_manifests VALUES (?, ?, ?, ?)')
      .run(manifest.projectManifestHash, manifest.generationId, manifest.identity.projectId, canonicalJson(manifest));
  }

  public putCertificate(certificate: BoundCompletenessCertificate): void {
    this.assertGenerationWritable(certificate.generationId);
    const expected = calculateCertificateHash(certificate);
    if (certificate.certificateHash !== expected) throw new Error('INDEX_CERTIFICATE_HASH_INVALID');
    this.db.prepare('INSERT INTO v2_certificates VALUES (?, ?, ?, ?)')
      .run(certificate.certificateHash, certificate.generationId, certificate.projectId, canonicalJson(certificate));
  }

  public publish(manifest: CommitManifest): void {
    const expected = calculateCommitManifestHash(manifest);
    if (manifest.manifestHash !== expected) throw new Error('INDEX_COMMIT_MANIFEST_HASH_INVALID');
    if (manifest.generationContentHash !== calculateGenerationContentHash(manifest.identity, manifest.artifactHashes)) {
      throw new Error('INDEX_GENERATION_CONTENT_HASH_INVALID');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const generation = this.db.prepare('SELECT status, identity_json FROM v2_generations WHERE generation_id = ?')
        .get(manifest.generationId) as { status: GenerationStatus; identity_json: string } | undefined;
      if (!generation || generation.status !== 'BUILDING') throw new Error('INDEX_GENERATION_NOT_BUILDING');
      if (canonicalJson(JSON.parse(generation.identity_json)) !== canonicalJson({ ...manifest.identity, generationId: manifest.generationId })) {
        throw new Error('INDEX_GENERATION_IDENTITY_MISMATCH');
      }
      this.db.prepare("UPDATE v2_generations SET status = 'VALIDATING' WHERE generation_id = ?").run(manifest.generationId);
      this.verifyManifestMembers(manifest);
      this.db.prepare('INSERT INTO v2_commit_manifests VALUES (?, ?, ?, ?, ?)')
        .run(manifest.manifestHash, manifest.generationId, manifest.identity.repositoryId, manifest.identity.commitSha, canonicalJson(manifest));
      this.db.prepare(`INSERT INTO v2_published_generations VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository_id, commit_sha, schema_version) DO UPDATE SET
          generation_id = excluded.generation_id, manifest_hash = excluded.manifest_hash`)
        .run(manifest.identity.repositoryId, manifest.identity.commitSha, manifest.identity.schemaVersion, manifest.generationId, manifest.manifestHash);
      this.db.prepare("UPDATE v2_generations SET status = 'PUBLISHED', published_at = ? WHERE generation_id = ?")
        .run(Date.now(), manifest.generationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public getPublishedManifest(repositoryId: string, commitSha: string, schemaVersion: string): CommitManifest | undefined {
    // total_changes observes writes through this connection (including callers
    // using the raw SQLite handle); data_version observes other connections.
    // A cached validation is only reusable while both counters are unchanged.
    const revision = this.databaseRevision();
    if (revision !== this.verifiedRevision) {
      this.verifiedManifests.clear();
      this.verifiedRevision = revision;
    }
    const key = canonicalJson([repositoryId, commitSha, schemaVersion]);
    const cached = this.verifiedManifests.get(key);
    if (cached) return structuredClone(cached);
    const row = this.db.prepare(
      `SELECT m.payload_json FROM v2_published_generations p
       JOIN v2_commit_manifests m ON m.generation_id = p.generation_id
       WHERE p.repository_id = ? AND p.commit_sha = ? AND p.schema_version = ?`
    ).get(repositoryId, commitSha, schemaVersion) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const manifest = JSON.parse(row.payload_json) as CommitManifest;
    if (calculateCommitManifestHash(manifest) !== manifest.manifestHash) throw new Error('INDEX_CORRUPT_COMMIT_MANIFEST');
    this.verifyManifestMembers(manifest);
    this.verifiedManifests.set(key, manifest);
    return structuredClone(manifest);
  }

  private databaseRevision(): string {
    const own = this.db.prepare('SELECT total_changes() AS count').get() as { count: number | bigint };
    const external = this.db.prepare('PRAGMA data_version').get() as { data_version: number | bigint };
    return `${own.count}:${external.data_version}`;
  }

  public getArtifacts<T>(generationId: string, projectId: string, kind: string): Array<{ semanticId: string; artifactHash: string; payload: T }> {
    const rows = this.db.prepare(
      `SELECT ga.semantic_id, ga.artifact_hash, a.payload_json, a.kind
       FROM v2_generation_artifacts ga JOIN v2_artifacts a ON a.artifact_hash = ga.artifact_hash
       WHERE ga.generation_id = ? AND ga.project_id = ? AND ga.artifact_kind = ?
       ORDER BY ga.semantic_id, ga.artifact_hash`
    ).all(generationId, projectId, kind) as Array<{ semantic_id: string; artifact_hash: string; payload_json: string; kind: string }>;
    return rows.map(row => {
      const payload = JSON.parse(row.payload_json) as T;
      if (hashCanonical(`SAJIMORA_ARTIFACT_${row.kind}_V1`, payload) !== row.artifact_hash) {
        throw new Error(`INDEX_CORRUPT_ARTIFACT: ${row.artifact_hash}`);
      }
      return { semanticId: row.semantic_id, artifactHash: row.artifact_hash, payload };
    });
  }

  public getProjectManifests(generationId: string): ProjectManifest[] {
    const rows = this.db.prepare(
      'SELECT payload_json FROM v2_project_manifests WHERE generation_id = ? ORDER BY project_id, project_manifest_hash'
    ).all(generationId) as Array<{ payload_json: string }>;
    return rows.map(row => {
      const manifest = JSON.parse(row.payload_json) as ProjectManifest;
      if (calculateProjectManifestHash(manifest) !== manifest.projectManifestHash) throw new Error('INDEX_CORRUPT_PROJECT_MANIFEST');
      return manifest;
    });
  }

  public getCertificate(generationId: string, projectId: string): BoundCompletenessCertificate | undefined {
    const row = this.db.prepare(
      'SELECT payload_json FROM v2_certificates WHERE generation_id = ? AND project_id = ?'
    ).get(generationId, projectId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const certificate = JSON.parse(row.payload_json) as BoundCompletenessCertificate;
    if (calculateCertificateHash(certificate) !== certificate.certificateHash) throw new Error('INDEX_CORRUPT_CERTIFICATE');
    return certificate;
  }

  private verifyManifestMembers(manifest: CommitManifest): void {
    assertIdentityComplete(manifest.identity);
    if (manifest.identity.externalDependencyFingerprint !== 'NONE' &&
      (!manifest.dependencyLookupReceipt ||
        manifest.dependencyLookupReceipt.fingerprint !== manifest.identity.externalDependencyFingerprint ||
        manifest.dependencyLookupReceipt.fingerprint !== hashCanonical('SAJIMORA_DEPENDENCY_LOOKUPS_V1', {
          routes: manifest.dependencyLookupReceipt.routes, probes: manifest.dependencyLookupReceipt.probes
        }))) {
      throw new Error('INDEX_DEPENDENCY_LOOKUP_RECEIPT_MISSING');
    }
    if (manifest.generationContentHash !== calculateGenerationContentHash(manifest.identity, manifest.artifactHashes)) {
      throw new Error('INDEX_GENERATION_CONTENT_HASH_INVALID');
    }
    const same = (actual: readonly string[], claimed: readonly string[]) =>
      canonicalJson([...actual].sort()) === canonicalJson([...claimed].sort());
    const generation = this.db.prepare('SELECT status, identity_json FROM v2_generations WHERE generation_id = ?')
      .get(manifest.generationId) as { status: GenerationStatus; identity_json: string } | undefined;
    if (!generation || !['VALIDATING', 'PUBLISHED'].includes(generation.status)) {
      throw new Error('INDEX_GENERATION_NOT_VALIDATED');
    }
    if (canonicalJson(JSON.parse(generation.identity_json)) !==
      canonicalJson({ ...manifest.identity, generationId: manifest.generationId })) {
      throw new Error('INDEX_GENERATION_IDENTITY_MISMATCH');
    }
    const projectRows = this.db.prepare('SELECT project_manifest_hash FROM v2_project_manifests WHERE generation_id = ?')
      .all(manifest.generationId) as Array<{ project_manifest_hash: string }>;
    if (!projectRows.length || !same(projectRows.map(row => row.project_manifest_hash), manifest.projectManifestHashes)) {
      throw new Error('INDEX_PROJECT_MANIFEST_SET_INCOMPLETE');
    }
    const artifactRows = this.db.prepare(`SELECT ga.project_id, ga.artifact_hash, ga.artifact_kind,
      a.kind, a.payload_json FROM v2_generation_artifacts ga
      JOIN v2_artifacts a ON a.artifact_hash = ga.artifact_hash WHERE ga.generation_id = ?`)
      .all(manifest.generationId) as Array<{ project_id: string; artifact_hash: string;
        artifact_kind: string; kind: string; payload_json: string }>;
    if (!same([...new Set(artifactRows.map(row => row.artifact_hash))], manifest.artifactHashes)) {
      throw new Error('INDEX_ARTIFACT_SET_INCOMPLETE');
    }
    for (const row of artifactRows) {
      if (row.kind !== row.artifact_kind ||
        hashCanonical(`SAJIMORA_ARTIFACT_${row.kind}_V1`, JSON.parse(row.payload_json)) !== row.artifact_hash) {
        throw new Error(`INDEX_CORRUPT_ARTIFACT: ${row.artifact_hash}`);
      }
    }
    // Group once: a generation can contain many projects and many artifacts.
    // Filtering the full artifact set for every project makes validation
    // quadratic and turns a warm manifest lookup into a large scan loop.
    const artifactsByProject = new Map<string, typeof artifactRows>();
    for (const row of artifactRows) {
      let rows = artifactsByProject.get(row.project_id);
      if (!rows) {
        rows = [];
        artifactsByProject.set(row.project_id, rows);
      }
      rows.push(row);
    }
    const certificateRows = this.db.prepare('SELECT certificate_hash FROM v2_certificates WHERE generation_id = ?')
      .all(manifest.generationId) as Array<{ certificate_hash: string }>;
    if (certificateRows.length !== projectRows.length ||
      !same(certificateRows.map(row => row.certificate_hash), manifest.certificateHashes)) {
      throw new Error('INDEX_CERTIFICATE_SET_INCOMPLETE');
    }
    const projectIds = new Set<string>();
    for (const hash of manifest.projectManifestHashes) {
      const row = this.db.prepare('SELECT payload_json FROM v2_project_manifests WHERE project_manifest_hash = ? AND generation_id = ?')
        .get(hash, manifest.generationId) as { payload_json: string } | undefined;
      if (!row) throw new Error(`INDEX_PROJECT_MANIFEST_MISSING: ${hash}`);
      const project = JSON.parse(row.payload_json) as ProjectManifest;
      if (calculateProjectManifestHash(project) !== hash) throw new Error(`INDEX_PROJECT_MANIFEST_CORRUPT: ${hash}`);
      if (project.generationId !== manifest.generationId ||
        project.identity.projectId === '' ||
        canonicalJson((({ projectId: _projectId, projectContextFingerprint: _context, ...commit }) => commit)(project.identity)) !==
          canonicalJson(manifest.identity)) {
        throw new Error(`INDEX_PROJECT_IDENTITY_MISMATCH: ${hash}`);
      }
      if (projectIds.has(project.identity.projectId)) throw new Error(`INDEX_DUPLICATE_PROJECT: ${project.identity.projectId}`);
      projectIds.add(project.identity.projectId);
      const rows = artifactsByProject.get(project.identity.projectId) ?? [];
      if (!same([...new Set(rows.map(artifact => artifact.artifact_hash))], project.artifactHashes)) {
        throw new Error(`INDEX_PROJECT_ARTIFACT_SET_INCOMPLETE: ${hash}`);
      }
      const counts: Record<string, number> = {};
      for (const artifact of rows) counts[artifact.artifact_kind] = (counts[artifact.artifact_kind] ?? 0) + 1;
      if (canonicalJson(counts) !== canonicalJson(project.artifactCounts)) {
        throw new Error(`INDEX_PROJECT_ARTIFACT_COUNTS_INVALID: ${hash}`);
      }
      const certificate = this.getCertificate(manifest.generationId, project.identity.projectId);
      if (!certificate || certificate.certificateHash !== project.certificateHash ||
        certificate.generationContentHash !== manifest.generationContentHash ||
        certificate.repositoryId !== manifest.identity.repositoryId ||
        certificate.commitSha !== manifest.identity.commitSha ||
        certificate.includedFilesHash !== project.includedFilesHash ||
        certificate.projectReferencesHash !== project.projectReferencesHash ||
        certificate.moduleGraphHash !== project.moduleGraphHash ||
        certificate.declarationRootHash !== project.declarationRootHash ||
        certificate.consumerRootHash !== project.consumerRootHash ||
        certificate.diagnosticRootHash !== project.diagnosticRootHash ||
        !certificate.isComplete || certificate.blockers.length || certificate.unsupportedRelationshipClasses.length) {
        throw new Error(`INDEX_PROJECT_CERTIFICATE_MISMATCH: ${hash}`);
      }
    }
    if ([...artifactsByProject.keys()].some(projectId => !projectIds.has(projectId))) {
      throw new Error('INDEX_ARTIFACT_PROJECT_UNCLAIMED');
    }
    for (const hash of manifest.certificateHashes) {
      const row = this.db.prepare('SELECT payload_json FROM v2_certificates WHERE certificate_hash = ? AND generation_id = ?')
        .get(hash, manifest.generationId) as { payload_json: string } | undefined;
      if (!row) throw new Error(`INDEX_CERTIFICATE_MISSING: ${hash}`);
      const cert = JSON.parse(row.payload_json) as BoundCompletenessCertificate;
      if (!cert.isComplete || cert.generationContentHash !== manifest.generationContentHash || calculateCertificateHash(cert) !== hash) {
        throw new Error(`INDEX_CERTIFICATE_INVALID: ${hash}`);
      }
    }
  }

  private assertGenerationWritable(generationId: string): void {
    const row = this.db.prepare('SELECT status FROM v2_generations WHERE generation_id = ?')
      .get(generationId) as { status: GenerationStatus } | undefined;
    if (!row || row.status !== 'BUILDING') throw new Error(`INDEX_GENERATION_IMMUTABLE: ${generationId}`);
  }
}

export function calculateProjectManifestHash(manifest: Omit<ProjectManifest, 'projectManifestHash'> | ProjectManifest): string {
  const { projectManifestHash: _ignored, generationId: _ignoredGen, ...content } = manifest as ProjectManifest;
  return hashCanonical('SAJIMORA_PROJECT_MANIFEST_V1', content);
}

export function calculateCommitManifestHash(manifest: Omit<CommitManifest, 'manifestHash'> | CommitManifest): string {
  const { manifestHash: _ignored, generationId: _ignoredGen, ...content } = manifest as CommitManifest;
  return hashCanonical('SAJIMORA_COMMIT_MANIFEST_V1', content);
}

export function calculateCertificateHash(certificate: Omit<BoundCompletenessCertificate, 'certificateHash'> | BoundCompletenessCertificate): string {
  const { certificateHash: _ignored, generationId: _ignoredGen, ...content } = certificate as BoundCompletenessCertificate;
  return hashCanonical('SAJIMORA_COMPLETENESS_CERTIFICATE_V2', content);
}

export function calculateGenerationContentHash(
  identity: CommitIndexIdentity,
  artifactHashes: readonly string[]
): string {
  return hashCanonical('SAJIMORA_GENERATION_CONTENT_V1', {
    identity,
    artifactHashes: [...artifactHashes].sort()
  });
}
