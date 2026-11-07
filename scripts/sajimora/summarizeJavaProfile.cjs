const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(process.argv[2]);
const measurements=JSON.parse(fs.readFileSync(path.join(directory,'measurements.json')));
const seconds=ns=>Math.round(Number(ns)/1e6)/1000;
const reports=measurements.map(m=>{
  if(m.exitCode!==0)throw Error(`Incomplete run: ${m.name}`);
  const java=m.capture.java;
  const parent={receiveWait:seconds(java.parent_receive_wait_ns),decode:seconds(java.parent_decode_ns),insert:seconds(java.sqlite_insert_ns),commit:seconds(java.sqlite_commit_ns),ledger:seconds(java.ledger_ns)};
  const parentMeasured=Object.values(parent).reduce((a,b)=>a+b,0);
  return {name:m.name,wallSeconds:m.elapsedMs/1000,captureSeconds:m.capture.capture.elapsed_ms/1000,javaSeconds:java.elapsed_ms/1000,
    treeRssMiB:m.sampledTreePeakRssBytes/1048576,completeFiles:java.complete_files,blockedFiles:java.blocked_files,partialFiles:java.partial_files,
    writerSynchronous:java.writer_synchronous,writerJournalMode:java.writer_journal_mode,cacheHits:java.cache_hits,
    writerCommits:java.writer_commits,batchPeakBytes:java.batch_peak_bytes,batchPeakRows:java.batch_peak_rows,batchPeakFiles:java.batch_peak_files,
    workerSeconds:{sourceLoad:seconds(java.worker_timing.source_load_ns),nativeParse:seconds(java.worker_timing.native_parse_ns),extraction:seconds(java.worker_timing.extraction_ns),emitEncodingAndBackpressure:seconds(java.worker_timing.emit_ns)},
    parentSeconds:{...parent,other:Math.round((java.elapsed_ms/1000-parentMeasured)*1000)/1000},binarySha256:m.binarySha256};
});
const output={scope:'Instrumented single runs, capture plus structural facts only. Worker and parent run concurrently: their duration columns overlap. Emission includes serialization/buffered pipe writes/backpressure; receive wait includes worker/reader/channel waiting. Parent other includes metadata re-encoding, checks, discovery queries, startup and uninstrumented overhead. Worker totals describe completed units; resource failures may omit unfinished worker timing.',reports};
fs.writeFileSync(path.join(directory,'profile-summary.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
