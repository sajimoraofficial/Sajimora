const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const root=path.resolve(process.argv[2]),baseline=path.resolve('rust/audit/java-batched-writer-2026-10-04');
const measurements=folder=>{const raw=JSON.parse(fs.readFileSync(path.join(folder,'measurements.json'),'utf8'));return Array.isArray(raw)?raw:[raw];};
const reuse=process.argv.includes('--reuse-verified');
const run=(script,...args)=>execFileSync(process.execPath,[path.resolve('scripts/sajimora',script),...args],{encoding:'utf8',maxBuffer:1024*1024});
const groups=[];
for(let number=1;number<=3;number++){
  const folder=path.join(root,`run-${number}`);
  process.stdout.write(`Verifying full run ${number}\n`);
  if(!reuse||!fs.existsSync(path.join(folder,'verification.json')))run('verifySourceCapture.cjs',folder);
  else assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'verification.json'))).status,'PASS');
  if(!reuse||!fs.existsSync(path.join(folder,'previous-fact-comparison.json')))run('compareJavaPilotVersions.cjs',baseline,folder,'--strict');
  else {
    const saved=JSON.parse(fs.readFileSync(path.join(folder,'previous-fact-comparison.json')));
    assert.equal(saved.previous,baseline);assert.equal(saved.current,folder);
    assert(saved.scope.includes('must match exactly'));assert(saved.reports.every(report=>report.status==='PASS'));
  }
  run('summarizeJavaProfile.cjs',folder);
  groups.push(measurements(folder));
}
run('verifySourceCapture.cjs',path.join(root,'scale-run'));
const indexes=[];
for(const group of groups)for(const measured of group){
  assert.equal(measured.exitCode,0);assert.equal(measured.capture.java.blocked_files,0);assert.equal(measured.capture.java.partial_files,0);
  assert(measured.sampledTreePeakRssBytes<1024*1024*1024);
  const db=new DatabaseSync(path.join(root,`run-${groups.indexOf(group)+1}`,measured.name,'source-index.sqlite'),{readOnly:true});
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='declaration_lookup'").get().sql;
  assert(sql.includes('WHERE qualified_name IS NOT NULL'));
  const point=db.prepare("SELECT qualified_name FROM declarations WHERE qualified_name IS NOT NULL LIMIT 1").get().qualified_name;
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT unit_id,ordinal FROM declarations WHERE qualified_name=?').get(point).detail;
  assert(plan.includes('declaration_lookup'));
  const difference=db.prepare('SELECT count(*) AS n FROM (SELECT qualified_name,unit_id,ordinal FROM declarations INDEXED BY declaration_lookup WHERE qualified_name IS NOT NULL EXCEPT SELECT qualified_name,unit_id,ordinal FROM declarations NOT INDEXED WHERE qualified_name IS NOT NULL)').get().n;
  assert.equal(difference,0);
  const counts=db.prepare('SELECT count(*) AS facts,count(qualified_name) AS indexed FROM declarations NOT INDEXED').get();
  assert.equal(db.prepare('SELECT count(*) AS n FROM declarations INDEXED BY declaration_lookup WHERE qualified_name IS NOT NULL').get().n,counts.indexed);
  indexes.push({name:measured.name,run:groups.indexOf(group)+1,...counts,queryPlan:plan,status:'PASS'});db.close();
}
const median=values=>values.toSorted((a,b)=>a-b)[1];
const old=JSON.parse(fs.readFileSync(path.join(baseline,'measurements.json'),'utf8'));
const repositories=groups[0].map(initial=>{
  const samples=groups.map(group=>group.find(item=>item.name===initial.name));
  const previous=old.find(item=>item.name===initial.name);
  const wall=samples.map(item=>item.elapsedMs/1000),java=samples.map(item=>item.capture.java.elapsed_ms/1000);
  return {name:initial.name,wallSeconds:wall,medianWallSeconds:median(wall),medianJavaSeconds:median(java),baselineSingleWallSeconds:previous.elapsedMs/1000,medianReductionFromSingleBaselinePercent:Number((100*(1-median(wall)/(previous.elapsedMs/1000))).toFixed(2)),maxTreeRssMiB:Math.max(...samples.map(item=>item.sampledTreePeakRssBytes/1048576)),maxWalMiB:Math.max(...samples.map(item=>item.sampledPeakWalBytes/1048576)),binarySha256:initial.binarySha256};
});
const scale=measurements(path.join(root,'scale-run'))[0];
assert.equal(scale.capture.java.complete_files,10000);assert.equal(scale.capture.java.declarations,50000);assert.equal(scale.capture.java.blocked_files,0);
assert(scale.sampledTreePeakRssBytes<256*1024*1024);assert.equal(scale.capture.process_tree_memory.limit_readback_bytes,256*1024*1024);
const db=new DatabaseSync(path.join(root,'scale-run','synthetic-java','source-index.sqlite'),{readOnly:true});
assert.equal(db.prepare('SELECT sum(physical_lines) AS n FROM source_blobs').get().n,2000000);db.close();
const resumes=[];
for(const [fresh,resumed,names] of [['run-1','resume-run',null],['scale-run','scale-resume-run','synthetic-java']]){
  const folder=path.join(root,resumed);
  run('verifySourceCapture.cjs',folder);
  const args=[path.join(root,fresh),folder,'--strict'];if(names)args.push(`--names=${names}`);
  run('compareJavaPilotVersions.cjs',...args);
  for(const measured of measurements(folder)){
    assert.equal(measured.capture.java.cache_hits,measured.capture.java.complete_files);
    assert.equal(measured.capture.java.worker_timing.native_parse_ns,0);
    assert.equal(measured.capture.java.blocked_files,0);
    resumes.push({name:measured.name,cacheHits:measured.capture.java.cache_hits,wallSeconds:measured.elapsedMs/1000,treeRssMiB:measured.sampledTreePeakRssBytes/1048576,status:'PASS'});
  }
}
const output={status:'PASS',scope:'Three current fresh-process structural-index runs; comparison uses the previous single-run structural baseline. OS cache is not cleared. Semantic pipeline acceptance remains open.',repositories,indexes,resumes,scale:{files:10000,physicalLines:2000000,facts:50000,wallSeconds:scale.elapsedMs/1000,treeRssMiB:scale.sampledTreePeakRssBytes/1048576,privateCapMiB:256,maxWalMiB:scale.sampledPeakWalBytes/1048576}};
fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
