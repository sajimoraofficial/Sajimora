const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {isDeepStrictEqual:equal}=require('node:util'),{DatabaseSync}=require('node:sqlite');
const previous=path.resolve(process.argv[2]),current=path.resolve(process.argv[3]),reports=[];
const strict=process.argv.includes('--strict');
const requestedNames=process.argv.find(arg=>arg.startsWith('--names='));
const names=requestedNames?requestedNames.slice(8).split(','):['thingsboard-java','fineract-java'];
for(const name of names){
  assert(/^[a-z0-9-]+$/.test(name));
  const old=new DatabaseSync(path.join(previous,name,'source-index.sqlite'),{readOnly:true});
  const next=new DatabaseSync(path.join(current,name,'source-index.sqlite'),{readOnly:true});
  old.exec('PRAGMA cache_size=-16384');next.exec('PRAGMA cache_size=-16384');
  const oldFiles=old.prepare("SELECT path,source_sha256,status,unit_id FROM files WHERE language='JAVA' ORDER BY path");
  const nextFile=next.prepare('SELECT source_sha256,status,unit_id FROM files WHERE path=?');
  const columns='ordinal,parent_ordinal,kind,name,qualified_name,start_byte,end_byte,facts_json';
  const oldFacts=old.prepare(`SELECT ${columns} FROM declarations WHERE unit_id=? ORDER BY ordinal`);
  const nextFacts=next.prepare(`SELECT ${columns} FROM declarations WHERE unit_id=? ORDER BY ordinal`);
  let files=0,facts=0,commentFlagCorrections=0;
  for(const file of oldFiles.iterate()){
    const target=nextFile.get(file.path);assert(target);assert.equal(target.source_sha256,file.source_sha256);assert.equal(target.status,file.status);
    const a=[...oldFacts.iterate(file.unit_id)],b=[...nextFacts.iterate(target.unit_id)];assert.equal(a.length,b.length,file.path);
    for(let i=0;i<a.length;i++){
      const am=JSON.parse(a[i].facts_json),bm=JSON.parse(b[i].facts_json);
      if(am.flags&&!strict){const filtered=am.flags.filter(flag=>!/^\s*(?:\/\/|\/\*)/.test(flag));if(!equal(filtered,am.flags))commentFlagCorrections++;am.flags=filtered;}
      delete a[i].facts_json;delete b[i].facts_json;
      assert.deepEqual(a[i],b[i],`${file.path}:${i}`);assert.deepEqual(am,bm,`${file.path}:${i} metadata`);facts++;
    }
    files++;
  }
  assert.equal(next.prepare("SELECT count(*) n FROM files WHERE language='JAVA'").get().n,files);
  let obligations=0;
  if(strict){
    const sql='SELECT * FROM obligations ORDER BY build_id,obligation_id';
    const expected=old.prepare(sql).iterate(),actual=next.prepare(sql).iterate();
    for(const a of expected){const b=actual.next();assert(!b.done);assert.deepEqual(a,b.value,`${name} obligation ${a.obligation_id}`);obligations++;}
    assert(actual.next().done);
    const fileSql='SELECT * FROM files ORDER BY build_id,file_id';
    const oldInventory=old.prepare(fileSql).iterate(),newInventory=next.prepare(fileSql).iterate();
    for(const a of oldInventory){const b=newInventory.next();assert(!b.done);assert.deepEqual(a,b.value,`${name} inventory ${a.file_id}`);}
    assert(newInventory.next().done);
  }
  old.close();next.close();reports.push({name,files,facts,obligations,commentFlagCorrections,status:'PASS'});
}
const output={previous,current,scope:strict?'All Java facts/metadata, complete file inventory and every obligation must match exactly on the same immutable source.':'All Java fact rows compared on the same immutable source. Only comment removal from flags is allowed; spans, ownership, names and all other metadata must match.',reports};
fs.writeFileSync(path.join(current,strict?'previous-fact-comparison.json':'v2-fact-comparison.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
