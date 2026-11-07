import type {DatabaseSync as SQLiteDatabase} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {canonicalJson} from './ContractArtifactEnvelope';
import {evidenceHash} from './ScopedEvidence';
import type {ScopedChangeResults} from './ScopedChangeAssessment';

/** One synchronous writer and short atomic publication transactions. This store
 * persists scoped obligations and evidence independently of the legacy verdict. */
export class ScopedEvidenceStore {
  private readonly db:SQLiteDatabase;
  constructor(location:string){
    let DatabaseSync:typeof import('node:sqlite')['DatabaseSync'];
    try{({DatabaseSync}=createRequire(resolve('package.json'))('node:sqlite'));}catch{throw new Error('Scoped SQLite persistence requires a Node runtime with node:sqlite; JSON/customer reporting remains available without --evidence-db');}
    if(location!==':memory:')mkdirSync(dirname(resolve(location)),{recursive:true});
    this.db=new DatabaseSync(location);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS scoped_generations (proof_key TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scoped_evidence (proof_key TEXT NOT NULL, evidence_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(proof_key,evidence_id));
      CREATE TABLE IF NOT EXISTS scoped_obligations (proof_key TEXT NOT NULL, obligation_id TEXT NOT NULL, assessment TEXT NOT NULL, PRIMARY KEY(proof_key,obligation_id));
      CREATE TABLE IF NOT EXISTS scoped_proofs (proof_key TEXT NOT NULL, obligation_id TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(proof_key,obligation_id));
      CREATE TABLE IF NOT EXISTS scoped_jobs (job_id TEXT PRIMARY KEY, proof_key TEXT NOT NULL, state TEXT NOT NULL, progress TEXT NOT NULL);`);
  }
  publish(result:ScopedChangeResults,signal?:AbortSignal):void {
    result=this.ordered(result);
    if(signal?.aborted)throw new Error('Scoped evidence publication cancelled');
    if(!result.proofKey||!result.evidenceRecords||result.evidenceVersion!=='SAJIMORA_SCOPED_EVIDENCE_V1')throw new Error('Revision-bound evidence manifest required');
    const ids=new Set(result.evidenceRecords.map(e=>e.id));
    if(ids.size!==result.evidenceRecords.length||new Set(result.assessments.map(a=>a.obligationId)).size!==result.assessments.length)throw new Error('Duplicate evidence/obligation identity');
    for(const record of result.evidenceRecords){const {id,...facts}=record;if(evidenceHash(facts)!==id)throw new Error('Evidence record integrity mismatch');}
    if(result.assessments.some(a=>a.evidenceIds.some(id=>!ids.has(id))))throw new Error('Dangling assessment evidence reference');
    const {assessments,evidenceRecords,...metadata}=result;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=this.db.prepare('SELECT manifest_hash FROM scoped_generations WHERE proof_key=?').get(result.proofKey) as {manifest_hash:string}|undefined;
      const digest=evidenceHash(result);
      if(existing&&existing.manifest_hash!==digest)throw new Error('Different results for the same proof generation; invalidate the tool/profile key');
      if(!existing){
        const evidence=this.db.prepare('INSERT INTO scoped_evidence VALUES(?,?,?)');
        for(const record of evidenceRecords){if(signal?.aborted)throw new Error('Scoped evidence publication cancelled');evidence.run(result.proofKey,record.id,canonicalJson(record));}
        const obligation=this.db.prepare('INSERT INTO scoped_obligations VALUES(?,?,?)');
        const proof=this.db.prepare('INSERT INTO scoped_proofs VALUES(?,?,?)');
        for(const assessment of assessments){
          if(signal?.aborted)throw new Error('Scoped evidence publication cancelled');
          obligation.run(result.proofKey,assessment.obligationId,canonicalJson(assessment));
          if(['BREAK_PROVED','COMPATIBILITY_PROVED_IN_SCOPE','NOT_APPLICABLE_TO_OBLIGATION'].includes(assessment.status))proof.run(result.proofKey,assessment.obligationId,canonicalJson({status:assessment.status,witness:assessment.witness??null,evidenceIds:assessment.evidenceIds,checkedScope:assessment.checkedScope,assumptions:assessment.assumptions}));
        }
        this.db.prepare('INSERT INTO scoped_generations VALUES(?,?,?)').run(result.proofKey,digest,canonicalJson(metadata));
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  read(proofKey:string):ScopedChangeResults|undefined {
    const row=this.db.prepare('SELECT metadata,manifest_hash FROM scoped_generations WHERE proof_key=?').get(proofKey) as {metadata:string;manifest_hash:string}|undefined;
    if(!row)return undefined;
    const rows=(table:string,column:string)=>this.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE proof_key=? ORDER BY ${table==='scoped_evidence'?'evidence_id':'obligation_id'}`).all(proofKey).map(row=>JSON.parse(String(row.value)));
    const result={...JSON.parse(row.metadata),evidenceRecords:rows('scoped_evidence','record'),assessments:rows('scoped_obligations','assessment')} as ScopedChangeResults;
    // Publication uses canonical ID order, so corruption and partial generations
    // cannot be returned as reusable proof.
    if(evidenceHash(this.ordered(result))!==row.manifest_hash)throw new Error('Stored evidence generation integrity mismatch');
    const expectedProofs=result.assessments.filter(a=>['BREAK_PROVED','COMPATIBILITY_PROVED_IN_SCOPE','NOT_APPLICABLE_TO_OBLIGATION'].includes(a.status)).map(a=>({status:a.status,witness:a.witness??null,evidenceIds:a.evidenceIds,checkedScope:a.checkedScope,assumptions:a.assumptions}));
    if(canonicalJson(rows('scoped_proofs','proof'))!==canonicalJson(expectedProofs))throw new Error('Stored scoped proof inventory integrity mismatch');
    return result;
  }
  private ordered(result:ScopedChangeResults):ScopedChangeResults {return {...result,assessments:[...result.assessments].sort((a,b)=>a.obligationId.localeCompare(b.obligationId)),evidenceRecords:[...(result.evidenceRecords??[])].sort((a,b)=>a.id.localeCompare(b.id))};}
  updateJob(jobId:string,proofKey:string,state:'PENDING'|'RUNNING'|'COMPLETED'|'FAILED'|'CANCELLED',progress:{completed:number;total:number;message:string}):void {
    if(!Number.isInteger(progress.completed)||!Number.isInteger(progress.total)||progress.completed<0||progress.total<progress.completed)throw new Error('Invalid scoped job progress');
    this.db.prepare('INSERT INTO scoped_jobs VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET proof_key=excluded.proof_key,state=excluded.state,progress=excluded.progress').run(jobId,proofKey,state,canonicalJson(progress));
  }
  jobs():readonly {jobId:string;proofKey:string;state:string;progress:{completed:number;total:number;message:string}}[]{return this.db.prepare('SELECT * FROM scoped_jobs ORDER BY job_id').all().map(r=>({jobId:String(r.job_id),proofKey:String(r.proof_key),state:String(r.state),progress:JSON.parse(String(r.progress))}));}
  close():void {this.db.close();}
}
