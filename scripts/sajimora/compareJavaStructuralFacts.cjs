// Independent streaming comparison against the current TypeScript Java extractor.
const fs=require('node:fs'), path=require('node:path'), {isDeepStrictEqual}=require('node:util');
const {DatabaseSync}=require('node:sqlite');
require('../test-runtime/windows-userinfo-shim.cjs');
require('tsx/cjs/api').register();
const {JavaTypeIRExtractor}=require('../../packages/analysis/src/sajimora/languages/java/ir/JavaTypeIRExtractor.ts');
const directory=path.resolve(process.argv[2]);
const measured=JSON.parse(fs.readFileSync(path.join(directory,'measurements.json'),'utf8'));
function clean(value){return String(value??'').replace(/\s+/g,'');}
function flags(metadata){return metadata.flags||[];}
function annotations(metadata){return (metadata.annotations||[]).map(name=>name.split('.').pop()).sort();}
function isMemberClass(fact,byOrdinal){let current=fact;while(current.parent_ordinal!==null){current=byOrdinal.get(current.parent_ordinal);if(!current)return false;if(current.kind!=='CLASS')return false;}return true;}
function rustProjection(rows){
  const byOrdinal=new Map(rows.map(f=>[f.ordinal,f]));const children=new Map();for(const row of rows){const a=children.get(row.parent_ordinal)||[];a.push(row);children.set(row.parent_ordinal,a);}
  return rows.filter(f=>f.kind==='CLASS'&&isMemberClass(f,byOrdinal)&&['class_declaration','interface_declaration','enum_declaration','record_declaration'].includes(f.metadata.syntax_kind)).map(cls=>{
    const members=children.get(cls.ordinal)||[];
    return {name:cls.qualified_name,kind:cls.metadata.syntax_kind.replace('_declaration',''),annotations:annotations(cls.metadata),fields:members.filter(f=>f.kind==='FIELD').map(f=>({name:f.name,type:clean((f.metadata.type||'')+(f.metadata.dimensions||'')),annotations:annotations(f.metadata)})).sort((a,b)=>a.name.localeCompare(b.name)),methods:members.filter(f=>['METHOD','CONSTRUCTOR'].includes(f.kind)&&f.metadata.syntax_kind!=='annotation_type_element_declaration').map(f=>({name:f.name,constructor:f.kind==='CONSTRUCTOR',type:f.kind==='CONSTRUCTOR'?'':clean(f.metadata.type),parameters:(children.get(f.ordinal)||[]).filter(p=>p.kind==='PARAMETER'&&p.metadata.parent_syntax_kind==='formal_parameters').map(p=>({name:p.name,type:clean((p.metadata.type||'')+(p.metadata.dimensions||'')+(p.metadata.syntax_kind==='spread_parameter'?'...':''))})),annotations:annotations(f.metadata)})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
function legacyProjection(classes){return classes.map(cls=>({name:cls.fqcn,kind:cls.kind,annotations:[...cls.annotations].sort(),fields:cls.fields.filter(field=>cls.kind!=='record'&&cls.kind!=='enum').map(field=>({name:field.name,type:clean(field.type.display),annotations:[...field.annotations].sort()})).sort((a,b)=>a.name.localeCompare(b.name)),methods:cls.methods.map(method=>({name:method.name,constructor:method.isConstructor,type:method.isConstructor?'':clean(method.returnType.display),parameters:method.annotations.includes('compact_constructor')?[]:method.parameters.map(p=>({name:p.name,type:clean(p.type.display)})),annotations:method.annotations.filter(a=>!a.startsWith('throws:')&&!['default','compact_constructor'].includes(a)).sort()})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})).sort((a,b)=>a.name.localeCompare(b.name));}
const reports=[];
for(const measurement of measured){
  const database=path.join(directory,measurement.name,'source-index.sqlite');const db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA cache_size=-16384');
  const chunks=db.prepare('SELECT bytes FROM source_chunks WHERE source_sha256=? ORDER BY chunk_ordinal');const declarations=db.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');
  const mismatchLog=path.join(directory,measurement.name,'structural-mismatches.jsonl');const log=fs.openSync(mismatchLog,'w');let files=0,equalFiles=0,partialFiles=0,legacyClasses=0,rustClasses=0;
  const start=Date.now();
  for(const file of db.prepare("SELECT path,source_sha256,unit_id,status FROM files WHERE language='JAVA' AND source_sha256 IS NOT NULL ORDER BY file_id").iterate()){
    files++;
    const source=Buffer.concat([...chunks.iterate(file.source_sha256)].map(row=>Buffer.from(row.bytes))).toString('utf8');
    const legacy=JavaTypeIRExtractor.parseJavaSource(file.path,source);
    const rows=[...declarations.iterate(file.unit_id)].map(row=>({...row,metadata:JSON.parse(row.facts_json)}));
    const a=rustProjection(rows),b=legacyProjection(legacy.classes);rustClasses+=a.length;legacyClasses+=b.length;
    // Enum and record implicit fields are not represented as ordinary FIELD facts.
    for(const cls of a)if(cls.kind==='enum'||cls.kind==='record')cls.fields=[];
    if(file.status!=='INDEXED')partialFiles++;
    const rustImports=rows.filter(row=>row.kind==='IMPORT').map(row=>{const raw=row.name;return {moduleSpecifier:raw.replace(/^static\s+/,''),isStatic:/^static\s+/.test(raw)};});
    const legacyImports=legacy.imports.map(row=>({moduleSpecifier:row.moduleSpecifier,isStatic:row.isStatic}));
    if(isDeepStrictEqual(a,b)&&isDeepStrictEqual(rustImports,legacyImports))equalFiles++;else fs.writeSync(log,JSON.stringify({file:file.path,status:file.status,rust:a,legacy:b,rustImports,legacyImports})+'\n');
    if(files%64===0&&global.gc)global.gc();
    if(files%1000===0)console.log(JSON.stringify({name:measurement.name,files,equalFiles,partialFiles}));
  }
  fs.closeSync(log);db.close();const report={name:measurement.name,files,equalFiles,mismatchedFiles:files-equalFiles,partialFiles,legacyClasses,rustClasses,elapsedMs:Date.now()-start,scope:'Imports, declared class/member names, field/return/parameter type spellings and annotations. Excludes enum/record synthesized fields, compact-constructor synthesized parameters, local/annotation classes and call/type resolution. Inheritance, visibility and generic-bound semantic equivalence are not compared. All omitted families remain separately accounted in the index.'};reports.push(report);
  fs.writeFileSync(path.join(directory,'structural-comparison.json'),JSON.stringify({reports},null,2));console.log(JSON.stringify(report));
}
