// Source evidence for every additional projected fact; this is not semantic qualification.
const fs = require('node:fs'), path = require('node:path');
const {isDeepStrictEqual: equal} = require('node:util');
const {DatabaseSync} = require('node:sqlite');
const directory = path.resolve(process.argv[2]);
const comparison = JSON.parse(fs.readFileSync(path.join(directory,'structural-comparison.json')));
const fieldPattern = /^((?:(?:public|protected|private|static|final|volatile|transient|synchronized)\s+)*)((?:[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]*?)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|;)/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reports = [];
for (const report of comparison.reports) {
  const db = new DatabaseSync(path.join(directory,report.name,'source-index.sqlite'),{readOnly:true});
  db.exec('PRAGMA cache_size=-16384');
  const fileQuery = db.prepare('SELECT source_sha256,unit_id FROM files WHERE path=?');
  const factsQuery = db.prepare('SELECT * FROM declarations WHERE unit_id=? ORDER BY ordinal');
  const chunksQuery = db.prepare('SELECT bytes FROM source_chunks WHERE source_sha256=? ORDER BY chunk_ordinal');
  const evidence = fs.openSync(path.join(directory,report.name,'source-adjudication.jsonl'),'w');
  const result = {name:report.name,additionalFacts:0,sourceConfirmed:0,unconfirmed:0,causes:{}};
  const lines=fs.readFileSync(path.join(directory,report.name,'structural-mismatches.jsonl'),'utf8').trim();
  for(const line of lines ? lines.split('\n') : []) {
    const mismatch=JSON.parse(line), file=fileQuery.get(mismatch.file);
    const source=Buffer.concat([...chunksQuery.iterate(file.source_sha256)].map(row=>Buffer.from(row.bytes)));
    const facts=[...factsQuery.iterate(file.unit_id)].map(row=>({...row,metadata:JSON.parse(row.facts_json)}));
    const byOrdinal=new Map(facts.map(row=>[row.ordinal,row]));
    for(const cls of mismatch.rust) {
      const legacy=mismatch.legacy.find(row=>row.name===cls.name);
      const owner=facts.find(row=>row.kind==='CLASS'&&row.qualified_name===cls.name);
      const additional=[];
      if(!legacy)additional.push({kind:'CLASS',member:{name:owner.name},candidates:[owner]});
      for(const kind of ['fields','methods'])for(const member of cls[kind]) {
        if(legacy?.[kind].some(value=>equal(value,member)))continue;
        additional.push({kind:kind==='fields'?'FIELD':member.constructor?'CONSTRUCTOR':'METHOD',member,
          candidates:facts.filter(row=>row.parent_ordinal===owner.ordinal&&row.name===member.name&&row.kind===(kind==='fields'?'FIELD':member.constructor?'CONSTRUCTOR':'METHOD'))});
      }
      for(const item of additional) {
        result.additionalFacts++;
        const matched=item.candidates.find(fact=>{
          if(item.kind==='METHOD'||item.kind==='CONSTRUCTOR') {
            const parameters=facts.filter(row=>row.kind==='PARAMETER'&&row.parent_ordinal===fact.ordinal&&row.metadata.parent_syntax_kind==='formal_parameters').map(row=>({name:row.name,type:String((row.metadata.type||'')+(row.metadata.dimensions||'')+(row.metadata.syntax_kind==='spread_parameter'?'...':'')).replace(/\s+/g,'')}));
            if(!equal(parameters,item.member.parameters))return false;
          }
          const raw=source.subarray(fact.start_byte,fact.end_byte).toString('utf8');
          if(item.kind==='FIELD')return new RegExp('^'+escape(item.member.name)+'\\s*(?:\\[\\s*\\]\\s*)*(?:=|$)').test(raw);
          if(item.kind==='CLASS')return new RegExp('\\b(?:class|interface|enum|record)\\s+'+escape(item.member.name)+'\\b').test(raw);
          return new RegExp('\\b'+escape(item.member.name)+'\\s*\\(').test(raw) || (fact.metadata.syntax_kind==='compact_constructor_declaration'&&raw.includes(item.member.name));
        });
        let cause='NEEDS_REVIEW';
        let enumContext=false, ancestor=owner;
        while(ancestor){if(ancestor.metadata.syntax_kind==='enum_declaration')enumContext=true;ancestor=byOrdinal.get(ancestor.parent_ordinal);}
        if(enumContext)cause='LEGACY_ENUM_BODY_WRAPPER';
        else if(item.kind==='FIELD'&&matched){
          const m=matched.metadata, generated=`${(m.flags||[]).join(' ')} ${m.type||''}${m.dimensions||''} ${matched.name};`;
          if(!fieldPattern.test(generated))cause=(m.flags||[]).length===0?'LEGACY_FIELD_LEADING_SPACE':'LEGACY_FIELD_REGEX_REJECTION';
        }
        result.causes[cause]=(result.causes[cause]||0)+1;
        if(matched)result.sourceConfirmed++;else result.unconfirmed++;
        fs.writeSync(evidence,JSON.stringify({file:mismatch.file,className:cls.name,kind:item.kind,member:item.member,cause,
          confirmation:matched?'DECLARATION_NAME_AT_SOURCE_SPAN':'UNCONFIRMED',
          span:matched?[matched.start_byte,matched.end_byte]:null,
          line:matched?.metadata.name_line,
          type:matched?.metadata.type,flags:matched?.metadata.flags,
          sourceHeader:matched?source.subarray(matched.start_byte,Math.min(matched.end_byte,matched.start_byte+240)).toString('utf8'):null})+'\n');
      }
    }
  }
  fs.closeSync(evidence);db.close();reports.push(result);
}
const output={scope:'Every additional projected fact checked for its declaration name at immutable source spans. Cause classification uses inspected legacy extraction branches. This does not independently validate complete signatures, types or semantics; NEEDS_REVIEW stays open.',reports};
fs.writeFileSync(path.join(directory,'source-adjudication.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
