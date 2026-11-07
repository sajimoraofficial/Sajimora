import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

type SealedFile = { path: string; byteLength: number; sha256: string; bytes: string };
type SealedCase = { id: string; expected: string; parent: { files: SealedFile[] }; candidate: { files: SealedFile[] }; invariants: Record<string, boolean> };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateAblationSealedFixtures(inputPath: string): string[] {
  const document = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { cases: SealedCase[] };
  const errors: string[] = [];
  for (const fixture of document.cases) {
    const parent = new Map(fixture.parent.files.map(file => [file.path, file]));
    const candidate = new Map(fixture.candidate.files.map(file => [file.path, file]));
    for (const [filePath, file] of [...parent, ...candidate]) {
      if (file.byteLength !== Buffer.byteLength(file.bytes)) errors.push(`${fixture.id}:${filePath}: byte length mismatch`);
      if (file.sha256 !== sha256(file.bytes)) errors.push(`${fixture.id}:${filePath}: digest mismatch`);
    }
    const parentConsumer = parent.get('consumer.ts');
    const candidateConsumer = candidate.get('consumer.ts');
    if (!parentConsumer || !candidateConsumer || parentConsumer.sha256 !== candidateConsumer.sha256) {
      errors.push(`${fixture.id}: consumer is not byte-identical across revisions`);
    }
    if (parent.get('provider.ts')?.sha256 === candidate.get('provider.ts')?.sha256) {
      errors.push(`${fixture.id}: provider did not change across revisions`);
    }
  }
  return errors;
}

if (require.main === module) {
  const input = path.resolve(process.argv[2] ?? 'scripts/campaign/fixtures/ablation_8_cases_sealed.json');
  const errors = validateAblationSealedFixtures(input);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('All 8 sealed fixtures passed byte and integrity validation');
  }
}
