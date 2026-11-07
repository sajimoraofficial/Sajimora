import {
  ContractArtifactEnvelope,
  BackendContractPayload,
  FrontendContractPayload,
  FrontendClientContract
} from './ContractArtifactEnvelope';

import { EndpointContract, WireType, ObjectWireType, WirePropertyContract } from './CanonicalContractIR';
import {
  CrossLanguageFinding,
  BlockerCode,
  CrossLanguageVerdict,
  CodecProfile,
  AnalysisBlocker,
  CompletenessAccounting,
  CrossLanguageImpactReport,
  buildFindingId
} from './CrossLanguageContracts';
import { matchRoutes, normalizeRouteSegments } from './EndpointIdentity';
import { wireInclusion } from './WireInclusion';
import { canonicalJson } from './ContractArtifactEnvelope';
import {assessBackendChanges,ScopedChangeResults} from './ScopedChangeAssessment';

export class ArtifactVerificationEngine {
  private unresolved: string[] = [];
  private linked = new Set<string>();
  private comparisonErrors: AnalysisBlocker[] = [];
  constructor(private readonly options: { requireServiceMapping?: boolean;assessUnchanged?:boolean } = {}) {}

  public compare(
    base: ContractArtifactEnvelope,
    candidate: ContractArtifactEnvelope,
    targets: ContractArtifactEnvelope[]
  ): CrossLanguageImpactReport & {scopedChanges:ScopedChangeResults; artifacts: { base: ReturnType<ArtifactVerificationEngine['artifactRef']>; candidate: ReturnType<ArtifactVerificationEngine['artifactRef']>; targets: (ReturnType<ArtifactVerificationEngine['artifactRef']> & { applicability?: 'APPLICABLE' | 'SERVICE_MISMATCH' })[] } } {
    this.unresolved = []; this.linked.clear(); this.comparisonErrors = [];
    const findings: CrossLanguageFinding[] = [];
    const blockers: AnalysisBlocker[] = [];
    const unresolvedEvidence: string[] = [];
    
    if (base.kind !== candidate.kind || base.snapshot.repositoryId !== candidate.snapshot.repositoryId || base.snapshot.serviceId !== candidate.snapshot.serviceId) {
      blockers.push({code:'TOOL_FAILURE',message:'Base and candidate identity mismatch.'});
    }
    for (const e of [base,candidate,...targets]) {
      if (e.envelopeVersion !== base.envelopeVersion || e.reportSchemaVersion !== base.reportSchemaVersion) blockers.push({code:'TOOL_FAILURE',message:'Artifact schema mismatch.'});
      for (const b of e.completeness.blockers) blockers.push({code:b.code as BlockerCode,message:b.message,file:b.file});
    }
    for (const key of ['frameworkProfile','codecProfile','clientProfile'] as const) if (base.profile[key] !== candidate.profile[key]) blockers.push({code:'TOOL_FAILURE',message:'Unqualified extraction profile migration: '+key});
    let isEndpointResolved = base.completeness.complete && candidate.completeness.complete;

    if (!base.completeness.complete) {
      unresolvedEvidence.push(`Base artifact ${base.snapshot.candidateSnapshot} is incomplete.`);
    }
    if (!candidate.completeness.complete) {
      unresolvedEvidence.push(`Candidate artifact ${candidate.snapshot.candidateSnapshot} is incomplete.`);
    }

    if (targets.length === 0) {
      blockers.push({ code: 'TOOL_FAILURE', message: 'No targets provided for comparison.' });
      isEndpointResolved = false;
    }

    const changedEndpointsLinked = new Set<string>();
    const applicableTargets = targets.filter(t => this.isTargetApplicable(candidate, t));

    for (const target of targets) {
      if (!target.completeness.complete) {
        isEndpointResolved = false;
        unresolvedEvidence.push(`Target artifact ${target.snapshot.candidateSnapshot} is incomplete.`);
      }

      if (base.kind === 'BACKEND_CONTRACT' && candidate.kind === 'BACKEND_CONTRACT' && target.kind === 'FRONTEND_CONTRACT') {
        this.verifyBackendProducerAgainstClients(
          base,
          candidate,
          target,
          findings,
          changedEndpointsLinked
        );
      } else if (base.kind === 'FRONTEND_CONTRACT' && candidate.kind === 'FRONTEND_CONTRACT' && target.kind === 'BACKEND_CONTRACT') {
        this.verifyFrontendClientExpectations(
          base,
          candidate,
          target,
          findings
        );
      } else {
        blockers.push({ code: 'TOOL_FAILURE', message: `Mismatched artifact kinds or invalid target.` });
      }
    }

    if (base.kind === 'BACKEND_CONTRACT' && candidate.kind === 'BACKEND_CONTRACT') {
      const changedBackendEndpoints = this.getChangedBackendEndpoints(
        base.payload as BackendContractPayload,
        candidate.payload as BackendContractPayload
      );
      if (applicableTargets.length > 0 && changedBackendEndpoints.length > 0) {
        const unlinked = changedBackendEndpoints.filter(ep =>
          !changedEndpointsLinked.has(this.routeKey(ep) + '|' + ep.identity.direction)
        );
        if (unlinked.length > 0) {
          for (const ep of unlinked) {
            blockers.push({
              code: 'UNLINKED_CHANGED_ENDPOINT',
              message: `Changed endpoint ${ep.identity.httpMethod} ${ep.identity.normalizedRoute.rawPath} has no linked consumer in applicable target contracts.`
            });
          }
          isEndpointResolved = false;
        }
      }
    }

    blockers.push(...this.comparisonErrors);
    unresolvedEvidence.push(...this.unresolved);
    if (this.unresolved.length) isEndpointResolved = false;
    const coverageResolved = isEndpointResolved && this.unresolved.length === 0;
    const completeness: CompletenessAccounting = {
      endpointResolved: isEndpointResolved,
      javaWireResolved: coverageResolved,
      tsContractResolved: coverageResolved,
      requestResolved: coverageResolved,
      responseResolved: coverageResolved,
      consumerTraversalComplete: coverageResolved,
      unresolvedEvidence
    };

    const individualVerdicts = findings.map(() => 'LIKELY_VIOLATED' as CrossLanguageVerdict);
    const overallVerdict = this.resolveOverallVerdict(
      individualVerdicts.length > 0 ? individualVerdicts : ['LIKELY_PRESERVED'],
      {
        complete: isEndpointResolved && blockers.length === 0,
        unresolvedEndpoints: unresolvedEvidence,
        blockers: blockers.map(b => ({ code: b.code, message: b.message }))
      }
    );

    return {
      schemaVersion: 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1',
      assurance: 'ADVISORY_ONLY',
      verdict: overallVerdict,
      property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
      repository: {
        repositoryId: candidate.snapshot.repositoryId,
        parentCommit: candidate.snapshot.parentCommit,
        candidateSnapshot: candidate.snapshot.candidateSnapshot
      },
      scope: {
        framework: (candidate.profile.frameworkProfile || 'SPRING_MVC') as 'SPRING_MVC',
        codec: (candidate.profile.codecProfile || 'JACKSON_DEFAULT_V1') as CodecProfile,
        client: (targets[0]?.profile.clientProfile || 'STATIC_FETCH_V1') as 'STATIC_FETCH_V1',
        complete: completeness.endpointResolved && blockers.length === 0
      },
      findings,
      scopedChanges:assessBackendChanges(base,candidate,targets,{assessUnchanged:this.options.assessUnchanged}),
      artifacts: {
        base: this.artifactRef(base),
        candidate: this.artifactRef(candidate),
        targets: targets.map(e => ({
          ...this.artifactRef(e),
          applicability: this.isTargetApplicable(candidate, e) ? ('APPLICABLE' as const) : ('SERVICE_MISMATCH' as const)
        }))
      },
      blockers: blockers.map(b => ({ code: b.code as BlockerCode, message: b.message, file: b.file })),
      completeness,
      counts: {
        changedEndpoints: this.changedCount(base, candidate),
        linkedEndpoints: this.linked.size,
        affectedConsumers: findings.reduce((sum, f) => sum + f.consumers.length, 0),
        unresolvedLinks: this.unresolved.length
      }
    };
  }

