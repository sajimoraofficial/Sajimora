import * as fs from 'fs';
import * as path from 'path';
import { sealEnvelope, ARTIFACT_ENVELOPE_VERSION_V2, expandTypePool } from '../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import { ArtifactComparisonEngine } from '../packages/analysis/src/sajimora/cross-language/ArtifactComparisonEngine';
import { EndpointContract, EndpointIdentityContract, NormalizedRouteContract } from '../packages/analysis/src/sajimora/cross-language/CanonicalContractIR';

const targetRoutes = [
  { method: 'GET', path: '/api/whiteLabel/whiteLabelParams' },
  { method: 'POST', path: '/api/reportTemplate' },
  { method: 'GET', path: '/api/noauth/whiteLabel/loginWhiteLabelParams' },
  { method: 'POST', path: '/api/whiteLabel/previewWhiteLabelParams' },
  { method: 'GET', path: '/api/widgetType' },
  { method: 'POST', path: '/api/ai/solution/start' },
  { method: 'GET', path: '/api/permissions/allowedPermissions' },
  { method: 'POST', path: '/api/admin/settings' },
  { method: 'GET', path: '/api/tenant/devices' },
  { method: 'GET', path: '/api/tenant/assets' }
];

function makeEndpoint(t: { method: string; path: string }, bodyType: any): EndpointContract {
  const segments = t.path.split('/').filter(Boolean).map(text => ({
    text,
    isParam: false
  }));
  return {
    identity: {
      service: 'thingsboard',
      httpMethod: t.method,
      normalizedRoute: {
        rawPath: t.path,
        segments
      },
      direction: 'RESPONSE'
    },
    pathParameters: [],
    queryParameters: [],
    headers: [],
    body: bodyType,
    provenance: { language: 'JAVA', file: 'Controller.java', line: 1 }
  };
}

// Base backend returns object with 'id': string, 'name': string, 'enabled': boolean
const baseEndpoints = targetRoutes.map(t => makeEndpoint(t, {
  kind: 'OBJECT',
  properties: [
    { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] },
    { wireName: 'name', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] },
    { wireName: 'enabled', type: { kind: 'PRIMITIVE', scalar: 'boolean' }, optional: false, nullable: false, validationConstraints: [] }
  ]
}));

const snapshot = {
  repositoryId: 'git-root:0439df09f31b0e8101b9f0a6be556c087d86818d',
  serviceId: 'thingsboard',
  apiVersion: 'v1',
  parentCommit: '0439df09f31b0e8101b9f0a6be556c087d86818d',
  candidateSnapshot: '0439df09f31b0e8101b9f0a6be556c087d86818d'
};

const baseBackend = sealEnvelope({
  envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
  reportSchemaVersion: 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',
  kind: 'BACKEND_CONTRACT',
  snapshot,
  profile: { toolVersion: '0.10.2', frameworkProfile: 'SPRING_MVC', codecProfile: 'JACKSON_DEFAULT_V1', configFingerprint: null },
  completeness: { complete: true, unresolvedEndpoints: [], blockers: [] },
  payload: { baseUrls: [], proxyPrefixes: [], endpoints: baseEndpoints }
});

// Candidate backend introduces BREAKING CHANGES to all 10 endpoints:
// 1. 'id' changed string -> number (TYPE BREAK)
// 2. 'name' field removed (DELETION BREAK)
const candEndpoints = targetRoutes.map(t => makeEndpoint(t, {
  kind: 'OBJECT',
  properties: [
    { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
    { wireName: 'renamedField', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }
  ]
}));

const candBackend = sealEnvelope({
  envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
  reportSchemaVersion: 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',
  kind: 'BACKEND_CONTRACT',
  snapshot,
  profile: { toolVersion: '0.10.2', frameworkProfile: 'SPRING_MVC', codecProfile: 'JACKSON_DEFAULT_V1', configFingerprint: null },
  completeness: { complete: true, unresolvedEndpoints: [], blockers: [] },
  payload: { baseUrls: [], proxyPrefixes: [], endpoints: candEndpoints }
});

const scratchDir = path.resolve(__dirname, '../scratch');
if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

fs.writeFileSync(path.join(scratchDir, 'tb_base_backend.json'), JSON.stringify(baseBackend, null, 2));
fs.writeFileSync(path.join(scratchDir, 'tb_cand_backend.json'), JSON.stringify(candBackend, null, 2));

console.log('Loading ThingsBoard frontend export...');
const fePath = path.join(scratchDir, 'tb_frontend_v2.json');
if (!fs.existsSync(fePath)) {
  console.log(`Frontend export fixture not found at ${fePath}, skipping comparison run.`);
  process.exit(0);
}
const feRaw = JSON.parse(fs.readFileSync(fePath, 'utf8'));
const feEnv = { ...feRaw, payload: expandTypePool(feRaw.payload) };

console.log('Comparing Base vs Candidate Backend against ThingsBoard Frontend...');
const engine = new ArtifactComparisonEngine({ requireServiceMapping: false, assessUnchanged: false });
const comparison = engine.compare(baseBackend, candBackend, [feEnv]);

console.log('\n======================================================================');
console.log('VERDICT:', comparison.verdict);
console.log('FINDINGS COUNT:', comparison.findings.length);
console.log('SCOPED ASSESSMENTS (CHANGED ENDPOINTS):', comparison.scopedChanges.assessments.length);

let totalConsumersReported = 0;
let breakAssessments = 0;

console.log('\n--- BREAKING CHANGE REPORT PER ENDPOINT ---');
for (let i = 0; i < comparison.scopedChanges.assessments.length; i++) {
  const a = comparison.scopedChanges.assessments[i];
  const consumersCount = (a.consumers || []).length;
  totalConsumersReported += consumersCount;
  if (a.status === 'BREAK_PROVED') breakAssessments++;
  console.log(`${i + 1}. [${a.status}] ${a.endpointId.slice(0, 50)}...`);
  console.log(`   └─ Downstream Frontend Consumers Affected: ${consumersCount}`);
  if (a.consumers && a.consumers.length > 0) {
    const sample = a.consumers.slice(0, 2);
    sample.forEach(c => console.log(`      • ${c.file}:${c.line} (${c.usage})`));
    if (a.consumers.length > 2) console.log(`      ... and ${a.consumers.length - 2} more call sites`);
  }
}

console.log('\n======================================================================');
console.log(`TOTAL DOWNSTREAM FRONTEND CONSUMERS VIOLATED: ${totalConsumersReported}`);
console.log(`BREAKING ENDPOINTS REPORTED: ${breakAssessments} / ${comparison.scopedChanges.assessments.length}`);
console.log('======================================================================');

fs.writeFileSync(path.join(scratchDir, 'tb_comparison_report.json'), JSON.stringify(comparison, null, 2));
