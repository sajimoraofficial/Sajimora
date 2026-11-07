import {createHash} from 'node:crypto';

export type ObligationKind = 'REQUEST' | 'RESPONSE' | 'PARAMETER' | 'CONSUMER' | 'DISCOVERY_FAILURE';
export interface ContractObligation {
  id: string;
  repository: string;
  revision: string;
  file: string;
  sourceSha256: string;
  line: number;
  column: number;
  family: string;
  kind: ObligationKind;
  discoveryEvidence: string;
}
export interface ObligationOutcome {
  id: string;
  status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN';
  evidence: readonly string[];
}
export interface QualificationEvidence {
  inventoryReviewed: boolean;
  consumerTraversalQualified: boolean;
  serializationQualified: boolean;
  independentHoldoutQualified: boolean;
}
export function obligationId(source: Omit<ContractObligation,'id'|'discoveryEvidence'>): string {
  return createHash('sha256').update(JSON.stringify([source.repository,source.revision,source.file.replace(/\\/g,'/'),source.sourceSha256,source.line,source.column,source.family,source.kind])).digest('hex');
}

/** Only independently discovered, source-bound obligations supply the denominator. */
export function qualifyContracts(inventory: readonly ContractObligation[], outcomes: readonly ObligationOutcome[], evidence: QualificationEvidence) {
  const blockers: string[] = [];
  const rows = new Map<string,ContractObligation>();
  for (const row of inventory) {
    if (row.id!==obligationId(row)) blockers.push(`Invalid source identity: ${row.id}`);
    if (rows.has(row.id)) blockers.push(`Duplicate inventory obligation: ${row.id}`);
    if (!row.discoveryEvidence || !/^[a-f0-9]{64}$/.test(row.sourceSha256)) blockers.push(`Unqualified discovery evidence: ${row.id}`);
    if (!row.repository||!row.revision||!row.file||!row.family||!Number.isInteger(row.line)||row.line<1||!Number.isInteger(row.column)||row.column<1) blockers.push(`Invalid discovery location: ${row.id}`);
    if(!['REQUEST','RESPONSE','PARAMETER','CONSUMER','DISCOVERY_FAILURE'].includes(row.kind))blockers.push(`Invalid obligation kind: ${row.id}`);
    if (row.kind==='DISCOVERY_FAILURE') blockers.push(`Incomplete source discovery: ${row.id}`);
    rows.set(row.id,row);
  }
  const results = new Map<string,ObligationOutcome>();
  const invalid = new Set<string>();
  for (const outcome of outcomes) {
    if (!rows.has(outcome.id)) blockers.push(`Outcome absent from inventory: ${outcome.id}`);
    if (results.has(outcome.id)) {blockers.push(`Duplicate outcome: ${outcome.id}`);invalid.add(outcome.id);}
    results.set(outcome.id,outcome);
  }
  const families: Record<string,{total:number;compatible:number;incompatible:number;unknown:number;belowFivePercent:boolean}> = Object.create(null);
  let compatible=0,incompatible=0,unknown=0;
  for (const row of rows.values()) {
    const outcome=results.get(row.id);
    let status=outcome?.status ?? 'UNKNOWN';
    if (!Array.isArray(outcome?.evidence)||!outcome.evidence.length||!outcome.evidence.every(item=>typeof item==='string'&&item.trim().length>0)||invalid.has(row.id)||row.kind==='DISCOVERY_FAILURE') status='UNKNOWN';
    if (!['COMPATIBLE','INCOMPATIBLE','UNKNOWN'].includes(status)) {blockers.push(`Invalid outcome status: ${row.id}`);status='UNKNOWN';}
    const family=families[row.family]??={total:0,compatible:0,incompatible:0,unknown:0,belowFivePercent:false};
    family.total++;
    if(status==='COMPATIBLE'){compatible++;family.compatible++;}
    else if(status==='INCOMPATIBLE'){incompatible++;family.incompatible++;}
    else {unknown++;family.unknown++;}
  }
  const total=rows.size;
  if (!total) blockers.push('Zero obligation denominator');
  for(const key of ['inventoryReviewed','consumerTraversalQualified','serializationQualified','independentHoldoutQualified'] as const) if(evidence[key]!==true)blockers.push(`Qualification evidence missing: ${key}`);
  for(const family of Object.values(families)) family.belowFivePercent=(family.incompatible+family.unknown)*100<family.total*5;
  const belowFivePercent=total>0&&(incompatible+unknown)*100<total*5;
  const perFamilyQualified=Object.values(families).every(f=>f.belowFivePercent);
  return {qualified:blockers.length===0&&belowFivePercent&&perFamilyQualified,total,compatible,incompatible,unknown,combinedPercent:total?100*(incompatible+unknown)/total:null,belowFivePercent,perFamilyQualified,families,blockers,f0Filter:false as const};
}
