import type {CrossLanguageImpactReport} from './CrossLanguageContracts';
import {serializeReport} from './AgentImpactJson';

/** Customer view consumes the same sanitized versioned report. A scoped success
 * never changes the legacy verdict or hides the count of pending obligations. */
export function renderCustomerScopedReport(input:CrossLanguageImpactReport):string {
  const report=JSON.parse(serializeReport(input)) as CrossLanguageImpactReport;
  const scoped=report.scopedChanges;
  if(!scoped)return `Analysis verdict: ${report.verdict}\nScoped change assessments unavailable.\n`;
  const lines=['Scoped source-contract assessments',`${scoped.coverage.breaks} confirmed source-contract breaks; ${scoped.coverage.completed} completed checks; ${scoped.coverage.pending} pending obligations.`];
  const endpointLabel=(identity:string)=>{try{const parts=JSON.parse(identity);if(Array.isArray(parts)&&parts.length>=4&&parts.slice(0,4).every(p=>typeof p==='string'))return `${parts[1]} ${parts[2]} (${parts[0]}, ${parts[3].toLowerCase()})${parts[4]?.params?' [query conditions: '+parts[4].params.join(', ')+']':''}`;}catch{}return identity;};
  for(const assessment of scoped.assessments){
    for(const finding of assessment.conditionalFindings??[]){
      lines.push('',`Conditional operation failure: ${finding.reason}`,`  Endpoint: ${endpointLabel(assessment.endpointId)}`,`  Affected consumer: ${finding.consumer.file}:${finding.consumer.line}`);
      for(const condition of finding.preconditions)lines.push(`  Requires: ${condition}`);
      lines.push('  Universal compatibility and unresolved obligation coverage remain separate.');
    }
    if(assessment.status==='BREAK_PROVED'){
      lines.push('',`Confirmed break: ${assessment.witness?.path??assessment.endpointId} — ${assessment.witness?.reason??'required contract obligation fails'}`);
      lines.push(`  Endpoint: ${endpointLabel(assessment.endpointId)}`);
      for(const consumer of assessment.consumers)lines.push(`  Affected consumer: ${consumer.file}:${consumer.line}${consumer.propertyPath?' reads '+consumer.propertyPath:''}`);
      if(!assessment.consumers.length)lines.push('  Caller expectation is affected; downstream use evidence is incomplete.');
      lines.push(`  Checked scope: ${assessment.checkedScope.join('; ')}`);
      for(const assumption of assessment.assumptions)lines.push(`  Assumption: ${assumption}`);
    }else if(assessment.status==='COMPATIBILITY_PROVED_IN_SCOPE'){
      lines.push('',`No breaking change in checked scope: ${assessment.checkedScope.join('; ')}`,`  Endpoint: ${endpointLabel(assessment.endpointId)}`);
      for(const assumption of assessment.assumptions)lines.push(`  Assumption: ${assumption}`);
    }
    else if(assessment.status==='NOT_APPLICABLE_TO_OBLIGATION')lines.push('',`Discharged scope: ${assessment.checkedScope.join('; ')}. Other obligations remain separate.`);
    else if(assessment.status==='SOURCE_CONTRACT_INVALID')lines.push('',`Source contract invalid: ${assessment.endpointId}; ${assessment.missingEvidence.join('; ')}`);
    else if(assessment.status==='CHECK_PENDING')lines.push('',`Check pending: ${assessment.endpointId}; ${assessment.checkedScope.join('; ')}`);
    else if(assessment.status==='OBSERVED_FAILURE')lines.push('',`Observed failure: ${assessment.endpointId}; ${assessment.witness?.path??'body'} — ${assessment.witness?.reason??'recorded payload violates the checked contract'}`);
  }
  if(scoped.evidenceRequests.length)lines.push('','Evidence needed:');
  for(const request of scoped.evidenceRequests){
    lines.push(`- ${request.reason} (${request.affectedObligations.length} obligations; ${request.affectedEndpoints?.length??0} affected endpoint contracts)`);
    for(const endpoint of request.affectedEndpoints??[])lines.push(`  ${endpoint}`);
  }
  if(report.blockers.some(b=>b.code==='TOOL_FAILURE'||b.code==='FILE_READ_ERROR'))lines.push('','Extraction/tool errors remain unresolved; see the machine report for details.');
  if(!report.scope.complete&&report.blockers.length)lines.push('',`Extraction/qualification remains incomplete (${report.blockers.length} blockers). Assessment counts exclude uncaptured endpoints and consumers; zero findings is not compatibility.`);
  return lines.join('\n')+'\n';
}
