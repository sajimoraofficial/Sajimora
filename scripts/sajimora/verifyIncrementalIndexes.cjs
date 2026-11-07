const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const root=path.resolve(process.argv[2]),fixtures=JSON.parse(fs.readFileSync(path.join(root,'fixtures-v2','manifest.json')));
const read=stage=>JSON.parse(fs.readFileSync(path.join(root,stage,'measurements.json')));
const reports=[];
async function verifyGit(db,build,repo,revision){
  const child=spawn('git',['--no-replace-objects','-C',repo,'ls-tree','-r','-z','-l','--full-tree',revision],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}});
  let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-65536);});
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));});
  const get=db.prepare('SELECT path,git_object_id,git_byte_length FROM files WHERE build_id=? AND file_id=?');
  let pending=Buffer.alloc(0),fileId=0;
  for await(const bytes of child.stdout){
    pending=Buffer.concat([pending,bytes]);let end;
    while((end=pending.indexOf(0))>=0){
      const record=pending.subarray(0,end).toString('utf8');pending=pending.subarray(end+1);
      const match=/^(\d+) (\w+) ([0-9a-f]+) +([0-9]+|-)\t([\s\S]+)$/.exec(record);assert(match,record);
      assert.deepEqual({...get.get(build,++fileId)},{path:match[5],git_object_id:match[3],git_byte_length:match[4]==='-'?0:Number(match[4])});
    }
    assert(pending.length<=65536);
  }
  await completion;assert.equal(pending.length,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM files WHERE build_id=?').get(build).n,fileId);
}
function verifySources(db){
  db.exec('CREATE TEMP TABLE oid_checks AS SELECT * FROM blob_git_objects; CREATE INDEX oid_checks_hash ON oid_checks(source_sha256)');
  const chunks=db.prepare('SELECT chunk_ordinal,bytes FROM source_chunks WHERE source_sha256=? ORDER BY chunk_ordinal');
  const mappings=db.prepare('SELECT * FROM oid_checks WHERE source_sha256=?');
  let count=0;
  for(const source of db.prepare("SELECT * FROM source_blobs WHERE state='SEALED'").iterate()){
    const sha=createHash('sha256'),git1=createHash('sha1'),git256=createHash('sha256');git1.update(`blob ${source.byte_length}\0`);git256.update(`blob ${source.byte_length}\0`);
    let ordinal=0,bytes=0,lines=0,last=null;
    for(const chunk of chunks.iterate(source.source_sha256)){
      assert.equal(chunk.chunk_ordinal,ordinal++);assert(chunk.bytes.length>0&&chunk.bytes.length<=1048576);
      sha.update(chunk.bytes);git1.update(chunk.bytes);git256.update(chunk.bytes);bytes+=chunk.bytes.length;
      for(const byte of chunk.bytes)if(byte===10)lines++;last=chunk.bytes.at(-1);
    }
    if(last!==null&&last!==10)lines++;
    assert.equal(sha.digest('hex'),source.source_sha256);assert.equal(bytes,source.byte_length);assert.equal(lines,source.physical_lines);
    const oid1=git1.digest('hex'),oid256=git256.digest('hex');
    for(const mapping of mappings.iterate(source.source_sha256)){assert.equal(mapping.byte_length,bytes);assert.equal(mapping.git_object_id,mapping.git_object_id.length===40?oid1:oid256);}
    count++;
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM source_blobs WHERE state!='SEALED'").get().n,0);
  return count;
}
function compare(db,fresh,build){
  let files=0,facts=0,obligations=0;
  const targetFile=fresh.prepare('SELECT * FROM files WHERE build_id=? AND file_id=?');
  const targetUnit=fresh.prepare('SELECT * FROM parse_units WHERE unit_id=?');
  const oldUnit=db.prepare('SELECT * FROM parse_units WHERE unit_id=?');
  const aFacts=db.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');const bFacts=fresh.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');
  for(const file of db.prepare('SELECT * FROM files WHERE build_id=? ORDER BY file_id').iterate(build)){
    assert.deepEqual(file,targetFile.get(build,file.file_id));files++;
    if(file.unit_id){assert.deepEqual(oldUnit.get(file.unit_id),targetUnit.get(file.unit_id));const next=bFacts.iterate(file.unit_id);for(const fact of aFacts.iterate(file.unit_id)){const target=next.next();assert(!target.done);assert.deepEqual(fact,target.value);facts++;}assert(next.next().done);}
  }
  const next=fresh.prepare('SELECT * FROM obligations WHERE build_id=? ORDER BY obligation_id').iterate(build);
  for(const item of db.prepare('SELECT * FROM obligations WHERE build_id=? ORDER BY obligation_id').iterate(build)){const target=next.next();assert(!target.done);assert.deepEqual(item,target.value);obligations++;}assert(next.next().done);
  assert.equal(fresh.prepare('SELECT count(*) AS n FROM files WHERE build_id=?').get(build).n,files);
  return {files,facts,obligations};
}
async function main(){
  for(const stage of ['first','second']){
    const measurements=read(stage),references=read(`fresh-${stage}`);
    for(const fixture of fixtures){
      process.stdout.write(`Verifying ${stage}: ${fixture.name}\n`);
      const measured=measurements.find(item=>item.name===fixture.name),reference=references.find(item=>item.name===fixture.name);
      assert.equal(measured.exitCode,0);assert.equal(reference.exitCode,0);
      const report=measured.capture,build=report.capture.build_id;
      const db=new DatabaseSync(path.join(root,stage,fixture.name,'source-index.sqlite'),{readOnly:true});
      const fresh=new DatabaseSync(path.join(root,`fresh-${stage}`,fixture.name,'source-index.sqlite'),{readOnly:true});
      db.exec('PRAGMA cache_size=-16384; PRAGMA temp_store=FILE');fresh.exec('PRAGMA cache_size=-16384; PRAGMA temp_store=FILE');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT count(*) AS n FROM pragma_foreign_key_check').get().n,0);
      assert.deepEqual({...db.prepare('SELECT published_build_id,pending_build_id FROM index_state').get()},{published_build_id:build,pending_build_id:null});
      assert.equal(db.prepare("SELECT count(*) AS n FROM files WHERE build_id=? AND status IN ('DISCOVERED','INDEXING')").get(build).n,0);
      assert.equal(report.java.blocked_files,0);assert.equal(report.java.partial_files,0);
      assert(report.java.batch_peak_bytes<=4194304);assert(report.java.batch_peak_rows<=2000);assert(report.java.batch_peak_files<=32);
      assert.equal(report.process_tree_memory.limit_readback_bytes,256*1048576);assert(measured.sampledTreePeakRssBytes<256*1048576);
      await verifyGit(db,build,fixture.repo,fixture[stage]);const blobs=verifySources(db);const compared=compare(db,fresh,build);
      assert.equal(compared.facts,report.java.declarations);
      const changes=report.incremental;
      if(stage==='first'){
        for(const [key,value] of Object.entries({added:2,modified:1,deleted:1,renamed:1,configuration_changed:true}))assert.equal(changes[key],value,key);
        assert.equal(report.java.worker_requests,2);assert.equal(report.capture.fetched_blob_files,3);
        assert.equal(db.prepare('SELECT count(*) AS n FROM files WHERE build_id=? AND path IN (?,?)').get(build,fixture.removed,fixture.renamedFrom).n,0);
      }else{
        for(const [key,value] of Object.entries({added:0,modified:1,deleted:0,renamed:0,configuration_changed:false}))assert.equal(changes[key],value,key);
        assert.equal(report.java.worker_requests,1);assert.equal(report.capture.fetched_blob_files,1);
      }
      assert.equal(report.java.cache_hits,report.java.complete_files-report.java.worker_requests);
      const eligible=db.prepare("SELECT count(*) AS n FROM files WHERE build_id=? AND language IN ('JAVA','CONFIG','TYPESCRIPT','JAVASCRIPT')").get(build).n;
      assert.equal(changes.semantic_invalidated_files,eligible);
      assert.equal(db.prepare("SELECT count(*) AS n FROM semantic_invalidations WHERE build_id=? AND status='PENDING'").get(build).n,eligible);
      assert.equal(db.prepare('SELECT count(*) AS n FROM resolutions WHERE build_id=?').get(build).n,0);
      const base=db.prepare('SELECT base_build_id FROM incremental_builds WHERE build_id=?').get(build).base_build_id;
      assert.equal(db.prepare('SELECT state FROM builds WHERE build_id=?').get(base).state,'INCOMPLETE');
      reports.push({stage,name:fixture.name,status:'PASS',...compared,verifiedBlobs:blobs,workerRequests:report.java.worker_requests,cacheHits:report.java.cache_hits,incrementalSeconds:measured.elapsedMs/1000,freshSeconds:reference.elapsedMs/1000,treeRssMiB:measured.sampledTreePeakRssBytes/1048576,changes});
      db.close();fresh.close();
    }
  }
  const output={status:'PASS',scope:'Controlled commits on full ThingsBoard/Fineract snapshots and a 10000-file synthetic repository. Exact per-build source inventory/facts/obligations compared with independent fresh indexes. Single-run structural measurements; semantic analysis remains unimplemented and conservatively invalidated.',reports};
  fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

