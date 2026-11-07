import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {JavaSealedCompilerHost} from '../../packages/analysis/src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import {JavaWireModelEngine} from '../../packages/analysis/src/sajimora/cross-language/JavaWireModelEngine';
function extract(annotated:boolean){
 const annotation=annotated?'@NotNull\n':'\n';
 const files=new Map([['Invoice.java',`package pilot;\npublic class Invoice {\n${annotation}public Total total;\n}`],['Total.java','package pilot;\npublic class Total {\npublic double amount;\n}']]);
 const host=new JavaSealedCompilerHost({trackedFiles:[...files.keys()],readTextFile:file=>files.get(file)});
 return new JavaWireModelEngine(host).extractWireType('pilot.Invoice').wireType;
}
const plain=extract(false),notNull=extract(true);assert.ok(plain&&notNull);assert.deepEqual(notNull,plain,'Response annotations must not create an unenforced runtime guarantee');
const out=resolve('rust/audit/mcp-targeted-evidence-2026-10-06');mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,'nullability.json'),JSON.stringify({plain,notNull,equal:true,explanation:'Current response extractor does not use @NotNull to remove nullable Java reference fields. Request validation is a separate path. Output annotations alone do not demonstrate validation at runtime.'},null,2));console.log(JSON.stringify({notNullChangesResponseWireType:false,plain}));
