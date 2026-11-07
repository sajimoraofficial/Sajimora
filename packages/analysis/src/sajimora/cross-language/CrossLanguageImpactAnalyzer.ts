import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { extractSnapshotJacksonConfig } from './JacksonSnapshotConfig';
import {
  AnalysisBlocker,
  SnapshotIdentity,
  CrossLanguageImpactReport,
  SCHEMA_VERSION,
  ASSURANCE
} from './CrossLanguageContracts';
import { EndpointContract } from './CanonicalContractIR';
import { ClientRequestContract } from './HttpClientAdapters';
import { FourWayCompatibilityEngine } from './FourWayCompatibilityEngine';
import { ConsumerImpactGraph } from './ConsumerImpactGraph';
import { TypeScriptContractParser } from './TypeScriptContractParser';
import { UrlConstantResolver } from './UrlConstantResolver';
import { MultiClientAdapter } from './HttpClientAdapters';
import { JavaSealedCompilerHost } from '../languages/java/programs/JavaSealedCompilerHost';
import { JavaWireModelEngine } from './JavaWireModelEngine';

export interface CrossLanguageAnalysisInput {
  readonly identity: SnapshotIdentity;
  readonly parentJavaFiles: ReadonlyMap<string, string>;
  readonly candidateJavaFiles: ReadonlyMap<string, string>;
  readonly parentTsFiles: ReadonlyMap<string, string>;
  readonly candidateTsFiles: ReadonlyMap<string, string>;
  readonly parentConfigFiles?: ReadonlyMap<string, string>;
  readonly candidateConfigFiles?: ReadonlyMap<string, string>;
}

function buildJavaSnapshot(files: ReadonlyMap<string, string>) {
  return {
    trackedFiles: [...files.keys()],
    readTextFile: (path: string) => files.get(path)
  };
}

