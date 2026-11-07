import {describe,it,expect} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import {sealGraphArtifact} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
import {declaredWireGraph} from '../../../src/sajimora/cross-language/WireTypeGraph';
import {mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';

describe('explicit local evidence CLI',()=>{
  it('imports a pinned schema and validates one observed failure without retaining its payload',()=>{
    mkdirSync(resolve('scratch'),{recursive:true});const directory=mkdtempSync(resolve('scratch/spec09-evidence-'));
    const write=(name:string,value:unknown)=>{const file=join(directory,name);writeFileSync(file,JSON.stringify(value));return file;};
    const execute=(command:string,input:string,identity:string,contract?:string)=>{
      const output=join(directory,command+'.result.json'),args=['scripts/test-runtime/run-tsx-command.cjs','scripts/sajimora/contractEvidence.ts',command,'--in',input,'--identity',identity,'--trusted-local','--out',output];
      if(contract)args.push('--contract',contract);
      const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000});expect(run.status,run.stderr).toBe(0);return JSON.parse(readFileSync(output,'utf8'));
    };
    const scope={repositoryId:'api',revision:'commit',endpoint:'/x',method:'GET',status:200,mediaType:'application/json',codecProfile:'JACKSON_DEFAULT_V1'},schema={type:'object',required:['id'],properties:{id:{type:'number'}}};
    const schemaResult=execute('schema',write('schema.json',{version:'SAJIMORA_SCHEMA_EVIDENCE_V1',...scope,dialect:'https://json-schema.org/draft/2020-12/schema',root:'contract.json',documents:{'contract.json':{schema,sha256:createHash('sha256').update(canonicalJson(schema)).digest('hex')}}}),write('schema.scope.json',scope));
    expect(schemaResult).toMatchObject({status:'DECLARED_CONTRACT',implementationConformance:'NOT_ESTABLISHED'});
    const observedScope={endpointId:'GET /x',buildRevision:'commit',environmentProfile:'fixture',status:200,mediaType:'application/json'};
    const graph=declaredWireGraph(mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]),'commit');
    const result=execute('observation',write('observation.json',{version:'SAJIMORA_OBSERVATION_V1',...observedScope,timestamp:'2026-10-06T00:00:00Z',provenance:'seeded CLI fixture',consentScope:'LOCAL_VALIDATION',redaction:{shapeChanged:false},payload:{id:'private-fixture-value'}}),write('observation.scope.json',observedScope),write('graph.json',sealGraphArtifact(graph)));
    expect(result).toMatchObject({status:'OBSERVED_FAILURE',universalCompatibility:false,witness:{path:'$.id'}});expect(JSON.stringify(result)).not.toContain('private-fixture-value');
  },50000);
});
