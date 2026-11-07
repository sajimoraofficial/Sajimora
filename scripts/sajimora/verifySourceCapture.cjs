const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const directory = path.resolve(process.argv[2]);
const rawMeasured = JSON.parse(fs.readFileSync(path.join(directory,'measurements.json'),'utf8'));
const measured = Array.isArray(rawMeasured)?rawMeasured:[rawMeasured];
const expectedJava = {'thingsboard-java':6885,'fineract-java':6918,'synthetic-java':10000};
const results = [];
for (const measurement of measured) {
  const capture = measurement.capture.capture || measurement.capture;
  assert.equal(measurement.exitCode,0);
  const database = path.join(directory,measurement.name,'source-index.sqlite');
  const db = new DatabaseSync(database,{readOnly:true});
  db.exec('PRAGMA cache_size=-16384; PRAGMA temp_store=FILE');
  // Independent verification uses a disk-backed lookup, avoiding a full files
  // scan for every blob while retaining streamed chunk hashing.
  db.exec('CREATE TEMP TABLE verified_file_oids AS SELECT source_sha256,git_object_id,git_byte_length FROM files WHERE source_sha256 IS NOT NULL; CREATE INDEX verified_oid_source ON verified_file_oids(source_sha256)');
  try {
    const scalar = sql => Object.values(db.prepare(sql).get())[0];
    assert.equal(scalar('PRAGMA integrity_check'),'ok');
    assert.equal(scalar('SELECT count(*) FROM pragma_foreign_key_check'),0);
    assert.equal(scalar('SELECT count(*) FROM files'),capture.discovered_files);
    assert.equal(scalar("SELECT count(*) FROM files WHERE language='JAVA'"),expectedJava[measurement.name]);
    assert.equal(scalar("SELECT count(*) FROM obligations WHERE status='PENDING'"),0);
    assert.equal(scalar("SELECT count(*) FROM files WHERE status IN ('DISCOVERED','INDEXING')"),0);
    assert.equal(scalar('SELECT count(*) FROM capture_staging'),0);
    assert.equal(scalar("SELECT count(*) FROM source_blobs WHERE state<>'SEALED'"),0);
    assert.equal(scalar("SELECT count(*) FROM builds WHERE state='READY'"),0);
    if(measurement.capture.java){
      if(measurement.capture.process_tree_memory){
        const memory=measurement.capture.process_tree_memory;
        assert.equal(memory.limit_readback_bytes,memory.limit_mib*1024*1024);
        assert(memory.enforcement.includes('Windows Job Object'));
      }
      const java=measurement.capture.java;
      if(java.writer_synchronous!==undefined){assert.equal(java.writer_synchronous,1);assert.equal(java.writer_journal_mode,'wal');}
      if(java.batch_peak_bytes!==undefined){assert(java.batch_peak_bytes<=4*1024*1024);assert(java.batch_peak_rows<=2000);assert(java.batch_peak_files<=32);assert(java.writer_commits>0);}
      assert.equal(scalar("SELECT count(*) FROM parse_units WHERE status='WRITING'"),0);
      assert.equal(scalar("SELECT count(*) FROM declarations d JOIN parse_units p ON p.unit_id=d.unit_id JOIN source_blobs b ON b.source_sha256=p.source_sha256 WHERE d.start_byte<0 OR d.end_byte<d.start_byte OR d.end_byte>b.byte_length"),0);
      assert.equal(scalar("SELECT count(*) FROM obligations WHERE kind='JAVA_STRUCTURAL_FACTS'"),capture.java_files);
      assert.equal(scalar("SELECT count(*) FROM obligations WHERE kind='JAVA_SYNTAX' AND status='UNKNOWN' AND reason='CALL_REFERENCE_RESOLUTION_NOT_IMPLEMENTED'"),capture.java_files);
      assert.equal(scalar("SELECT count(*) FROM files WHERE language='JAVA' AND status='INDEXED'"),java.complete_files);
    }
    const chunks = db.prepare('SELECT chunk_ordinal,bytes FROM source_chunks WHERE source_sha256=? ORDER BY chunk_ordinal');
    let verifiedBlobs=0, verifiedBytes=0;
    for (const blob of db.prepare('SELECT * FROM source_blobs').iterate()) {
      const hash = createHash('sha256'),git1=createHash('sha1'),git256=createHash('sha256');
      git1.update(`blob ${blob.byte_length}\0`);git256.update(`blob ${blob.byte_length}\0`);
      let length=0, ordinal=0, lines=0, last=null;
      for (const chunk of chunks.iterate(blob.source_sha256)) {
        assert.equal(chunk.chunk_ordinal,ordinal++);
        assert(chunk.bytes.length<=1048576);
        hash.update(chunk.bytes); length+=chunk.bytes.length;
        git1.update(chunk.bytes);git256.update(chunk.bytes);
        for (const byte of chunk.bytes) if(byte===10) lines++;
        if(chunk.bytes.length) last=chunk.bytes[chunk.bytes.length-1];
      }
      if(last!==null && last!==10) lines++;
      assert.equal(hash.digest('hex'),blob.source_sha256);
      assert.equal(length,blob.byte_length); assert.equal(lines,blob.physical_lines);
      const oid1=git1.digest('hex'),oid256=git256.digest('hex');
      for(const file of db.prepare('SELECT git_object_id,git_byte_length FROM verified_file_oids WHERE source_sha256=?').iterate(blob.source_sha256)){
        assert.equal(file.git_byte_length,length);assert.equal(file.git_object_id,file.git_object_id.length===40?oid1:oid256);
      }
      verifiedBlobs++; verifiedBytes+=length;
    }
    const languages=db.prepare('SELECT language,count(*) AS files,sum(git_byte_length) AS bytes FROM files GROUP BY language ORDER BY language').all();
    const capturedLanguages=db.prepare("SELECT language,count(*) AS files,sum(git_byte_length) AS bytes FROM files WHERE source_sha256 IS NOT NULL GROUP BY language ORDER BY language").all();
    const blockers=db.prepare("SELECT reason,count(*) AS obligations FROM obligations WHERE status='UNKNOWN' GROUP BY reason ORDER BY reason").all();
    const result={name:measurement.name,status:'PASS',verifiedBlobs,verifiedBytes,languages,capturedLanguages,blockers,databaseBytes:fs.statSync(database).size,metrics:measurement};
    results.push(result);
  } finally {db.close();}
}
fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify({status:'PASS',scope:'Independent chunk hash/line/size, inventory, source spans and obligation accounting; Java syntax semantics and whole-tree RSS enforcement are not verified.',results},null,2));
console.log(JSON.stringify(results.map(({name,status,verifiedBlobs,verifiedBytes,capturedLanguages})=>({name,status,verifiedBlobs,verifiedBytes,capturedLanguages})),null,2));
