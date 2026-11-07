const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const beforeDirectory=path.resolve(process.argv[2]),afterDirectory=path.resolve(process.argv[3]);
const read=directory=>JSON.parse(fs.readFileSync(path.join(directory,'measurements.json'),'utf8'));
const baseline=read(beforeDirectory),current=read(afterDirectory);
const percent=(old,next)=>Math.round((1-next/old)*10000)/100;
const reports=current.map(after=>{
  const before=baseline.find(row=>row.name===after.name);assert(before);
  for(const key of ['repository','revision','exitCode'])assert.equal(after[key],before[key]);
  assert.equal(after.exitCode,0);
  for(const key of ['java_files','captured_files','captured_bytes','discovered_files','blocked_files'])assert.equal(after.capture.capture[key],before.capture.capture[key],key);
  for(const key of ['attempted_files','complete_files','partial_files','blocked_files','declarations'])assert.equal(after.capture.java[key],before.capture.java[key],key);
  return {name:after.name,beforeWallSeconds:before.elapsedMs/1000,afterWallSeconds:after.elapsedMs/1000,wallReductionPercent:percent(before.elapsedMs,after.elapsedMs),
    beforeJavaSeconds:before.capture.java.elapsed_ms/1000,afterJavaSeconds:after.capture.java.elapsed_ms/1000,javaReductionPercent:percent(before.capture.java.elapsed_ms,after.capture.java.elapsed_ms),
    beforeTreeRssMiB:before.sampledTreePeakRssBytes/1048576,afterTreeRssMiB:after.sampledTreePeakRssBytes/1048576,
    beforeBinary:before.binarySha256,afterBinary:after.binarySha256};
});
const output={scope:'Sequential single-run before/after comparison of the same frozen capture-plus-structural-facts workload. Source/coverage counters must agree. OS filesystem cache is not cleared; this is not a randomized A/B experiment or a three-run median acceptance gate.',reports};
fs.writeFileSync(path.join(afterDirectory,'before-after.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
