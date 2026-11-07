import * as process from 'node:process';
import * as path from 'node:path';
import { GitRepository } from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import { captureSnapshotPair } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
import { makeInconclusiveReport, makeErrorReport, AnalysisBlocker, SnapshotIdentity } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts';
import { serializeReport, writeReportAtomic, parseReport } from '../../packages/analysis/src/sajimora/cross-language/AgentImpactJson';
import { analyzeCrossLanguageImpact } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageImpactAnalyzer';

interface CliArgs {
  repo: string;
  parent: string;
  candidateCommit?: string;
  workingTree: boolean;
  output?: string;
  format: 'json';
  javaRoot?: string;
  tsRoot?: string;
  failOnViolation?: boolean;
  strict?: boolean;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args = argv.slice(2);
  let repo: string | undefined;
  let parent: string | undefined;
  let candidateCommit: string | undefined;
  let workingTree = false;
  let output: string | undefined;
  let format: string = 'json'; 
  let javaRoot: string | undefined;
  let tsRoot: string | undefined;
  let failOnViolation = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--repo': repo = args[++i]; break;
      case '--parent': parent = args[++i]; break;
      case '--candidate': candidateCommit = args[++i]; break;
      case '--working-tree': workingTree = true; break;
      case '--output': output = args[++i]; break;
      case '--format': format = args[++i] ?? 'json'; break;
      case '--java-root': javaRoot = args[++i]; break;
      case '--ts-root': tsRoot = args[++i]; break;
      case '--fail-on-violation': failOnViolation = true; break;
      case '--strict': strict = true; failOnViolation = true; break;
      default: return { error: `Unknown argument: ${args[i]}` };
    }
  }

  if (!repo) return { error: 'Missing required argument: --repo' };
  if (!parent) return { error: 'Missing required argument: --parent' };
  if (!candidateCommit && !workingTree) {
    return { error: 'Must specify exactly one of --candidate <sha> or --working-tree' };
  }
  if (candidateCommit && workingTree) {
    return { error: 'Cannot specify both --candidate and --working-tree' };
  }
  if (format !== 'json') return { error: `Unsupported --format value: ${format}` };

  return { repo, parent, candidateCommit, workingTree, output, format: 'json', javaRoot, tsRoot, failOnViolation, strict };
}

function placeholderIdentity(parentCommit: string): SnapshotIdentity {
  return { repositoryId: 'unknown', parentCommit, candidateSnapshot: 'unknown' };
}

function filterMap<K, V>(map: ReadonlyMap<K, V>, predicate: (key: K) => boolean): Map<K, V> {
  const result = new Map<K, V>();
  for (const [k, v] of map.entries()) {
    if (predicate(k)) result.set(k, v);
  }
  return result;
}

