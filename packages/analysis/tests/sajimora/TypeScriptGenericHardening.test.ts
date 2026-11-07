import { TypeScriptNumericWitnessChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { GenericRepository, GenericRepositorySnapshot, ProductionVerificationCore } from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { canonicalRepositoryPath } from '../../src/sajimora/languages/typescript/production/CanonicalRepositoryPath';

function snapshot(id: string, files: Record<string, string>): GenericRepositorySnapshot {
  const normalized = new Map(Object.entries(files).map(([path, text]) => [path.replace(/\\/g, '/'), text]));
  return {
    snapshotId: id,
    rootIdentifier: '/',
    files: [...normalized].map(([path, text]) => ({
      path,
      byteLength: Buffer.byteLength(text),
      hash: crypto.createHash('sha256').update(text).digest('hex')
    })),
    readTextFile: path => normalized.get(path.replace(/\\/g, '/')),
    readBinaryFile: path => {
      const text = normalized.get(path.replace(/\\/g, '/'));
      return text === undefined ? undefined : Buffer.from(text);
    }
  };
}

function repository(parent: Record<string, string>, candidate: Record<string, string>): GenericRepository {
  return { repositoryId: 'controlled-semantic-fixture', parentSnapshot: snapshot('parent', parent), candidateSnapshot: snapshot('candidate', candidate) };
}

async function run(): Promise<void> {
  const config = JSON.stringify({ compilerOptions: { strict: true, module: 'commonjs', target: 'es2020' }, include: ['**/*.ts'] });
  const stable = 'export function stable(value: string): string { return value; }\n';
  const parentProvider = stable + 'export function transform(value: number): number { return value + 1; }\n';
  const candidateProvider = stable + 'export function transform(value: number): number { return value + 2; }\n';
  const parent = {
    'tsconfig.json': config,
    'src/provider.ts': parentProvider,
    'src/reexport.ts': 'export * from "./provider";\n',
    'src/index.ts': 'export { transform as mapped } from "./reexport";\n',
    'src/consumer.ts': 'import { mapped } from "./index"; export const result = mapped(1);\n',
    'src/unrelated.ts': 'export function unrelated(): boolean { eval("sideEffect()"); return true; }\n'
  };
  const repo = repository(parent, { ...parent, 'src/provider.ts': candidateProvider });
  const adapter = new TypeScriptProductionAdapter();
  const parentGraph = await adapter.discoverProjectGraph(repo.parentSnapshot);
  const candidateGraph = await adapter.discoverProjectGraph(repo.candidateSnapshot);
  const mapping = await adapter.mapProjectGraphs(parentGraph, candidateGraph);
  const identified = await adapter.identifyEntitiesAndChanges(repo, mapping);

  const byName = new Map(identified.changes.map(change => [change.identity.parentEntity?.name ?? change.identity.candidateEntity?.name, change]));
  assert.equal(byName.get('transform')?.changeKind, 'BODY_MUTATED');
  assert.equal(byName.get('stable')?.changeKind, 'UNCHANGED');
  assert.equal(byName.get('unrelated')?.changeKind, 'UNCHANGED');
  assert.equal(identified.changes.filter(change => change.changeKind !== 'UNCHANGED').length, 1,
    'one changed file must not relabel unrelated entities as metadata changes');

  const changed = identified.changes.filter(change => change.changeKind !== 'UNCHANGED')
    .flatMap(change => change.identity.parentEntity ? [change.identity.parentEntity] : []);
  const discovered = await adapter.discoverReferences(repo.parentSnapshot, parentGraph, changed);
  assert.ok(discovered.staticReferences.some(ref => ref.location.filePath === 'src/consumer.ts' && ref.kind === 'STATIC_CALL'),
    'unchanged consumers behind transitive re-exports must remain discoverable');
  assert.ok(discovered.staticReferences.every(ref => ref.targetEntityId === changed[0].entityId || ref.targetEntityId === 'GLOBAL_AUGMENTATION'));
  assert.ok(discovered.unresolvedBoundaries.every(ref => ref.location.filePath !== 'src/unrelated.ts'),
    'dynamic syntax outside the compiler-proven impact envelope must not contaminate the target');

  const obligations = await adapter.generateObligations(identified.changes, [...discovered.staticReferences, ...discovered.unresolvedBoundaries]);
  assert.ok(obligations.length < identified.changes.length * 2,
    'obligation generation must be proportional to changed targets and actual references, not inventory size');
  assert.ok(obligations.every(obligation => obligation.change.changeKind !== 'UNCHANGED'));

  const namespaceParent = {
    'tsconfig.json': config,
    'src/namespace.ts': 'export namespace Geometry { export interface Point { x: number } export const origin: Point = { x: 0 }; }\n',
    'src/use.ts': 'import { Geometry } from "./namespace"; export const point: Geometry.Point = Geometry.origin;\n'
  };
  const namespaceCandidate = { ...namespaceParent,
    'src/namespace.ts': 'export namespace Geometry { export interface Point { x: number; y?: number } export const origin: Point = { x: 0 }; }\n' };
  const namespaceRepo = repository(namespaceParent, namespaceCandidate);
  const namespaceAdapter = new TypeScriptProductionAdapter();
  const namespaceCore = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
  namespaceCore.registerAdapter(namespaceAdapter);
  const result = await namespaceCore.verifyRepository(namespaceRepo);
  assert.equal(result.ledger.conservationReport.silentDropsCount, 0);
  assert.equal(result.ledger.conservationReport.conservationSatisfied, true);
  assert.ok(result.ledger.discoveryAccounting);
  assert.equal(result.ledger.discoveryAccounting!.candidateReferencesDiscovered,
    result.ledger.discoveryAccounting!.confirmedConsumers + result.ledger.discoveryAccounting!.unresolvedPotentialConsumers);
  assert.ok(result.ledger.discoveryAccounting!.consumerLocations.every(location => location.referenceId && location.relationshipType));

  const configChanged = repository(
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }), 'src/api.ts': 'export function accept(value: string): string { return value; }\n' },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }), 'src/api.ts': 'export function accept(value: string): string { return value; }\n' }
  );
  const configCore = new ProductionVerificationCore([new TypeScriptNumericWitnessChecker()]);
  configCore.registerAdapter(new TypeScriptProductionAdapter());
  const configResult = await configCore.verifyRepository(configChanged);
  assert.equal(configResult.ledger.certificationStatus, 'UNCERTIFIED_UNKNOWN',
    'changed compiler inputs must remain an explicit environment boundary, not NOT_APPLICABLE');
  assert.ok(configResult.ledger.verdicts.some(verdict =>
    verdict.evidence.unresolvedBoundary?.taxonomyCode === 'PROJECT_ENVIRONMENT_CHANGED'));

  const dependencyRepo = repository(
    { 'tsconfig.json': config, 'src/dependency.ts': 'function helper(value: number) { return value + 1; } export function api(value: number) { return helper(value); }\n' },
    { 'tsconfig.json': config, 'src/dependency.ts': 'function helper(value: number) { return value + 2; } export function api(value: number) { return helper(value); }\n' }
  );
  const dependencyAdapter = new TypeScriptProductionAdapter();
  const depParentGraph = await dependencyAdapter.discoverProjectGraph(dependencyRepo.parentSnapshot);
  const depCandidateGraph = await dependencyAdapter.discoverProjectGraph(dependencyRepo.candidateSnapshot);
  const depIdentified = await dependencyAdapter.identifyEntitiesAndChanges(dependencyRepo,
    await dependencyAdapter.mapProjectGraphs(depParentGraph, depCandidateGraph));
  const apiChange = depIdentified.changes.find(change => change.identity.parentEntity?.name === 'api');
  const helperChange = depIdentified.changes.find(change => change.identity.parentEntity?.name === 'helper');
  assert.equal(apiChange?.changeKind, 'UNCHANGED');
  assert.equal(helperChange?.changeKind, 'BODY_MUTATED');
  const helperReferences = await dependencyAdapter.discoverReferences(dependencyRepo.parentSnapshot, depParentGraph,
    [helperChange!.identity.parentEntity!]);
  assert.ok(helperReferences.staticReferences.some(reference => reference.location.filePath === 'src/dependency.ts'),
    'a caller of a changed local helper must be an impact-envelope consumer, not another changed provider');

  const narrowingRepo = repository(
    { 'tsconfig.json': config, 'src/api.ts': 'export function invoke(value?: number): number { return value ?? 0; }\n' },
    { 'tsconfig.json': config, 'src/api.ts': 'export function invoke(value: number): number { return value; }\n' }
  );
  const narrowingAdapter = new TypeScriptProductionAdapter();
  const narrowParentGraph = await narrowingAdapter.discoverProjectGraph(narrowingRepo.parentSnapshot);
  const narrowCandidateGraph = await narrowingAdapter.discoverProjectGraph(narrowingRepo.candidateSnapshot);
  const narrowIdentified = await narrowingAdapter.identifyEntitiesAndChanges(narrowingRepo,
    await narrowingAdapter.mapProjectGraphs(narrowParentGraph, narrowCandidateGraph));
  const narrowingChange = narrowIdentified.changes.find(change => change.identity.parentEntity?.name === 'invoke')!;
  assert.equal(narrowingChange.changeKind, 'SIGNATURE_NARROWED');
  const apiObligation = (await narrowingAdapter.generateObligations([narrowingChange], []))
    .find(obligation => obligation.question === 'API_COMPATIBILITY')!;
  const apiVerdict = await narrowingAdapter.evaluateObligation(apiObligation, narrowingRepo);
  assert.equal(apiVerdict.outcome, 'VIOLATED');
  assert.equal(apiVerdict.assurance, 'COMPILER_STATIC');

  // RC005: every compiler/snapshot path is one repository-root-relative identity.
  assert.equal(canonicalRepositoryPath('C:\\workspace\\pkg\\src\\api.ts', 'C:\\workspace\\pkg'), 'src/api.ts');
  assert.equal(canonicalRepositoryPath('/nested/pkg/../pkg/api.ts', '/'), 'nested/pkg/api.ts');
  assert.equal(canonicalRepositoryPath('../../outside.ts', '/'), '__ESCAPE_ROOT__');
  const pathRepo = repository(
    { 'tsconfig.json': config, 'nested/lib/provider.ts': 'export function consume(value: number): void {}\n',
      'nested/app/consumer.ts': 'import { consume } from "../lib/provider"; consume(1);\n' },
    { 'tsconfig.json': config, 'nested/lib/provider.ts': 'export function consume(value: number | string): void {}\n',
      'nested/app/consumer.ts': 'import { consume } from "../lib/provider"; consume(1);\n' }
  );
  const pathAdapter = new TypeScriptProductionAdapter();
  const pathParentGraph = await pathAdapter.discoverProjectGraph(pathRepo.parentSnapshot);
  const pathCandidateGraph = await pathAdapter.discoverProjectGraph(pathRepo.candidateSnapshot);
  const pathIdentified = await pathAdapter.identifyEntitiesAndChanges(pathRepo,
    await pathAdapter.mapProjectGraphs(pathParentGraph, pathCandidateGraph));
  const consumeChange = pathIdentified.changes.find(change => change.identity.parentEntity?.name === 'consume')!;
  const pathReferences = await pathAdapter.discoverReferences(pathRepo.parentSnapshot, pathParentGraph, [consumeChange.identity.parentEntity!]);
  const pathObligations = await pathAdapter.generateObligations([consumeChange], pathReferences.staticReferences);
  const consumerObligation = pathObligations.find(obligation => obligation.question === 'CONSUMER_COMPATIBILITY' &&
    canonicalRepositoryPath(obligation.reference?.location.filePath ?? '') === 'nested/app/consumer.ts')!;
  assert.ok(consumerObligation, 'canonical paths must retain a consumer in an arbitrary nested layout');
  const consumerVerdict = await pathAdapter.evaluateObligation(consumerObligation, pathRepo);
  assert.notEqual(consumerVerdict.evidence.unresolvedBoundary?.taxonomyCode, 'MISSING_SEALED_CONSUMER_SOURCE');

  // RC004: provider relations are checked in one sealed TypeChecker, never by
  // passing a ts.Type from the parent Program into the candidate TypeChecker.
  const wideningApi = (await pathAdapter.generateObligations([consumeChange], []))
    .find(obligation => obligation.question === 'API_COMPATIBILITY')!;
  const wideningVerdict = await pathAdapter.evaluateObligation(wideningApi, pathRepo);
  assert.equal(wideningVerdict.outcome, 'PRESERVED');
  assert.equal(wideningVerdict.evidence.metadata?.['route'], 'TYPESCRIPT_SAME_CHECKER_COMPATIBILITY_WITNESS_V1');

  // RC002: generic constraints and defaults are public semantic fingerprint inputs.
  const genericRepo = repository(
    { 'tsconfig.json': config, 'src/generic.ts': 'export function wrap<T extends unknown = unknown>(value: T): T { return value; }\n' },
    { 'tsconfig.json': config, 'src/generic.ts': 'export function wrap<T extends string = string>(value: T): T { return value; }\n' }
  );
  const genericAdapter = new TypeScriptProductionAdapter();
  const genericParentGraph = await genericAdapter.discoverProjectGraph(genericRepo.parentSnapshot);
  const genericCandidateGraph = await genericAdapter.discoverProjectGraph(genericRepo.candidateSnapshot);
  const genericIdentified = await genericAdapter.identifyEntitiesAndChanges(genericRepo,
    await genericAdapter.mapProjectGraphs(genericParentGraph, genericCandidateGraph));
  const genericChange = genericIdentified.changes.find(change => change.identity.parentEntity?.name === 'wrap')!;
  assert.equal(genericChange.changeKind, 'TYPE_DEFINITION_CHANGED');
  assert.match(genericChange.identity.parentEntity!.signatureFingerprint, /extends unknown = unknown/);
  assert.match(genericChange.identity.candidateEntity!.signatureFingerprint, /extends string = string/);
  assert.ok((await genericAdapter.generateObligations([genericChange], [])).length > 0);

  const enumRepo = repository(
    { 'tsconfig.json': config, 'src/status.ts': 'export enum Status { Active = "ACTIVE", Pending = "PENDING" }\n' },
    { 'tsconfig.json': config, 'src/status.ts': 'export enum Status { Active = "ACTIVE", Pending = "PENDING", Closed = "CLOSED" }\n' }
  );
  const enumAdapter = new TypeScriptProductionAdapter();
  const enumParentGraph = await enumAdapter.discoverProjectGraph(enumRepo.parentSnapshot);
  const enumCandidateGraph = await enumAdapter.discoverProjectGraph(enumRepo.candidateSnapshot);
  const enumIdentified = await enumAdapter.identifyEntitiesAndChanges(enumRepo,
    await enumAdapter.mapProjectGraphs(enumParentGraph, enumCandidateGraph));
  const enumChange = enumIdentified.changes.find(change => change.identity.parentEntity?.name === 'Status')!;
  const enumObligation = (await enumAdapter.generateObligations([enumChange], []))[0];
  const enumVerdict = await enumAdapter.evaluateObligation(enumObligation, enumRepo);
  assert.equal(enumVerdict.outcome, 'PRESERVED', 'normalized enum comparison must permit an appended explicit member');

  console.log('TypeScript generic production hardening tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