export function analyzeCrossLanguageImpact(
  input: CrossLanguageAnalysisInput
): CrossLanguageImpactReport {
  let blockers: AnalysisBlocker[] = [];

  // 1. Setup Java Extractor
  const parentHost = new JavaSealedCompilerHost(buildJavaSnapshot(input.parentJavaFiles));
  const candidateHost = new JavaSealedCompilerHost(buildJavaSnapshot(input.candidateJavaFiles));
  const parentConfig = extractSnapshotJacksonConfig(new Map([...input.parentJavaFiles, ...input.parentConfigFiles ?? []]));
  const candidateConfig = extractSnapshotJacksonConfig(new Map([...input.candidateJavaFiles, ...input.candidateConfigFiles ?? []]));
  blockers.push(...parentConfig.blockers, ...candidateConfig.blockers);

  const parentJavaEndpoints: EndpointContract[] = [];
  const candidateJavaEndpoints: EndpointContract[] = [];

  const extract = (host: JavaSealedCompilerHost, files: ReadonlyMap<string, string>, naming: typeof parentConfig.naming, endpoints: EndpointContract[]) => {
    const engine = new JavaWireModelEngine(host, naming);
    const owners = new Map<string, string>();
    for (const file of host.getTrackedJavaFiles()) for (const clazz of host.getFileClasses(file)) {
      if (owners.has(clazz.fqcn)) blockers.push({ code: 'AMBIGUOUS_WIRE_PROPERTY', file, message: `Duplicate Java class ownership ${clazz.fqcn}: ${owners.get(clazz.fqcn)}, ${file}` });
      owners.set(clazz.fqcn, file);
    }
    const jaxAnnotations = ['Path', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Produces', 'Consumes'];
    for (const clazz of host.getAllClasses()) {
      const isSpring = clazz.annotations.some(a => ['RestController', 'Controller', 'RequestMapping'].includes(a));
      const isJax = clazz.annotations.some(a => jaxAnnotations.includes(a)) ||
        clazz.methods.some(m => m.annotations.some(a => jaxAnnotations.includes(a)));
      if (isJax && !isSpring) {
        blockers.push({
          code: 'UNSUPPORTED_FRAMEWORK',
          file: clazz.filePath,
          message: `JAX-RS / Jersey resource ${clazz.fqcn} detected. Sajimora supports Spring MVC controllers (@RestController, @Controller).`
        });
        continue;
      }
      if (!isSpring) continue;
      if (clazz.annotations.includes('Controller') && !clazz.annotations.includes('ResponseBody')) blockers.push({ code: 'UNSUPPORTED_SERIALIZER', file: clazz.filePath, message: 'MVC view-returning controllers require explicit response-body qualification' });
      const result = engine.extractControllerEndpoints(clazz);
      endpoints.push(...result.endpoints);
      blockers.push(...result.blockers);
    }
    for (const [file, text] of files) {
      const clean = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (/@(?:RestController|Controller)\b/.test(clean) && !endpoints.some(e => e.provenance.file === file)) blockers.push({ code: 'UNRESOLVED_ROUTE', file, message: 'Controller has no resolved endpoint contracts' });
      if (/(?:@Path\b|import\s+(?:javax|jakarta)\.ws\.rs\b)/.test(clean) && !/@(?:RestController|Controller)\b/.test(clean)) {
        if (!blockers.some(b => b.file === file && b.code === 'UNSUPPORTED_FRAMEWORK')) {
          blockers.push({
            code: 'UNSUPPORTED_FRAMEWORK',
            file,
            message: `JAX-RS / Jersey annotations detected in ${file}. Sajimora supports Spring MVC controllers (@RestController, @Controller).`
          });
        }
      }
    }
  };
  extract(parentHost, input.parentJavaFiles, parentConfig.naming, parentJavaEndpoints);
  extract(candidateHost, input.candidateJavaFiles, candidateConfig.naming, candidateJavaEndpoints);

  // 2. Setup TypeScript Extractor
  const parentResolutionFiles = new Map([...input.parentConfigFiles ?? [], ...input.parentTsFiles]);
  const candidateResolutionFiles = new Map([...input.candidateConfigFiles ?? [], ...input.candidateTsFiles]);
  const parentTsParser = new TypeScriptContractParser(parentResolutionFiles);
  const candidateTsParser = new TypeScriptContractParser(candidateResolutionFiles);
  
  const parentUrlResolver = new UrlConstantResolver(parentResolutionFiles);
  const candidateUrlResolver = new UrlConstantResolver(candidateResolutionFiles);
  
  const multiClient = new MultiClientAdapter();

  const parentTsClientRequests: ClientRequestContract[] = [];
  const candidateTsClientRequests: ClientRequestContract[] = [];

  for (const [p, content] of input.parentTsFiles.entries()) {
    const sf = ts.createSourceFile(p, content, ts.ScriptTarget.Latest, true);
    const res = multiClient.extractRequests(sf, parentUrlResolver, parentTsParser);
    parentTsClientRequests.push(...res.requests);
    blockers.push(...res.blockers);
  }

  for (const [p, content] of input.candidateTsFiles.entries()) {
    const sf = ts.createSourceFile(p, content, ts.ScriptTarget.Latest, true);
    const res = multiClient.extractRequests(sf, candidateUrlResolver, candidateTsParser);
    candidateTsClientRequests.push(...res.requests);
    blockers.push(...res.blockers);
  }

  const convertTsRequest = (req: ClientRequestContract): EndpointContract[] => {
    const endpoints: EndpointContract[] = [];
    {
      endpoints.push({
        identity: { service: null, httpMethod: req.method, normalizedRoute: req.route, direction: 'RESPONSE' },
        pathParameters: [], queryParameters: [], headers: [], body: req.expectedResponseType ?? null, provenance: req.provenance
      });
    }
    if (req.requestBodyType || ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      endpoints.push({
        identity: { service: null, httpMethod: req.method, normalizedRoute: req.route, direction: 'REQUEST' },
        pathParameters: [], queryParameters: [], headers: [], body: req.requestBodyType ?? null, provenance: req.provenance
      });
    }
    return endpoints;
  };

  const consolidate = (requests: ClientRequestContract[]) => {
    const groups = new Map<string, ClientRequestContract[]>();
    for (const request of requests) {
      const key = `${request.provenance.file}:${request.provenance.line}:${request.provenance.column}:${request.method}:${request.rawUrl}`;
      groups.set(key, [...groups.get(key) ?? [], request]);
    }
    return [...groups.values()].flatMap(group => {
      const qualified = group.some(request => request.expectedResponseType) ? group.filter(request => request.expectedResponseType) : group;
      return [...new Map(qualified.map(request => [JSON.stringify([request.expectedResponseType, request.requestBodyType]), request])).values()];
    });
  };
  const parentTsRequests = consolidate(parentTsClientRequests).flatMap(convertTsRequest);
  const candidateTsRequests = consolidate(candidateTsClientRequests).flatMap(convertTsRequest);

  // 3. Setup Graph
  const candidateGraph = new ConsumerImpactGraph(candidateResolutionFiles);
  const parentGraph = new ConsumerImpactGraph(parentResolutionFiles);

  // 4. Run FourWay Compatibility Engine
  const engine = new FourWayCompatibilityEngine();
  const analysisResult = engine.analyze({
     parentJavaEndpoints,
     candidateJavaEndpoints,
     parentTsRequests,
     candidateTsRequests,
     candidateConsumerGraph: candidateGraph,
     parentConsumerGraph: parentGraph
  });

  blockers.push(...analysisResult.blockers);

  const uniqueBlockers = Array.from(new Map(blockers.map(b => [b.code + '|' + b.message, b])).values())
    .sort((a, b) => (a.code !== b.code ? (a.code < b.code ? -1 : 1) : (a.message < b.message ? -1 : a.message > b.message ? 1 : 0)));

  const completeness = { ...analysisResult.completeness,
    javaWireResolved: analysisResult.completeness.javaWireResolved && !uniqueBlockers.some(b => /JACKSON|JAVA|LOMBOK|SERIALIZER|FRAMEWORK/.test(b.code)),
    tsContractResolved: analysisResult.completeness.tsContractResolved && !uniqueBlockers.some(b => /TS_|ZOD|VALIDATION|CLIENT/.test(b.code)),
    unresolvedEvidence: [...analysisResult.completeness.unresolvedEvidence, ...uniqueBlockers.map(b => b.message)],
  };
  const complete = Object.entries(completeness).filter(([key]) => key !== 'unresolvedEvidence').every(([, value]) => value === true) && uniqueBlockers.length === 0;
  const sourceEvidence = [...new Map([...input.parentJavaFiles, ...input.parentTsFiles, ...input.parentConfigFiles ?? [], ...input.candidateJavaFiles, ...input.candidateTsFiles, ...input.candidateConfigFiles ?? []].map(([file, text]) => {
    const sha256 = createHash('sha256').update(text).digest('hex');
    return [`${file}:${sha256}`, { kind: (file.endsWith('.java') ? 'JAVA_SOURCE' : /\.tsx?$/.test(file) ? 'TS_SOURCE' : 'CONFIG_FILE') as 'JAVA_SOURCE' | 'TS_SOURCE' | 'CONFIG_FILE', file, sha256 }];
  })).values()].sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)));
  const configFingerprint = (files: ReadonlyMap<string, string> | undefined) => createHash('sha256').update(JSON.stringify([...(files ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
  return {
    schemaVersion: SCHEMA_VERSION,
    assurance: ASSURANCE,
    verdict: analysisResult.verdict === 'LIKELY_PRESERVED' && !complete ? 'INCONCLUSIVE' : analysisResult.verdict,
    property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
    repository: input.identity,
    scope: {
      framework: 'SPRING_MVC',
      codec: 'JACKSON_NAMING_V2',
      client: 'NATIVE_HTTP_V2',
      complete,
      clientAdapters: [...new Set(candidateTsClientRequests.map(request => request.clientKind))].sort(),
      parentConfigurationFingerprint: configFingerprint(input.parentConfigFiles),
      candidateConfigurationFingerprint: configFingerprint(input.candidateConfigFiles),
      toolchainFingerprint: createHash('sha256').update(`CANONICAL_CROSS_LANGUAGE_V2\0typescript:${ts.version}`).digest('hex'),
    },
    completeness,
    findings: analysisResult.findings.map(f => ({ ...f, evidence: sourceEvidence })),
    blockers: uniqueBlockers,
    counts: {
      changedEndpoints: analysisResult.counts.changedEndpoints,
      linkedEndpoints: analysisResult.counts.linkedEndpoints,
      affectedConsumers: analysisResult.counts.affectedConsumers,
      unresolvedLinks: analysisResult.counts.unresolvedLinks
    }
  };
}