async function main(): Promise<void> {
  console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
  const parsed = parseArgs(process.argv);
  if ('error' in parsed) {
    process.stderr.write(`[analyzeCrossLanguage] Argument error: ${parsed.error}\n`);
    process.exit(1);
  }

  const { repo, parent: parentCommit, candidateCommit, workingTree, output, javaRoot, tsRoot, failOnViolation, strict } = parsed;
  const repoPath = path.resolve(repo);
  process.stderr.write(`[analyzeCrossLanguage] repo=${repoPath} parent=${parentCommit} candidate=${workingTree ? 'working-tree' : candidateCommit}\n`);

  let repository: GitRepository;
  try {
    repository = new GitRepository(repoPath);
    repository.validate();
  } catch (err) {
    const report = makeErrorReport({
      repository: placeholderIdentity(parentCommit),
      blockerCode: 'TOOL_FAILURE',
      message: `Repository validation failed: ${err}`,
    });
    emit(serializeReport(report), output);
    process.exit(failOnViolation || strict ? 1 : 0);
    return;
  }

  let snapshotPair: Awaited<ReturnType<typeof captureSnapshotPair>>;
  try {
    const t0 = Date.now();
    snapshotPair = await captureSnapshotPair({
      repository,
      parentCommit,
      candidate: workingTree ? { kind: 'working-tree' } : { kind: 'commit', sha: candidateCommit! },
    });
    process.stderr.write(`[analyzeCrossLanguage] Snapshot capture took ${Date.now() - t0}ms\n`);
  } catch (err) {
    const report = makeErrorReport({
      repository: placeholderIdentity(parentCommit),
      blockerCode: 'TOOL_FAILURE',
      message: `Snapshot capture failed: ${err}`,
    });
    emit(serializeReport(report), output);
    process.exit(failOnViolation || strict ? 1 : 0);
    return;
  }

  process.stderr.write(`[analyzeCrossLanguage] Captured ${snapshotPair.candidateFiles.size} candidate files, ${snapshotPair.parentFiles.size} parent files.\n`);

  const captureBlockers: AnalysisBlocker[] = [...snapshotPair.blockers];
  
  if (captureBlockers.length > 0) {
    const report = makeInconclusiveReport({
      repository: snapshotPair.identity,
      blockers: captureBlockers,
    });
    emit(serializeReport(report), output);
    process.exit(strict ? 3 : 0);
    return;
  }

  const isJava = (p: string) => p.endsWith('.java') && (!javaRoot || p.startsWith(javaRoot));
  const isTs = (p: string) => (p.endsWith('.ts') || p.endsWith('.tsx')) && (!tsRoot || p.startsWith(tsRoot));

  const parentJava = filterMap(snapshotPair.parentFiles, (p) => isJava(p as string));
  const candidateJava = filterMap(snapshotPair.candidateFiles, (p) => isJava(p as string));
  const candidateTs = filterMap(snapshotPair.candidateFiles, (p) => isTs(p as string));
  const parentTs = filterMap(snapshotPair.parentFiles, (p) => isTs(p as string));

  const parentJavaFiles = new Map<string, string>();
  for (const [p, f] of parentJava) parentJavaFiles.set(p as string, f.bytes.toString('utf8'));
  const candidateJavaFiles = new Map<string, string>();
  for (const [p, f] of candidateJava) candidateJavaFiles.set(p as string, f.bytes.toString('utf8'));
  const parentTsFiles = new Map<string, string>();
  for (const [p, f] of parentTs) parentTsFiles.set(p as string, f.bytes.toString('utf8'));
  const candidateTsFiles = new Map<string, string>();
  for (const [p, f] of candidateTs) candidateTsFiles.set(p as string, f.bytes.toString('utf8'));

  let finalReport;
  try {
    const t0 = Date.now();
    finalReport = analyzeCrossLanguageImpact({
      identity: snapshotPair.identity,
      parentJavaFiles,
      candidateJavaFiles,
      parentTsFiles,
      candidateTsFiles,
      parentConfigFiles: new Map([...snapshotPair.parentFiles].filter(([p]) => !/\.(?:java|tsx?)$/.test(p)).map(([p, f]) => [p, f.bytes.toString('utf8')])),
      candidateConfigFiles: new Map([...snapshotPair.candidateFiles].filter(([p]) => !/\.(?:java|tsx?)$/.test(p)).map(([p, f]) => [p, f.bytes.toString('utf8')]))
    });
    process.stderr.write(`[analyzeCrossLanguage] Analysis took ${Date.now() - t0}ms\n`);
  } catch (err) {
    const report = makeInconclusiveReport({
      repository: snapshotPair.identity,
      blockers: [{ code: 'TOOL_FAILURE', message: `Analysis failed: ${err}` }]
    });
    emit(serializeReport(report), output);
    process.exit(failOnViolation || strict ? 1 : 0);
    return;
  }

  emit(serializeReport(finalReport), output);
  if (failOnViolation || strict) {
    if (finalReport.verdict === 'LIKELY_VIOLATED') {
      process.exit(1);
    }
    if (strict && finalReport.verdict === 'INCONCLUSIVE') {
      process.exit(3);
    }
  }
  process.exit(0);
}

function emit(json: string, outputPath: string | undefined): void {
  if (outputPath) {
    try {
      writeReportAtomic(parseReport(json), outputPath);
      process.stderr.write(`[analyzeCrossLanguage] Report written to: ${outputPath}\n`);
    } catch (err) {
      process.stderr.write(`[analyzeCrossLanguage] Failed to write output file: ${err}\n`);
      process.stdout.write(json + '\n');
    }
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch(err => {
  process.stderr.write(`[analyzeCrossLanguage] Unexpected error: ${err}\n`);
  process.exit(1);
});
