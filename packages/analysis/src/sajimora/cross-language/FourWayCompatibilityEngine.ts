import { EndpointContract, WireType } from './CanonicalContractIR';
import { AnalysisBlocker, CompletenessAccounting, CrossLanguageFinding, CrossLanguageVerdict, buildFindingId } from './CrossLanguageContracts';
import { ConsumerImpactGraph, ConsumerSiteDetail } from './ConsumerImpactGraph';
import { matchRoutes } from './EndpointIdentity';
import { compareDirectionalWire, WireMismatch } from './DirectionalWireCompatibility';

export interface FourWayInput {
  readonly parentJavaEndpoints: readonly EndpointContract[];
  readonly candidateJavaEndpoints: readonly EndpointContract[];
  readonly parentTsRequests: readonly EndpointContract[];
  readonly candidateTsRequests: readonly EndpointContract[];
  readonly candidateConsumerGraph: ConsumerImpactGraph;
  readonly parentConsumerGraph?: ConsumerImpactGraph;
}
export interface CompatibilityAnalysisResult {
  readonly verdict: CrossLanguageVerdict;
  readonly findings: readonly CrossLanguageFinding[];
  readonly blockers: readonly AnalysisBlocker[];
  readonly completeness: CompletenessAccounting;
  readonly counts: { readonly changedEndpoints: number; readonly linkedEndpoints: number; readonly affectedConsumers: number; readonly unresolvedLinks: number };
}

function routeKey(ep: EndpointContract): string {
  return `${ep.identity.service ?? ''}|${ep.identity.httpMethod}|${JSON.stringify(ep.identity.normalizedRoute.segments.map(s => [s.text, s.regexConstraint]))}`;
}
function matches(java: EndpointContract, client: EndpointContract): boolean {
  return java.identity.httpMethod === client.identity.httpMethod &&
    (java.identity.service === null || client.identity.service === null || java.identity.service === client.identity.service) &&
    matchRoutes(java.identity.normalizedRoute, client.identity.normalizedRoute).matches;
}
function structural(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structural);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['provenance', 'name'].includes(key)).map(([key, child]) => [key, structural(child)]));
  return value;
}
function changed(a: EndpointContract | undefined, b: EndpointContract): boolean {
  return JSON.stringify(structural(a?.body)) !== JSON.stringify(structural(b.body));
}