  private routeKey(ep: EndpointContract): string {
    return canonicalJson([ep.identity.service,ep.identity.httpMethod,normalizeRouteSegments(ep.identity.normalizedRoute.rawPath).segments.map(s=>[s.text,s.regexConstraint??null,s.isWildcard??false])]);
  }

  private isTargetApplicable(backend: ContractArtifactEnvelope, target: ContractArtifactEnvelope): boolean {
    if (target.kind === 'FRONTEND_CONTRACT') {
      const fp = target.payload as FrontendContractPayload;
      if (this.options.requireServiceMapping) {
        return fp.clientContracts.some(c =>
          c.targetServiceId === backend.snapshot.serviceId ||
          (!c.targetServiceId && /^https?:\/\//.test(c.normalizedRoute))
        ) || target.snapshot.serviceId === backend.snapshot.serviceId;
      }
      const callsWithService = fp.clientContracts.filter(c => c.targetServiceId);
      if (callsWithService.length > 0 && callsWithService.every(c => c.targetServiceId !== backend.snapshot.serviceId)) {
        return false;
      }
      return true;
    }
    return true;
  }

  private getChangedBackendEndpoints(base: BackendContractPayload, cand: BackendContractPayload): EndpointContract[] {
    const candEntryMap = new Map(cand.endpoints.map(ep => [this.routeKey(ep) + '|' + ep.identity.direction, ep]));
    const baseEntryMap = new Map(base.endpoints.map(ep => [this.routeKey(ep) + '|' + ep.identity.direction, ep]));
    const changed: EndpointContract[] = [];

    for (const baseEp of base.endpoints) {
      const key = this.routeKey(baseEp) + '|' + baseEp.identity.direction;
      if (!candEntryMap.has(key)) {
        changed.push(baseEp);
      }
    }

    for (const candEp of cand.endpoints) {
      const key = this.routeKey(candEp) + '|' + candEp.identity.direction;
      const baseEp = baseEntryMap.get(key);
      if (!baseEp) {
        changed.push(candEp);
      } else {
        const baseSig = canonicalJson([baseEp.body, baseEp.pathParameters, baseEp.queryParameters, baseEp.headers]);
        const candSig = canonicalJson([candEp.body, candEp.pathParameters, candEp.queryParameters, candEp.headers]);
        if (baseSig !== candSig) {
          changed.push(candEp);
        }
      }
    }
    return changed;
  }

  private verifyBackendProducerAgainstClients(
    baseEnv: ContractArtifactEnvelope,
    candEnv: ContractArtifactEnvelope,
    targetEnv: ContractArtifactEnvelope,
    findings: CrossLanguageFinding[],
    changedEndpointsLinked?: Set<string>
  ): void {
    const base = baseEnv.payload as BackendContractPayload;
    const cand = candEnv.payload as BackendContractPayload;
    const tsTargets = (targetEnv.payload as FrontendContractPayload).clientContracts;
    
    if (candEnv.completeness.complete) {
      const candKeys = new Set(cand.endpoints.map(e => this.routeKey(e)));
      for (const baseEp of base.endpoints) {
        if (!candKeys.has(this.routeKey(baseEp))) {
          const activeConsumers = tsTargets.filter(ts => 
            this.clientMatches(ts, baseEp, candEnv)
          );

          if (activeConsumers.length > 0) {
            changedEndpointsLinked?.add(this.routeKey(baseEp) + '|' + baseEp.identity.direction);
          }

          for (const consumer of activeConsumers) {
            findings.push(this.makeFinding(baseEp, consumer, 'endpoint', 'active', 'deleted in java target', 'calls deleted endpoint', targetEnv));
          }
        }
      }
    }

    for (const candEp of cand.endpoints) {
      const activeConsumers = tsTargets.filter(ts => 
        this.clientMatches(ts, candEp, candEnv)
      );

      if (activeConsumers.length > 0) {
        changedEndpointsLinked?.add(this.routeKey(candEp) + '|' + candEp.identity.direction);
      }

      for (const consumer of activeConsumers) {
        this.accountClient(consumer); this.accountEndpointParameters(candEp); this.linked.add(consumer.sourceFile+':'+consumer.sourceLine+'@'+targetEnv.snapshot.candidateSnapshot);
        if (candEp.identity.direction === 'RESPONSE') {
           if (candEp.body) {
              this.compareWireTypes(candEp.body, consumer.expectedResponse, candEp, consumer, '$', findings, 'RESPONSE', targetEnv);
           } else this.compareBodylessResponse(candEp, consumer, findings, targetEnv, true);
        } else if (candEp.identity.direction === 'REQUEST') {
           if (candEp.body && !consumer.requestBody) {
             if (candEp.body.kind !== 'OPTIONAL') {
               findings.push(this.makeFinding(candEp, consumer, '$', 'absent', 'required', 'frontend missing required request body', targetEnv));
             }
           } else if (candEp.body && consumer.requestBody) {
             this.compareWireTypes(candEp.body, consumer.requestBody, candEp, consumer, '$', findings, 'REQUEST', targetEnv);
           }
        }
      }
    }

    // Fail-closed verification of client expectations against candidate backend endpoints:
    for (const consumer of tsTargets) {
      if (consumer.targetServiceId && consumer.targetServiceId !== candEnv.snapshot.serviceId) continue;
      const matched = cand.endpoints.some(e => this.clientMatches(consumer, e, candEnv));
      if (!matched) {
        if (!candEnv.completeness.complete || cand.endpoints.length === 0) {
          // Incomplete or empty backend extraction: lack of evidence must fail closed to INCONCLUSIVE (not VIOLATED or PRESERVED)
          this.unresolved.push(
            `${consumer.sourceFile}:${consumer.sourceLine}: client expectation ${consumer.httpMethod} ${consumer.normalizedRoute} has no resolved candidate backend endpoint (extraction complete=${candEnv.completeness.complete})`
          );
        } else {
          // Backend extraction was fully complete and verified, but endpoint is missing -> proven deletion
          const isBasePresent = base.endpoints.some(e => this.clientMatches(consumer, e, candEnv));
          if (isBasePresent) {
            // Already handled above in base.endpoints loop
          } else {
            findings.push(this.makeFinding(
              {
                identity: { service: candEnv.snapshot.serviceId, httpMethod: consumer.httpMethod, normalizedRoute: normalizeRouteSegments(consumer.normalizedRoute), direction: 'RESPONSE' },
                pathParameters: [], queryParameters: [], headers: [], body: { kind: 'UNKNOWN', reason: 'Missing endpoint' }, provenance: { language: 'JAVA', file: 'unknown', line: 0 }
              }, consumer, 'endpoint', 'active', 'deleted in java target', `calls missing endpoint in candidate backend target ${candEnv.snapshot.repositoryId}`, targetEnv
            ));
          }
        }
      }
    }
  }

  private verifyFrontendClientExpectations(
    baseEnv: ContractArtifactEnvelope,
    candEnv: ContractArtifactEnvelope,
    targetEnv: ContractArtifactEnvelope,
    findings: CrossLanguageFinding[]
  ): void {
    const cand = candEnv.payload as FrontendContractPayload;
    const javaTargets = (targetEnv.payload as BackendContractPayload).endpoints;

    for (const candClient of cand.clientContracts) {
      this.accountClient(candClient);
      if (candClient.targetServiceId && candClient.targetServiceId !== targetEnv.snapshot.serviceId) continue;
      if (candClient.targetApiVersion && candClient.targetApiVersion !== targetEnv.snapshot.apiVersion) {
        this.unresolved.push(candClient.sourceFile + ': target API version mismatch'); continue;
      }
      if (this.options.requireServiceMapping && !candClient.targetServiceId && !/^https?:\/\//.test(candClient.normalizedRoute)) {
        this.unresolved.push(candClient.sourceFile + ': relative route requires targetServiceId'); continue;
      }
      const unresolvedBefore = this.unresolved.length;
      const matchedJavaEps = javaTargets.filter(j =>
        this.clientMatches(candClient, j, targetEnv)
      );

      if (matchedJavaEps.length === 0 && targetEnv.completeness.complete && this.unresolved.length === unresolvedBefore) {
         findings.push(this.makeFinding(
             {
               identity: { service: null, httpMethod: candClient.httpMethod, normalizedRoute: normalizeRouteSegments(candClient.normalizedRoute), direction: 'RESPONSE' },
               pathParameters: [], queryParameters: [], headers: [], body: { kind: 'UNKNOWN', reason: 'Missing endpoint' }, provenance: { language: 'JAVA', file: 'unknown', line: 0 }
             }, candClient, 'endpoint', 'active', 'deleted in java target', `calls deleted endpoint against target ${targetEnv.snapshot.repositoryId}@${targetEnv.snapshot.candidateSnapshot}`, targetEnv));
      }

      for (const jEp of matchedJavaEps) {
        this.accountEndpointParameters(jEp);
        this.linked.add(candClient.sourceFile+':'+candClient.sourceLine+'@'+targetEnv.snapshot.candidateSnapshot);
        if (jEp.identity.direction === 'RESPONSE') {
           if (jEp.body) {
              this.compareWireTypes(jEp.body, candClient.expectedResponse, jEp, candClient, '$', findings, 'RESPONSE', targetEnv);
           } else this.compareBodylessResponse(jEp, candClient, findings, targetEnv, false);
        } else if (jEp.identity.direction === 'REQUEST') {
           if (jEp.body && !candClient.requestBody) {
             if (jEp.body.kind !== 'OPTIONAL') {
               findings.push(this.makeFinding(jEp, candClient, '$', 'absent', 'required', 'frontend missing required request body', targetEnv));
             }
           } else if (jEp.body && candClient.requestBody) {
             this.compareWireTypes(jEp.body, candClient.requestBody, jEp, candClient, '$', findings, 'REQUEST', targetEnv);
           }
        }
      }
    }
  }

  private compareWireTypes(jType: WireType, tsType: WireType, javaEp: EndpointContract, tsReq: FrontendClientContract, wirePath: string, findings: CrossLanguageFinding[], direction: 'REQUEST'|'RESPONSE', targetEnv: ContractArtifactEnvelope): void {
    const produced = direction==='RESPONSE' ? jType : tsType;
    let accepted = direction==='RESPONSE' ? tsType : jType;
    if (direction==='RESPONSE' && accepted.kind==='OBJECT' && tsReq.decoderKind==='ZOD_STRICT') accepted={...accepted,strict:true};
    for (const issue of wireInclusion(produced,accepted,direction==='REQUEST'?'request.'+wirePath:wirePath)) {
      if(issue.unresolved) this.unresolved.push(tsReq.sourceFile+':'+tsReq.sourceLine+' '+issue.path+': '+issue.reason);
      else findings.push(this.makeFinding(javaEp,tsReq,issue.path,issue.before,issue.after,issue.reason,targetEnv));
    }
  }

  private accountClient(c:FrontendClientContract):void {
    this.unresolved.push(...c.unresolvedEvidence);
    if(c.consumerTraversalComplete===false || (this.options.requireServiceMapping && c.consumerTraversalComplete !== true)) this.unresolved.push(c.sourceFile+': consumer traversal incomplete or unqualified');
  }
  private accountEndpointParameters(ep: EndpointContract): void {
    for (const [location, parameters] of [['path', ep.pathParameters], ['query', ep.queryParameters], ['header', ep.headers]] as const) {
      for (const parameter of parameters) if (parameter.required || parameter.validationConstraints?.length) {
        this.unresolved.push(`${ep.identity.httpMethod} ${ep.identity.normalizedRoute.rawPath}: ${location} parameter ${parameter.name} requires unqualified consumer evidence`);
      }
    }
  }
  private compareBodylessResponse(ep: EndpointContract, client: FrontendClientContract, findings: CrossLanguageFinding[], target: ContractArtifactEnvelope, backendChange: boolean): void {
    if (client.expectedResponse.kind === 'UNKNOWN') {
      this.unresolved.push('Bodyless response with unknown consumer expectation');
      return;
    }
    const isVoid = (type: WireType): boolean => type.kind === 'PRIMITIVE' ? type.scalar === 'void' : type.kind === 'OPTIONAL' && isVoid(type.innerType);
    if (!isVoid(client.expectedResponse)) findings.push(this.makeFinding(ep, client, '$',
      backendChange ? 'body present' : 'required response', backendChange ? 'body absent (null)' : 'body absent',
      backendChange ? 'candidate response body removed; frontend requires response' : 'backend response body absent; frontend requires response', target));
  }
  private artifactRef(e:ContractArtifactEnvelope) {return {repositoryId:e.snapshot.repositoryId, serviceId:e.snapshot.serviceId,apiVersion:e.snapshot.apiVersion,snapshot:e.snapshot.candidateSnapshot,digest:e.integrity?.sha256??null};}
  private changedCount(a:ContractArtifactEnvelope,b:ContractArtifactEnvelope):number {
    const entries=(e:ContractArtifactEnvelope):[string,string][]=>e.kind==='BACKEND_CONTRACT'?(e.payload as BackendContractPayload).endpoints.map(ep=>[this.routeKey(ep)+'|'+ep.identity.direction,canonicalJson([ep.body,ep.pathParameters,ep.queryParameters,ep.headers])]):(e.payload as FrontendContractPayload).clientContracts.map(c=>[c.sourceFile+':'+c.sourceLine,canonicalJson([c.normalizedRoute,c.requestBody,c.expectedResponse])]);
    const x=new Map(entries(a)),y=new Map(entries(b));return new Set([...x.keys(),...y.keys()].filter(k=>x.get(k)!==y.get(k))).size;
  }
  private clientMatches(c:FrontendClientContract,ep:EndpointContract,backend:ContractArtifactEnvelope):boolean {
    if(c.httpMethod.toUpperCase()!==ep.identity.httpMethod.toUpperCase()) return false;
    if(c.targetServiceId && c.targetServiceId!==backend.snapshot.serviceId) {this.unresolved.push(c.sourceFile+': target service mismatch');return false;}
    if(c.targetApiVersion && c.targetApiVersion!==backend.snapshot.apiVersion) {this.unresolved.push(c.sourceFile+': target API version mismatch');return false;}
    let path=c.normalizedRoute;
    const payload=backend.payload as BackendContractPayload;
    if(/^https?:\/\//.test(path)) {
      const base=payload.baseUrls.map(b=>b.replace(/\/$/,'')).sort((a,b)=>b.length-a.length).find(b=>path===b||path.startsWith(b+'/'));
      if(!base) {this.unresolved.push(c.sourceFile+': undeclared absolute service URL');return false;}
      path=path.slice(base.length)||'/';
    } else if(this.options.requireServiceMapping && !c.targetServiceId) {this.unresolved.push(c.sourceFile+': relative route requires targetServiceId');return false;}
    const prefix=payload.proxyPrefixes.filter(p=>p&&(path===p||path.startsWith(p+'/'))).sort((a,b)=>b.length-a.length)[0];
    if(prefix) path=path.slice(prefix.length)||'/';
    const a=normalizeRouteSegments(path.split('?')[0]),b=normalizeRouteSegments(ep.identity.normalizedRoute.rawPath);
    const match=matchRoutes(a,b);
    if(match.matches && b.segments.some((segment,i)=>segment.isWildcard || (segment.regexConstraint && segment.regexConstraint!==a.segments[i]?.regexConstraint))) this.unresolved.push(c.sourceFile+': route constraint or wildcard is unverified');
    return match.matches;
  }

  private makeFinding(
    ep: EndpointContract,
    tsReq: FrontendClientContract,
    wirePath: string,
    before: string,
    after: string,
    hint: string,
    targetEnv: ContractArtifactEnvelope
  ): CrossLanguageFinding {
    return {
      id: buildFindingId({
        method: ep.identity.httpMethod,
        path: ep.identity.normalizedRoute.rawPath,
        javaFile: ep.provenance.file,
        wirePath: canonicalJson([ep.identity.direction,wirePath,before,after,tsReq.sourceFile,tsReq.sourceLine,targetEnv.snapshot.repositoryId,targetEnv.snapshot.candidateSnapshot])
      }),
      endpoint: {
        method: ep.identity.httpMethod,
        path: ep.identity.normalizedRoute.rawPath,
        javaFile: ep.provenance.file,
        line: ep.provenance.line
      },
      wirePath,
      change: { before, after },
      typescriptClient: {
        file: tsReq.sourceFile,
        line: tsReq.sourceLine,
        expectation: `${ep.identity.httpMethod} ${ep.identity.normalizedRoute.rawPath}`,
        expectationKind: tsReq.decoderKind === 'UNKNOWN' ? 'UNKNOWN' : 'INFERRED_TYPE'
      },
      consumers: tsReq.consumers.map(c => ({ file: c.file, line: c.line, column: c.column, usage: c.usage })),
      evidence: [
        ...(ep.provenance.sha256?[{kind:'JAVA_SOURCE' as const,file:ep.provenance.file,sha256:ep.provenance.sha256,line:ep.provenance.line}]:[]),
        ...(tsReq.sourceSha256?[{kind:'TS_SOURCE' as const,file:tsReq.sourceFile,sha256:tsReq.sourceSha256,line:tsReq.sourceLine}]:[]),
        ...(targetEnv.integrity?[{kind:'MANIFEST' as const,file:'artifact:'+targetEnv.snapshot.repositoryId+'@'+targetEnv.snapshot.candidateSnapshot,sha256:targetEnv.integrity.sha256}]:[])
      ],
      repairHint: `${hint} for ${ep.identity.httpMethod} ${ep.identity.normalizedRoute.rawPath}`
    };
  }

  private resolveOverallVerdict(
    verdicts: CrossLanguageVerdict[],
    status: { complete: boolean; unresolvedEndpoints: string[]; blockers: any[] }
  ): CrossLanguageVerdict {
    if (status.blockers.some(b=>b.code==='TOOL_FAILURE'||b.code==='FILE_READ_ERROR') || verdicts.includes('ANALYSIS_ERROR')) return 'ANALYSIS_ERROR';
    if (verdicts.includes('LIKELY_VIOLATED')) return 'LIKELY_VIOLATED';
    if (!status.complete) return 'INCONCLUSIVE';
    if (verdicts.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
    return 'LIKELY_PRESERVED';
  }
}

/** Backward-compatibility aliases */
export const ArtifactComparisonEngine = ArtifactVerificationEngine;
export type ArtifactComparisonEngine = ArtifactVerificationEngine;
