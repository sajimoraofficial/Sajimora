'use strict';
const fs=require('fs'),{assessVerification}=require('./verificationEvidence.cjs');
const args=process.argv.slice(2),runs=[];let plan,current,trusted=false;
for(let i=0;i<args.length;i++){if(args[i]==='--plan')plan=args[++i];else if(args[i]==='--run')runs.push(args[++i]);else if(args[i]==='--current')current=args[++i];else if(args[i]==='--trusted-local')trusted=true;else throw Error('Unknown argument: '+args[i]);}
function read(file){if(!file||fs.statSync(file).size>20*1024*1024)throw Error('Required input file exceeds 20 MiB or is missing');return JSON.parse(fs.readFileSync(file,'utf8'));}
if(!trusted||!plan||!current)throw Error('Usage: checkVerification.cjs --plan FILE [--run FILE] --current FILE --trusted-local');
process.stdout.write(JSON.stringify(assessVerification(read(plan),runs.map(read),read(current)),null,2)+'\n');
