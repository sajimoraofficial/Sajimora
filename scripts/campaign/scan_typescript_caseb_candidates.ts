import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';
import { prepareCaseBInput } from './CaseBInputPreparation';

type Candidate = { parentSha: string; candidateSha: string; targetFile: string; targetSymbol: string; consumerFile: string };
type State = { schemaVersion: 'V33_TYPESCRIPT_CASEB_SCAN_V1'; repository: string; commits: string[]; nextIndex: number; candidates: Candidate[]; scannedAt: string };
const repo = path.resolve('scripts/campaign/repos/typescript');
const outDir = path.resolve('artifacts/typescript-caseb-scan');
const statePath = path.join(outDir, 'checkpoint.json');
const resultPath = path.join(outDir, 'candidates.json');

function git(args: string[]): string { return childProcess.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
function write(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
function load(): State {
  try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as State; if (s.schemaVersion === 'V33_TYPESCRIPT_CASEB_SCAN_V1') return s; } catch { /* first run */ }
  return { schemaVersion: 'V33_TYPESCRIPT_CASEB_SCAN_V1', repository: repo, commits: git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean), nextIndex: 0, candidates: [], scannedAt: new Date().toISOString() };
}

const state = load();
for (; state.nextIndex < state.commits.length; state.nextIndex++) {
  const candidateSha = state.commits[state.nextIndex];
  let parentSha: string;
  try { parentSha = git(['rev-parse', `${candidateSha}^`]).trim(); } catch { write(statePath, state); continue; }
  try {
    const changed = git(['diff', '--name-only', parentSha, candidateSha]);
    if (!changed.split(/\r?\n/).some(file => /\.(?:ts|tsx|js|jsx)$/.test(file))) {
      state.scannedAt = new Date().toISOString(); write(statePath, state); continue;
    }
    const derived = deriveRealDiffObligations(repo, parentSha, candidateSha);
    if (derived.status === 'DERIVED') for (const obligation of derived.obligations) {
      const symbol = obligation.mutatedSymbol;
      if (!symbol || symbol.kind !== 'FUNCTION' || !symbol.symbolId) continue;
      const targetFile = symbol.declarationLocation.filePath.replace(`${repo.replace(/\\/g, '/')}/`, '');
      const prepared = prepareCaseBInput(repo, parentSha, candidateSha, targetFile, symbol.symbolId);
      if (prepared.target?.declarationKind === 'FunctionDeclaration' && prepared.consumerFile) {
        const item: Candidate = { parentSha, candidateSha, targetFile, targetSymbol: symbol.symbolId, consumerFile: prepared.consumerFile };
        if (!state.candidates.some(x => JSON.stringify(x) === JSON.stringify(item))) state.candidates.push(item);
      }
    }
  } catch { /* A malformed or unavailable commit is an excluded, fail-closed input. */ }
  state.scannedAt = new Date().toISOString();
  write(statePath, state);
  if ((state.nextIndex + 1) % 25 === 0) console.log(`scanned ${state.nextIndex + 1}/${state.commits.length}; candidates ${state.candidates.length}`);
}
write(resultPath, { schemaVersion: state.schemaVersion, repository: state.repository, totalCommits: state.commits.length, candidates: state.candidates });
console.log(JSON.stringify({ totalCommits: state.commits.length, candidates: state.candidates.length, resultPath }));
