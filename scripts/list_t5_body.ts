import { getTier5Queries } from './campaign/coverage_tier5_queries';

const queries = getTier5Queries().filter(q => q.id.startsWith('T5-BODY'));
for (const q of queries) {
  console.log(`${q.id}: expected=${q.expectedVerdict} desc=${q.description}`);
}
