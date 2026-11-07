const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const output=path.resolve(process.argv[2]);if(fs.existsSync(output))throw Error('Use a new fixture directory');fs.mkdirSync(output,{recursive:true});
const origins=[{name:'thingsboard-java',repo:process.env.THINGSBOARD_REPO||'thingsboard'},{name:'fineract-java',repo:path.resolve('artifacts/production-large-repo/holdout/fineract')},{name:'synthetic-java',repo:path.resolve('rust/audit/cold-index-milestone-2026-10-04/scale-fixture/repo')}];
const fixtures=[];
for(const origin of origins){
  const repo=path.join(output,`${origin.name}.git`);
  execFileSync('git',['clone','--bare','--shared',origin.repo,repo],{stdio:'pipe'});
  const env={...process.env,GIT_INDEX_FILE:path.join(repo,'fixture-index'),GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_AUTHOR_NAME:'Incremental fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Incremental fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  const git=(args,input)=>execFileSync('git',['--no-replace-objects','-C',repo,...args],{env,input,encoding:'utf8',maxBuffer:32*1024*1024}).trim();
  const base=git(['rev-parse','HEAD']);
  const files=git(['ls-tree','-r','--name-only',base]).split('\n').filter(file=>file.endsWith('.java'));
  const selected=[];
  for(const file of files){if(Buffer.byteLength(git(['show',`${base}:${file}`]))<32000)selected.push(file);if(selected.length===3)break;}
  if(selected.length!==3)throw Error('Need three ordinary Java files');
  const put=(file,text)=>{const oid=git(['hash-object','-w','--stdin'],text);git(['update-index','--add','--cacheinfo',`100644,${oid},${file}`]);};
  const modified=selected[0],renamedFrom=selected[1],removed=selected[2];
  const modifiedOriginal=git(['show',`${base}:${modified}`]);
  const renamedTo=`incremental-fixture/renamed/${path.posix.basename(renamedFrom)}`;
  git(['read-tree',base]);
  put(modified,`${modifiedOriginal}\nclass IncrementalFixtureChanged { int marker; }\n`);
  put('incremental-fixture/NewProbe.java','package incremental_fixture; class NewProbe { int value; }\n');
  put('incremental-fixture/config.properties','incremental.fixture=true\n');
  git(['update-index','--index-info'],`0 ${'0'.repeat(base.length)}\t${renamedFrom}\n0 ${'0'.repeat(base.length)}\t${removed}\n`);
  const renameOid=git(['rev-parse',`${base}:${renamedFrom}`]);git(['update-index','--add','--cacheinfo',`100644,${renameOid},${renamedTo}`]);
  const firstTree=git(['write-tree']);const first=git(['commit-tree',firstTree,'-p',base],`Controlled add/modify/delete/rename/config changes\n`);
  put(modified,`${modifiedOriginal}\nclass IncrementalFixtureChanged { int marker; }\nclass IncrementalFixtureSecond { String marker; }\n`);
  const second=git(['commit-tree',git(['write-tree']),'-p',first],`Controlled single Java-file change\n`);
  git(['update-ref','HEAD',second]);
  fixtures.push({name:origin.name,origin:origin.repo,repo,base,first,second,modified,renamedFrom,renamedTo,removed,scope:'Controlled local commits in isolated bare clones; original repositories unchanged.'});
  console.log(`Prepared ${origin.name}`);
}
for(const [stage,key] of [['base','base'],['first','first'],['second','second']])fs.writeFileSync(path.join(output,`jobs-${stage}.json`),JSON.stringify(fixtures.map(f=>({name:f.name,repo:f.repo,revision:f[key]})),null,2));
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(fixtures,null,2));
