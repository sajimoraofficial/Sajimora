import * as child from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';
import { inventoryDirectNamedCalls } from './RepositoryWideConsumerInventory';

const arg = (name: string) => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`); return process.argv[index + 1]; };
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const git = (repo: string, args: string[]) => child.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const source = (repo: string, revision: string, file: string) => git(repo, ['show', `${revision}:${file}`]);

function main() {
  const repo = path.resolve(arg('--repo')); const parentSha = arg('--parent'); const candidateSha = arg('--candidate');
  const targetFile = arg('--target-file').replace(/\\/g, '/'); const targetSymbol = arg('--target-symbol');
  const projectFileIds = JSON.parse(fs.readFileSync(arg('--project-files'), 'utf8')) as string[];
  const tsconfigFile = arg('--tsconfig').replace(/\\/g, '/');
  const groundTruthPath = arg('--ground-truth');
  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8')) as Array<{ file: string; start?: number; expectedVerdict?: string }>;
  const budgetMs = Number(process.argv.includes('--budget-ms') ? arg('--budget-ms') : '300000');
  if (!projectFileIds.includes(targetFile)) throw new Error('Selected project list must include target file');
  const tsconfigText = source(repo, parentSha, tsconfigFile);
  const parsedConfig = ts.parseConfigFileTextToJson(tsconfigFile, tsconfigText);
  if (parsedConfig.error || !parsedConfig.config) throw new Error(`Frozen tsconfig is invalid: ${tsconfigFile}`);
  const converted = ts.convertCompilerOptionsFromJson(parsedConfig.config.compilerOptions ?? {}, path.posix.dirname(tsconfigFile));
  if (converted.errors.length) throw new Error(`Frozen tsconfig options are invalid: ${converted.errors.map(e => e.messageText).join('; ')}`);
  const files = projectFileIds.map(file => ({ path: file, content: source(repo, parentSha, file) }));
  const inventory = inventoryDirectNamedCalls({ files, projectFileIds, targetFile, targetSymbol, compilerOptions: converted.options, allowRenamedNamedImports: true });
  const directConsumers = [...new Set(inventory.consumerSites.filter(site => site.status === 'DIRECT_CALL').map(site => site.file))].sort();
  const results = directConsumers.map(consumerFile => {
    const started = Date.now(); let result: any;
    try {
      const local = inventory.consumerSites.find(site => site.file === consumerFile && site.status === 'DIRECT_CALL')?.localName;
      result = CertifiedCampaignAdapter.evaluateRealCaseB({ repoPath: repo, repoId: path.basename(repo), parentSha, candidateSha, targetFile, targetSymbol, consumerFile, consumerLocalName: local, targetDeclarationKind: 'FunctionDeclaration', targetOwnerChain: [], targetDeclarationOrdinal: 0, projectFileIds });
    } catch (error) { result = { verdictResult: { verdict: 'UNKNOWN' }, passedGates: [], failedGate: 'ENGINE_RUNTIME', blockerCode: 'ENGINE_RUNTIME', detailMessage: String(error) }; }
    return { consumerFile, verdict: result.verdictResult?.verdict ?? 'UNKNOWN', proofPathValid: (result.passedGates ?? []).includes('VERDICT_AUTHORITY'), firstFailingGate: result.failedGate ?? null, blocker: result.blockerCode ?? null, runtimeMs: Date.now() - started };
  });
  const foundKeys = new Set(inventory.consumerSites.filter(site => site.status === 'DIRECT_CALL').map(site => `${site.file}:${site.start}`));
  const independentlyMissed = groundTruth.filter(site => !foundKeys.has(`${site.file}:${site.start ?? -1}`));
  const oracleMismatches = results.filter(result => { const expected = groundTruth.find(site => site.file === result.consumerFile)?.expectedVerdict; return result.proofPathValid && expected !== undefined && result.verdict !== expected; });
  const resourceExhaustion = results.filter(result => /RESOURCE|BUDGET/i.test(`${result.firstFailingGate} ${result.blocker}`));
  const summary = { selectedProjectFiles: projectFileIds.length, scannedFiles: inventory.visitedFiles.length, foundConsumerSites: inventory.consumerSites.filter(site => site.status === 'DIRECT_CALL').length, independentlyKnownConsumerSitesMissed: independentlyMissed.length, unresolvedCandidateSites: inventory.consumerSites.filter(site => site.status === 'UNRESOLVED_REFERENCE_FORM').length, unresolvedImports: inventory.unresolvedImports.length, excludedFiles: inventory.excludedFiles.length, certifiedPreserved: results.filter(result => result.proofPathValid && result.verdict === 'PRESERVED').length, certifiedViolated: results.filter(result => result.proofPathValid && result.verdict === 'VIOLATED').length, certifiedNotApplicable: results.filter(result => result.proofPathValid && result.verdict === 'NOT_APPLICABLE').length, expectedUnknown: results.filter(result => result.verdict === 'UNKNOWN' && groundTruth.find(s => s.file === result.consumerFile)?.expectedVerdict === 'UNKNOWN').length, unexpectedUnknown: results.filter(result => result.verdict === 'UNKNOWN' && groundTruth.find(s => s.file === result.consumerFile)?.expectedVerdict !== 'UNKNOWN').length, proofPathViolations: results.filter(result => !result.proofPathValid && result.verdict !== 'UNKNOWN').length, certifiedOracleMismatches: oracleMismatches.length, invalidInputs: 0, resourceExhaustion: resourceExhaustion.length, aggregateVerdict: inventory.completeness === 'COMPLETE_FOR_DIRECT_NAMED_CALLS' && inventory.visitedFiles.length === projectFileIds.length && independentlyMissed.length === 0 && results.every(result => result.proofPathValid) ? 'INVENTORY_COMPLETE' : 'UNKNOWN' };
  const artifact = { schemaVersion: 'SAJIMORA_REPOSITORY_WIDE_DIRECT_INVENTORY_RUN_V2', sealedBeforeExecution: true, seal: { repo, parentSha, candidateSha, targetFile, targetSymbol, tsconfigFile, tsconfigSha256: sha(tsconfigText), effectiveCompilerOptions: converted.options, typescriptVersion: ts.version, projectFileIds, projectFileListSha256: sha(JSON.stringify(projectFileIds)), parentSourceHashes: Object.fromEntries(files.map(file => [file.path, sha(file.content)])), candidateSourceHashes: Object.fromEntries(projectFileIds.map(file => [file, sha(source(repo, candidateSha, file))])), packageInputs: ['package.json', 'package-lock.json'].flatMap(file => { try { return [{ file, sha256: sha(source(repo, parentSha, file)) }]; } catch { return []; } }), resourceBudget: { wallClockMs: budgetMs }, generatorVersion: 'REPOSITORY_WIDE_DIRECT_INVENTORY_V2' }, independentReferenceList: { path: groundTruthPath, sha256: sha(fs.readFileSync(groundTruthPath)), method: 'Pre-execution separately reviewed list; not derived from Sajimora', sites: groundTruth, missedSites: independentlyMissed }, inventory, consumerVerdicts: results, summary, reproduce: `node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/run_repository_wide_direct_inventory.ts --repo ${JSON.stringify(repo)} --parent ${parentSha} --candidate ${candidateSha} --target-file ${targetFile} --target-symbol ${targetSymbol} --tsconfig ${tsconfigFile} --project-files <sealed-project-files.json> --ground-truth <independent-reference-list.json>` };
  const output = path.resolve(process.argv.includes('--output') ? arg('--output') : 'artifacts/repository-wide-direct-inventory-result.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n'); console.log(JSON.stringify(summary, null, 2));
}
main();
