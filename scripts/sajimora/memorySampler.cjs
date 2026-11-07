'use strict';
const fs=require('node:fs');const file=process.env.SAJIMORA_MEMORY_PROFILE;
if(file){let peakHeapUsed=0,peakHeapTotal=0,peakSampledRss=0;const role=process.argv.some(a=>a.endsWith('mcpServer.cjs'))?'mcp-server':process.argv.some(a=>a.endsWith('run-tsx-command.cjs'))?'checker':'other';
function sample(event='sample'){const m=process.memoryUsage();peakHeapUsed=Math.max(peakHeapUsed,m.heapUsed);peakHeapTotal=Math.max(peakHeapTotal,m.heapTotal);peakSampledRss=Math.max(peakSampledRss,m.rss);fs.appendFileSync(file,JSON.stringify({at:Date.now(),pid:process.pid,role,event,rss:m.rss,heapUsed:m.heapUsed,heapTotal:m.heapTotal,peakHeapUsed,peakHeapTotal,peakSampledRss,lifetimeMaxRssBytes:process.resourceUsage().maxRSS*1024})+'\n');}
sample('start');const timer=setInterval(sample,50);timer.unref();process.once('exit',()=>sample('exit'));}
