import * as fs from 'node:fs';
import { runCertifiedCampaign } from './run_campaign_50';

const manifest = JSON.parse(fs.readFileSync('scripts/campaign/campaign_manifest_50.json', 'utf8')) as Array<{ queryId: string; targetFile: string }>;
const queryIds = manifest.filter(query => /\.tsx?$/.test(query.targetFile)).map(query => query.queryId);
const start = Number(process.argv[2] ?? '0');
const count = Number(process.argv[3] ?? String(queryIds.length));
runCertifiedCampaign(queryIds.slice(start, start + count)).then(result => console.log(JSON.stringify(result, null, 2)));
