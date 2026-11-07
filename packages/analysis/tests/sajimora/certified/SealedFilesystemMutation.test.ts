import * as assert from 'node:assert/strict';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { FileEntry } from '../../../../core/src/sajimora/certified/contracts';
import { ArtifactDomain } from '../../../../core/src/sajimora/certified/protocol';

const file: FileEntry = { fileId: 'api', logicalPath: 'api.ts', byteLength: 3,
  bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'source-digest' }, mode: 0o100644,
  kind: 'SOURCE', origin: 'GIT_OBJECT', provenanceRefs: [{ domain: ArtifactDomain.SOURCE_BYTES, digest: 'provenance' }] };
const data = Buffer.from('abc');
const fs = new SealedFilesystem([file], [{ digest: 'source-digest', data }], 'CASE_SENSITIVE');
data.fill(0);
file.logicalPath = 'changed.ts';
file.bytesRef.digest = 'changed-digest';
file.provenanceRefs[0].digest = 'changed-provenance';
assert.equal(fs.readBytes('api.ts').toString(), 'abc');
assert.equal(fs.getEntry('api.ts')!.logicalPath, 'api.ts');
assert.equal(fs.getEntry('api.ts')!.provenanceRefs[0].digest, 'provenance');
const output = fs.readBytes('api.ts');
output.fill(0);
fs.getEntry('api.ts')!.bytesRef.digest = 'forged';
fs.getEntry('api.ts')!.provenanceRefs.push({ domain: ArtifactDomain.SOURCE_BYTES, digest: 'extra' });
assert.equal(fs.readBytes('api.ts').toString(), 'abc');
assert.equal(fs.getEntry('api.ts')!.provenanceRefs.length, 1);
assert.equal(fs.getEntry('absent.ts'), undefined);
assert.throws(() => new SealedFilesystem([], [
  { digest: 'same', data: Buffer.from('a') }, { digest: 'same', data: Buffer.from('b') }
], 'CASE_SENSITIVE'), /conflicting byte data/);
console.log('Sealed filesystem mutation regressions PASSED.');
