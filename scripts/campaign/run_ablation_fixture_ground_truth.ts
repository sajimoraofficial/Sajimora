import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Fixture = {
  id: string;
  expected: 'PRESERVED' | 'VIOLATED';
  providerParent: string;
  providerCandidate: string;
  consumer: string;
};

const fixtures: Fixture[] = [
  { id: 'CASE-1A', expected: 'PRESERVED', providerParent: 'export function target(data: string): boolean { return data.length > 0; }', providerCandidate: 'export function target(data: string): boolean { return data.trim().length > 0; }', consumer: 'import { target } from "./provider"; const result: boolean = target("ok");' },
  { id: 'CASE-1B', expected: 'VIOLATED', providerParent: 'export function target(data: string): boolean { return data.length > 0; }', providerCandidate: 'export function target(data: string, strict: boolean): boolean { return strict && data.length > 0; }', consumer: 'import { target } from "./provider"; const result: boolean = target("ok");' },
  { id: 'CASE-2A', expected: 'PRESERVED', providerParent: 'export function target(files: string): number { return files.length; }', providerCandidate: 'export function target(files: string): number { return files.trim().length; }', consumer: 'import { target } from "./provider.ts"; const result: number = target("files");' },
  { id: 'CASE-2B', expected: 'VIOLATED', providerParent: 'export function target(files: string): number { return files.length; }', providerCandidate: 'export function target(files: string): string { return String(files.length); }', consumer: 'import { target } from "./provider.ts"; const result: number = target("files");' },
  { id: 'CASE-3A', expected: 'PRESERVED', providerParent: 'export function target(lang: string): string { return lang; }', providerCandidate: 'export function target(lang: string): string { return lang.toLowerCase(); }', consumer: 'import { target } from "./provider"; const result: string = target("en");' },
  { id: 'CASE-3B', expected: 'VIOLATED', providerParent: 'export function target(lang: string): string { return lang; }', providerCandidate: 'export function target(lang: "en" | "fr"): string { return lang; }', consumer: 'import { target } from "./provider"; const language: string = "de"; const result: string = target(language);' },
  { id: 'CASE-4A', expected: 'PRESERVED', providerParent: 'export function target(root: string): string { return root; }', providerCandidate: 'export function target(root: string): string { return root.trim(); }', consumer: 'import { target } from "./provider.ts"; const result: string = target("root");' },
  { id: 'CASE-4B', expected: 'VIOLATED', providerParent: 'export function target(root: string): string { return root; }', providerCandidate: 'export function target(root: string): boolean { return root.length > 0; }', consumer: 'import { target } from "./provider.ts"; const result: string = target("root");' }
];

function diagnostics(provider: string, consumer: string): ts.Diagnostic[] {
  const files = new Map<string, string>([
    ['provider.ts', provider],
    ['consumer.ts', consumer]
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  host.readFile = fileName => files.get(path.basename(fileName)) ?? originalRead(fileName);
  host.fileExists = fileName => files.has(path.basename(fileName)) || originalExists(fileName);
  const program = ts.createProgram(['consumer.ts', 'provider.ts'], options, host);
  return ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
}

export function runAblationFixtureGroundTruth(): Array<{ id: string; expected: string; actual: string; diagnosticCount: number }> {
  return fixtures.map(fixture => {
    const errors = diagnostics(fixture.providerCandidate, fixture.consumer);
    const actual = errors.length === 0 ? 'PRESERVED' : 'VIOLATED';
    return { id: fixture.id, expected: fixture.expected, actual, diagnosticCount: errors.length };
  });
}

if (require.main === module) {
  const results = runAblationFixtureGroundTruth();
  console.log(JSON.stringify({ schemaVersion: 'V33_ABLATION_GROUND_TRUTH_V1', results }, null, 2));
  if (results.some(result => result.expected !== result.actual)) {
    process.exitCode = 1;
  } else {
    console.log('All 8 independent ground-truth fixtures passed');
  }
}
