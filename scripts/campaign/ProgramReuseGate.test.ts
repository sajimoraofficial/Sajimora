import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { evaluateProgramReuseEligibility, OldBuildRecord, NewBuildContext } from './ProgramReuseGate';

const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
const program = ts.createProgram([], options);
const old: OldBuildRecord = {
  revisionSha: 'same-content-revision',
  snapshotRoot: '/snapshots/same-content-revision',
  buildStatus: 'BUILT',
  trackedFiles: ['src/value.ts', 'tsconfig.json'],
  dependencyRoot: undefined,
  selectedConfigs: ['tsconfig.json'],
  projectPrograms: [{ configRel: 'tsconfig.json', program, parsedOptions: options }]
};
const next: NewBuildContext = {
  revisionSha: old.revisionSha,
  snapshotRoot: old.snapshotRoot,
  trackedFiles: [...old.trackedFiles],
  dependencyRoot: undefined,
  selection: {
    selectedConfigs: ['tsconfig.json'],
    subsumedConfigs: [],
    allConfigs: ['tsconfig.json'],
    closureStatus: 'PROVEN',
    closureBlockers: []
  },
  parsedOptions: new Map([['tsconfig.json', { ...options }]])
};

assert.equal(evaluateProgramReuseEligibility(old, next)?.get('tsconfig.json'), program);
assert.equal(evaluateProgramReuseEligibility(old, { ...next, revisionSha: 'different-bytes-same-file-paths' }), undefined);
assert.equal(evaluateProgramReuseEligibility(old, { ...next, snapshotRoot: '/snapshots/other-materialization' }), undefined);
assert.equal(evaluateProgramReuseEligibility({ ...old, revisionSha: '' }, next), undefined);
assert.equal(evaluateProgramReuseEligibility({ ...old, snapshotRoot: '' }, next), undefined);
console.log('Program reuse snapshot identity guards passed');
