const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);
const {DatabaseSync}=require('node:sqlite');
const cases=[['thingsboard-sample','thingsboard-java'],['thingsboard-deferred','thingsboard-java'],['thingsboard-combined','thingsboard-java'],['fineract-sample','fineract-java']];
const verified=[];
for(const [folder,repo] of cases){
  const baseline=new DatabaseSync(path.resolve(`rust/audit/java-sqlite-optimized-2026-10-04/${repo}/source-index.sqlite`),{readOnly:true});
  const capture=new DatabaseSync(path.resolve(`rust/audit/source-capture-pilot-2026-10-04-release/${repo}/source-index.sqlite`),{readOnly:true});
  baseline.exec('PRAGMA cache_size=-16384');capture.exec('PRAGMA cache_size=-16384');
  const reports=JSON.parse(fs.readFileSync(path.join(root,folder,'reports.json')));
  const expectedFacts=baseline.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');
  const baselineObligation=baseline.prepare('SELECT * FROM obligations WHERE build_id=? AND obligation_id=?');
  const captureObligation=capture.prepare('SELECT * FROM obligations WHERE build_id=? AND obligation_id=?');
  for(const report of reports){
    const db=new DatabaseSync(path.join(root,folder,`${report.case}.sqlite`),{readOnly:true});db.exec('PRAGMA cache_size=-16384');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(db.prepare('SELECT count(*) n FROM pragma_foreign_key_check').get().n,0);
    const files=baseline.prepare("SELECT * FROM files WHERE language='JAVA' ORDER BY file_id LIMIT ?").all(report.files);
    const selected=new Set(files.map(file=>file.file_id));
    const selectedFiles=new Map(files.map(file=>[file.file_id,file]));
    const actualFacts=db.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');
    let facts=0;
    for(const file of files){
      const a=expectedFacts.iterate(file.unit_id),b=actualFacts.iterate(file.unit_id);
      for(const expected of a){const next=b.next();assert(!next.done);assert.deepEqual(next.value,expected);facts++;}assert(b.next().done);
    }
    const actualFiles=db.prepare('SELECT * FROM files ORDER BY build_id,file_id').iterate();
    for(const original of capture.prepare('SELECT * FROM files ORDER BY build_id,file_id').iterate()){
      const row=actualFiles.next();assert(!row.done);assert.deepEqual(row.value,selectedFiles.get(original.file_id)||original);
    }
    assert(actualFiles.next().done);
    for(const row of db.prepare('SELECT * FROM obligations ORDER BY build_id,obligation_id').iterate()){
      const expected=(selected.has(row.file_id)?baselineObligation:captureObligation).get(row.build_id,row.obligation_id);
      assert(expected);assert.deepEqual(row,expected);
    }
    assert.equal(facts,report.facts);assert.equal(db.prepare('SELECT count(*) n FROM declarations').get().n,facts);
    assert.equal(db.prepare('SELECT count(*) n FROM obligations').get().n,capture.prepare('SELECT count(*) n FROM obligations').get().n+report.files);
    for(const index of ['declaration_lookup','declaration_short_name'])assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name=?").get(index),capture.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name=?").get(index));
    assert.equal(db.prepare("SELECT count(*) n FROM builds WHERE state='READY'").get().n,0);
    db.close();verified.push({folder,case:report.case,files:report.files,facts,status:'PASS'});
    console.log(`${folder}/${report.case}: PASS (${facts} facts)`);
  }
  baseline.close();capture.close();
}
const output={scope:'Replay facts, selected files/obligations and restored index definitions match sealed baseline exactly; unselected inventory/obligations match source capture. Integrity/foreign keys verified independently. No failure/restart/batching production qualification is implied.',verified};
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
