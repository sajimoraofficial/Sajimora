import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdvisoryTypeScriptImpactAnalyzer } from '../../src/sajimora/advisory';
import { Slice100Manifest } from '../../../../scripts/campaign/materialize_readiness_slice_100';

const analyzer = new AdvisoryTypeScriptImpactAnalyzer();
const manifestPath = path.resolve('scripts/campaign/fixtures/typescript_readiness_100_slice.json');
const manifest: Slice100Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const c69 = manifest.cases.find(x => x.caseId === 'TSR-SL-069')!;
const res69 = analyzer.analyze({ parent: c69.parent, candidate: c69.candidate, target: c69.target });
console.log('Case 69 verdict:', res69.verdict);
console.log('Case 69 unresolved:', res69.completeness.unresolvedFiles);
console.log('Case 69 confidence:', res69.confidenceRationale);
console.log('Case 69 impacts:', res69.impacts);
