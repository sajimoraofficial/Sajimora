import { CertifiedCampaignAdapter } from './CertifiedCampaignAdapter';

const run = () => CertifiedCampaignAdapter.evaluateRealCaseB({ repoPath: 'scripts/campaign/repos/turborepo', repoId: 'turborepo', parentSha: 'ef4677219f6d31911aff5a0c5aa953c53e12c40b', candidateSha: '06f59004ba50fabd4c582230ed076ee909fb85fc', targetSymbol: 'create', targetFile: 'packages/create-turbo/src/commands/create/index.ts' });
const started = process.hrtime.bigint();
const result = run();
const runtimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
const repeat = run();
console.log(JSON.stringify({
  verdict: result.verdictResult.verdict,
  passedGates: result.passedGates,
  failedGate: result.failedGate,
  blockerCode: result.blockerCode,
  detail: result.detailMessage,
  runtimeMs,
  rssBytes: process.memoryUsage().rss,
  deterministic: JSON.stringify(result) === JSON.stringify(repeat)
}, null, 2));
