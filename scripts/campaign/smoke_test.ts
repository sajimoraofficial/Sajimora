import { runCertifiedCampaign } from './run_campaign_50';

async function main() {
  console.log('--- RUNNING 3-QUERY CERTIFIED SMOKE TEST ---');
  // Smoke test 3 representative queries:
  // 1. Q01 (fails at Gate 4 with UNSUPPORTED_SYNTAX)
  // 2. Q12 (deepest real git closure reach in zod: passes Gates 1-2, reaches Gate 3 CLOSURE_COMPLETENESS with UNSUPPORTED_CONFIGURATION)
  // 3. Case-B plumbing fixture (genuine Gate 5 IDENTITY with UNCERTAIN_IDENTITY)
  const res = await runCertifiedCampaign(['Q01', 'Q02', 'Q12']);
  console.log('Smoke test completed successfully with count:', res.results.length);
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
