import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../packages/core/src/sajimora/certified/protocol';
import { computeDomainSeparatedHash } from '../../packages/core/src/sajimora/certified/canonicalEncoding';
import { FileEntry } from '../../packages/core/src/sajimora/certified/contracts';
import { SealedFilesystem } from '../../packages/analysis/src/sajimora/certified/environment/SealedFilesystem';

type FileRecord = { path: string; bytes: string; sha256: string };
type Revision = { revision: string; files: FileRecord[] };
type Fixture = { id: string; parent: Revision; candidate: Revision };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function loadRevision(revision: Revision): SealedFilesystem {
  const files: FileEntry[] = [];
  const dataEntries: Array<{ digest: string; data: Buffer }> = [];
  for (const record of revision.files) {
    const data = Buffer.from(record.bytes, 'utf8');
    if (sha256(record.bytes) !== record.sha256) throw new Error(`${revision.revision}:${record.path}: SHA-256 mismatch`);
    const digest = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, data);
    files.push({
      fileId: record.path,
      logicalPath: record.path,
      byteLength: data.length,
      bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest },
      mode: 0o644,
      kind: 'SOURCE',
      origin: 'GIT_OBJECT',
      provenanceRefs: []
    });
    dataEntries.push({ digest, data });
  }
  return new SealedFilesystem(files, dataEntries, 'CASE_SENSITIVE');
}

export function loadAblationSealedFilesystems(inputPath: string): Map<string, { parent: SealedFilesystem; candidate: SealedFilesystem }> {
  const document = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { cases: Fixture[] };
  return new Map(document.cases.map(fixture => [fixture.id, {
    parent: loadRevision(fixture.parent),
    candidate: loadRevision(fixture.candidate)
  }]));
}

if (require.main === module) {
  const input = process.argv[2] ?? 'scripts/campaign/fixtures/ablation_8_cases_sealed.json';
  const loaded = loadAblationSealedFilesystems(input);
  for (const [id, revisions] of loaded) {
    if (!revisions.parent.exists('consumer.ts') || !revisions.candidate.exists('consumer.ts')) throw new Error(`${id}: missing consumer`);
    if (!revisions.parent.readBytes('consumer.ts').equals(revisions.candidate.readBytes('consumer.ts'))) throw new Error(`${id}: consumer lifecycle mismatch`);
  }
  console.log(`Loaded ${loaded.size} ablation cases into sealed filesystems`);
}