export class FourWayCompatibilityEngine {
  public analyze(input: FourWayInput): CompatibilityAnalysisResult {
    const findings: CrossLanguageFinding[] = [];
    const blockers: AnalysisBlocker[] = [];
    const completeness = { endpointResolved: true, javaWireResolved: true, tsContractResolved: true,
      requestResolved: true, responseResolved: true, consumerTraversalComplete: true, unresolvedEvidence: [] as string[] };
    const changedKeys = new Set<string>();
    const linkedKeys = new Set<string>();
    let unresolvedLinks = 0;
    const unresolved = (dimension: Exclude<keyof CompletenessAccounting, 'unresolvedEvidence'>, message: string) => {
      completeness[dimension] = false;
      completeness.unresolvedEvidence.push(message);
    };
    const finding = (java: EndpointContract, client: EndpointContract, difference: WireMismatch, consumers: readonly ConsumerSiteDetail[] = []): CrossLanguageFinding => ({
      id: buildFindingId({ method: java.identity.httpMethod, path: java.identity.normalizedRoute.rawPath, javaFile: java.provenance.file, wirePath: difference.path }) + `:${client.provenance.file}:${client.provenance.line}`,
      endpoint: { method: java.identity.httpMethod, path: java.identity.normalizedRoute.rawPath, javaFile: java.provenance.file, line: java.provenance.line },
      wirePath: difference.path, change: { before: difference.supplied, after: `requires ${difference.accepted}` },
      typescriptClient: { file: client.provenance.file, line: client.provenance.line, expectation: difference.accepted, expectationKind: 'INFERRED_TYPE' },
      consumers, evidence: [
        ...(java.provenance.sha256 ? [{ kind: 'JAVA_SOURCE' as const, file: java.provenance.file, sha256: java.provenance.sha256, line: java.provenance.line }] : []),
        ...(client.provenance.sha256 ? [{ kind: 'TS_SOURCE' as const, file: client.provenance.file, sha256: client.provenance.sha256, line: client.provenance.line }] : []),
      ],
      repairHint: `${difference.path.startsWith('request.') ? `Java endpoint requires property '${difference.path.split('.').pop()}' compatible with ${difference.accepted}. ` : ''}Contract mismatch at '${difference.path}': ${difference.supplied}; receiver requires ${difference.accepted}.${consumers.length ? ` ${consumers.length} surviving consumer(s): ${consumers.map(c => `${c.file}:${c.line}`).join(', ')}.` : ''}`,
    });

    for (const direction of ['RESPONSE', 'REQUEST'] as const) {
      const javaEndpoints = input.candidateJavaEndpoints.filter(ep => ep.identity.direction === direction);
      const parentEndpoints = input.parentJavaEndpoints.filter(ep => ep.identity.direction === direction);
      for (const java of javaEndpoints) {
        const parents = parentEndpoints.filter(ep => routeKey(ep) === routeKey(java));
        const parent = parents[0];
        if (changed(parent, java)) changedKeys.add(routeKey(java));
        // Path variables are already conserved by route linking. Query/header acceptance needs explicit contracts.
        const clients = input.candidateTsRequests.filter(ep => (ep.identity.direction === direction || direction === 'REQUEST' && java.body === null) && matches(java, ep));
        if (!clients.length) {
          unresolvedLinks++;
          unresolved('endpointResolved', `No TypeScript client for ${direction} ${java.identity.httpMethod} ${java.identity.normalizedRoute.rawPath}`);
          unresolved(direction === 'REQUEST' ? 'requestResolved' : 'responseResolved', 'Contract has no examined client');
          continue;
        }
        for (const client of clients) {
          const parentClient = input.parentTsRequests.find(ep => ep.provenance.file === client.provenance.file && ep.identity.direction === client.identity.direction && routeKey(ep) === routeKey(client));
          if (parentClient && changed(parentClient, client)) changedKeys.add(routeKey(java));
          const competing = javaEndpoints.filter(ep => matches(ep, client));
          if (competing.length > 1 || parents.length > 1) {
            blockers.push({ code: 'AMBIGUOUS_ENDPOINT', file: java.provenance.file, message: `Multiple Java endpoints match ${client.identity.httpMethod} ${client.identity.normalizedRoute.rawPath}; explicit service identity is required` });
            unresolved('endpointResolved', 'Ambiguous backend ownership');
            unresolvedLinks++;
            continue;
          }
          linkedKeys.add(routeKey(java));
          if (direction === 'REQUEST' && (java.queryParameters.length || java.headers.length)) unresolved('requestResolved', 'Query/header acceptance is not qualified by native body extraction');
          if (java.body === null) {
            if (direction === 'RESPONSE' && client.body !== null) findings.push(finding(java, client, { path: '$', supplied: 'no response body', accepted: 'response body' }));
            continue;
          }
          if (java.body.kind === 'UNKNOWN') unresolved('javaWireResolved', `Unknown Java body at ${java.provenance.file}:${java.provenance.line}`);
          if (!client.body || client.body.kind === 'UNKNOWN') {
            unresolved('tsContractResolved', `Unknown TypeScript ${direction} body at ${client.provenance.file}:${client.provenance.line}`);
            unresolved(direction === 'REQUEST' ? 'requestResolved' : 'responseResolved', 'Client body contract is unresolved');
            continue;
          }
          const comparison = direction === 'RESPONSE'
            ? compareDirectionalWire(java.body, client.body)
            : compareDirectionalWire(client.body, java.body, 'request.$');
          const differences = new Map<string, WireMismatch>();
          for (const difference of comparison.mismatches) {
            const previous = differences.get(difference.path);
            differences.set(difference.path, previous ? { path: difference.path, supplied: `${previous.supplied}; ${difference.supplied}`, accepted: `${previous.accepted}; ${difference.accepted}` } : difference);
          }
          const clientFindings = [...differences.values()].map(difference => finding(java, client, difference));
          for (const message of comparison.unresolved) unresolved(direction === 'REQUEST' ? 'requestResolved' : 'responseResolved', message);

          // Parent contracts explain removed properties; candidate contracts determine compatibility.
          if (direction === 'RESPONSE') {
            const inspectRemoved = (before: WireType | null | undefined, after: WireType, expected: WireType, wirePath: string) => {
              if (before?.kind === 'ARRAY' && after.kind === 'ARRAY' && expected.kind === 'ARRAY') { inspectRemoved(before.elementType, after.elementType, expected.elementType, wirePath + '[*]'); return; }
              if (before?.kind !== 'OBJECT' || after.kind !== 'OBJECT' || expected.kind !== 'OBJECT') return;
              for (const property of before.properties) {
                const current = after.properties.find(p => p.wireName === property.wireName);
                const expectation = expected.properties.find(p => p.wireName === property.wireName);
                if (!current) {
                  const at = `${wirePath}.${property.wireName}`;
                  const trace = expected.name
                    ? input.candidateConsumerGraph.analyzePropertyConsumers(expected.name, property.wireName, expected.provenance?.file ?? client.provenance.file)
                    : { consumers: [], complete: false };
                  const existing = clientFindings.findIndex(f => f.wirePath === at);
                  if (trace.consumers.length) {
                    const detail = finding(java, client, { path: at, supplied: 'removed wire property', accepted: 'property still read by consumers' }, trace.consumers);
                    if (existing >= 0) clientFindings[existing] = detail; else clientFindings.push(detail);
                  }
                  // Only a coordinated removal needs a complete absence-of-stale-consumers proof.
                  if (!expectation && !trace.complete) unresolved('consumerTraversalComplete', `Consumer identity unresolved for removed ${at}`);
                } else if (expectation) inspectRemoved(property.type, current.type, expectation.type, `${wirePath}.${property.wireName}`);
              }
            };
            inspectRemoved(parent?.body, java.body, client.body, '$');
          }
          findings.push(...clientFindings);
        }
      }
    }

    for (const client of input.candidateTsRequests.filter(ep => ep.identity.direction === 'RESPONSE')) {
      if (!input.candidateJavaEndpoints.some(ep => ep.identity.direction === 'RESPONSE' && matches(ep, client)) && !input.parentJavaEndpoints.some(ep => ep.identity.direction === 'RESPONSE' && matches(ep, client))) {
        unresolvedLinks++;
        unresolved('endpointResolved', `Client ${client.provenance.file}:${client.provenance.line} has no resolved backend ownership`);
      }
    }

    const parentResponses = input.parentJavaEndpoints.filter(ep => ep.identity.direction === 'RESPONSE');
    const candidateResponses = input.candidateJavaEndpoints.filter(ep => ep.identity.direction === 'RESPONSE');
    for (const parent of parentResponses) {
      if (candidateResponses.some(ep => routeKey(ep) === routeKey(parent))) continue;
      changedKeys.add(routeKey(parent));
      const clients = input.candidateTsRequests.filter(ep => ep.identity.direction === 'RESPONSE' && matches(parent, ep));
      if (!clients.length) { unresolvedLinks++; unresolved('endpointResolved', 'Deleted endpoint has no examined candidate client'); }
      for (const client of clients) findings.push({ ...finding(parent, client, { path: 'endpoint', supplied: 'active endpoint', accepted: 'endpoint was completely deleted from Java backend' }), repairHint: `Java endpoint ${parent.identity.normalizedRoute.rawPath} was completely deleted, but ${client.provenance.file}:${client.provenance.line} still calls it.` });
    }

    findings.sort((a, b) => {
      if (a.endpoint.path !== b.endpoint.path) return a.endpoint.path < b.endpoint.path ? -1 : 1;
      if (a.wirePath !== b.wirePath) return a.wirePath < b.wirePath ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const complete = Object.entries(completeness).filter(([key]) => key !== 'unresolvedEvidence').every(([, value]) => value === true) && !blockers.length;
    return { verdict: findings.length ? 'LIKELY_VIOLATED' : complete ? 'LIKELY_PRESERVED' : 'INCONCLUSIVE', findings, blockers, completeness,
      counts: { changedEndpoints: changedKeys.size, linkedEndpoints: linkedKeys.size, affectedConsumers: new Set(findings.flatMap(f => f.consumers.map(c => `${c.file}:${c.line}:${c.column}`))).size, unresolvedLinks } };
  }
}
