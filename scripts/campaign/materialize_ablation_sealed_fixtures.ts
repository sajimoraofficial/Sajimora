import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Fixture = {
  id: string;
  expected: 'PRESERVED' | 'VIOLATED';
  providerParent: string;
  providerCandidate: string;
  consumer: string;
};

const sourceFixtures: Fixture[] = [
  { id: 'CASE-1A', expected: 'PRESERVED', providerParent: 'export function target(data: string): boolean { return data.length > 0; }', providerCandidate: 'export function target(data: string): boolean { return data.trim().length > 0; }', consumer: 'import { target } from "./provider"; const result: boolean = target("ok");' },
  { id: 'CASE-1B', expected: 'VIOLATED', providerParent: 'export function target(data: string): boolean { return data.length > 0; }', providerCandidate: 'export function target(data: string, strict: boolean): boolean { return strict && data.length > 0; }', consumer: 'import { target } from "./provider"; const result: boolean = target("ok");' },
  { id: 'CASE-2A', expected: 'PRESERVED', providerParent: 'export function target(files: string): number { return files.length; }', providerCandidate: 'export function target(files: string): number { return files.trim().length; }', consumer: 'import { target } from "./provider"; const result: number = target("files");' },
  { id: 'CASE-2B', expected: 'VIOLATED', providerParent: 'export function target(files: string): number { return files.length; }', providerCandidate: 'export function target(files: string): string { return String(files.length); }', consumer: 'import { target } from "./provider"; const result: number = target("files");' },
  { id: 'CASE-3A', expected: 'PRESERVED', providerParent: 'export function target(lang: string): string { return lang; }', providerCandidate: 'export function target(lang: string): string { return lang.toLowerCase(); }', consumer: 'import { target } from "./provider"; const result: string = target("en");' },
  { id: 'CASE-3B', expected: 'VIOLATED', providerParent: 'export function target(lang: string): string { return lang; }', providerCandidate: 'export function target(lang: "en" | "fr"): string { return lang; }', consumer: 'import { target } from "./provider"; const language: string = "de"; const result: string = target(language);' },
  { id: 'CASE-4A', expected: 'PRESERVED', providerParent: 'export function target(root: string): string { return root; }', providerCandidate: 'export function target(root: string): string { return root.trim(); }', consumer: 'import { target } from "./provider"; const result: string = target("root");' },
  { id: 'CASE-4B', expected: 'VIOLATED', providerParent: 'export function target(root: string): string { return root; }', providerCandidate: 'export function target(root: string): boolean { return root.length > 0; }', consumer: 'import { target } from "./provider"; const result: string = target("root");' }
];

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function file(pathName: string, bytes: string) {
  return { path: pathName, byteLength: Buffer.byteLength(bytes), sha256: digest(bytes), bytes };
}

export function materializeAblationFixtures(outputPath: string): void {
  const cases = sourceFixtures.map(fixture => ({
    id: fixture.id,
    expected: fixture.expected,
    parent: {
      revision: `${fixture.id}-parent`,
      files: [file('provider.ts', fixture.providerParent), file('consumer.ts', fixture.consumer.replace('./provider"', './provider.ts"'))]
    },
    candidate: {
      revision: `${fixture.id}-candidate`,
      files: [file('provider.ts', fixture.providerCandidate), file('consumer.ts', fixture.consumer.replace('./provider"', './provider.ts"'))]
    },
    invariants: {
      consumerUnchanged: true,
      providerChanged: fixture.providerParent !== fixture.providerCandidate
    }
  }));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    schemaVersion: 'V33_ABLATION_SEALED_FIXTURES_V1',
    status: 'SEALED_BYTES_AND_INTEGRITY_METADATA',
    cases
  }, null, 2), 'utf8');
}

if (require.main === module) {
  const output = path.resolve(process.argv[2] ?? 'scripts/campaign/fixtures/ablation_8_cases_sealed.json');
  materializeAblationFixtures(output);
  console.log(`Materialized sealed fixture bytes: ${output}`);
}
