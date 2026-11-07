const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const output=path.resolve(process.argv[2]);
if(fs.existsSync(output))throw Error('Use a new fixture directory');
const repo=path.join(output,'repo');fs.mkdirSync(repo,{recursive:true});
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git('init');git('config','user.name','Cold index fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
let bytes=0,lines=0;
for(let file=0;file<10000;file++){
  const folder=path.join(repo,`p${Math.floor(file/100)}`);fs.mkdirSync(folder,{recursive:true});
  const source=[`package scale.p${Math.floor(file/100)};`,`class C${file} {`,'int value;','int run(int input) {'];
  while(source.length<197)source.push(`value = input + ${source.length};`);
  source.push('return value;','}','}');
  const text=source.join('\n')+'\n';
  fs.writeFileSync(path.join(folder,`C${file}.java`),text);bytes+=Buffer.byteLength(text);lines+=source.length;
}
git('add','.');git('commit','-m','Deterministic 10000-file 2000000-line cold-index stress fixture');
const revision=git('rev-parse','HEAD');
const manifest={repository:repo,revision,files:10000,physicalLines:lines,bytes,scope:'Synthetic Java structural-index scalability; assignments create AST traversal load, not extra declaration facts. Not semantic pipeline or representative production throughput.',generatorSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(output,'jobs.json'),JSON.stringify([{name:'synthetic-java',repo,revision}],null,2));
console.log(JSON.stringify(manifest,null,2));
