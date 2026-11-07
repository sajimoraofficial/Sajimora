'use strict';
// Presentation only: never changes the underlying assessments or coverage.
function formatScopedReport(report, detail='summary', selection={}) {
  const scoped=report.scopedChanges;
  const conditionalFindings=scoped.assessments.flatMap(a=>(a.conditionalFindings||[]).map(f=>({...f,changeId:a.changeId,endpointId:a.endpointId,obligationId:a.obligationId,assessmentStatus:a.status,assumptions:a.assumptions,evidenceIds:a.evidenceIds})));
  const groups=new Map();for(const blocker of report.blockers||[]){const group=groups.get(blocker.code)||{code:blocker.code,count:0,examples:[]};group.count++;if(group.examples.length<2)group.examples.push({file:blocker.file,reason:blocker.message});groups.set(blocker.code,group);}
  const common={schemaVersion:report.schemaVersion,assurance:report.assurance,coverage:scoped.coverage,proofKey:scoped.proofKey,conditionalFindings,extraction:{complete:report.scope?.complete===true,blockerCount:report.blockers?.length||0,unresolvedFactCount:report.completeness?.unresolvedEvidence?.length||0,notice:'Assessment counts cover extracted obligations only. Missing endpoints or consumer facts are not assessed; zero findings is not a compatibility claim.'}};
  // With no assessments, expose concrete inventory gaps. Otherwise the scoped
  // assessments and their targeted missing facts remain the primary surface.
  common.extraction.evidenceRequests=scoped.assessments.length?[]:[...groups.values()].slice(0,6);common.extraction.omittedCategories=scoped.assessments.length?groups.size:Math.max(0,groups.size-6);
  if(detail==='full')return {...common,assessments:scoped.assessments,evidenceRequests:scoped.evidenceRequests,evidenceRecords:scoped.evidenceRecords,artifacts:report.artifacts,detail};
  if(detail==='evidence'){
    const matches=scoped.assessments.filter(a=>{
      if(!selection.endpoint)return true;
      if(a.endpointId===selection.endpoint)return true;
      try{return JSON.parse(a.endpointId)[2]===selection.endpoint;}catch{return false;}
    });
    const offset=selection.offset??0,limit=selection.limit??10;
    const selected=matches.slice(offset,offset+limit);
    common.conditionalFindings=conditionalFindings.filter(f=>selected.some(a=>a.obligationId===f.obligationId));
    return {...common,detail,assessments:selected.map(a=>({changeId:a.changeId,endpointId:a.endpointId,obligationId:a.obligationId,status:a.status,checkedScope:a.checkedScope,assumptions:a.assumptions,evidenceIds:a.evidenceIds,witness:a.witness,consumers:a.consumers.map(c=>({file:c.file,line:c.line,sourceSha256:c.sourceSha256,usage:c.usage,propertyPath:c.propertyPath,operation:c.operation,guards:c.guards})),missingEvidence:a.missingEvidence})),evidenceRequests:[],selection:{endpoint:selection.endpoint,matched:matches.length,offset,returned:selected.length,nextOffset:offset+selected.length<matches.length?offset+selected.length:null},omitted:{assessments:scoped.assessments.length-selected.length,evidenceRequests:scoped.evidenceRequests.length},notice:'Targeted assessment evidence; global coverage is unchanged. Missing evidence and conditional consumer usage are not a proved break or compatibility. Evidence IDs refer to the complete report; detail=full retains all proof records.'};
  }
  const breaks=scoped.assessments.filter(a=>a.status==='BREAK_PROVED');
  return {...common,detail,assessments:breaks.map(a=>({changeId:a.changeId,endpointId:a.endpointId,obligationId:a.obligationId,status:a.status,checkedScope:a.checkedScope,assumptions:a.assumptions,witness:a.witness,consumers:a.consumers.map(c=>({file:c.file,line:c.line,sourceSha256:c.sourceSha256,usage:c.usage,propertyPath:c.propertyPath,operation:c.operation})),missingEvidence:a.missingEvidence})),evidenceRequests:[],omitted:{assessments:scoped.assessments.length-breaks.length,evidenceRequests:scoped.evidenceRequests.length},notice:'Assessments include proved breaks only; conditionalFindings contain separately qualified failures and do not discharge unresolved coverage. Unresolved coverage is not compatibility. Request detail=full for all assessments, evidence requests and proof records.'};
}
module.exports={formatScopedReport};

