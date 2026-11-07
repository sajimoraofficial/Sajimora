import {describe,it,expect} from 'vitest';
import {discoverContractObligations} from '../../../src/sajimora/cross-language/IndependentContractInventory';
import {JavaWireModelEngine} from '../../../src/sajimora/cross-language/JavaWireModelEngine';
import {JavaSealedCompilerHost} from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
function engine(files:Record<string,string>){return new JavaWireModelEngine(new JavaSealedCompilerHost({trackedFiles:Object.keys(files),readTextFile:file=>files[file]}));}
describe('integrated qualification source evidence',()=>{
  it('discovers compact Java routes independently of the wire extractor',()=>{
    const rows=discoverContractObligations(new Map([['C.java','@RestController class C { @PostMapping("/x") String save(@RequestBody String body, @RequestParam int limit){return body;} }']]),'fixture','commit');
    expect(rows.map(r=>r.kind)).toEqual(['RESPONSE','REQUEST','PARAMETER']);
    expect(new Set(rows.map(r=>r.id)).size).toBe(3);
  });
  it('counts aliased HttpClient obligations and excludes HttpHeaders lookups',()=>{
    const rows=discoverContractObligations(new Map([['c.ts',"import {HttpClient as Client,HttpHeaders} from '@angular/common/http'; class C {constructor(private http:Client,private headers:HttpHeaders){} read(){this.headers.get('x'); return this.http.get('/x');}}"]]),'fixture','commit');
    expect(rows.map(r=>r.kind)).toEqual(['REQUEST','RESPONSE','CONSUMER']);
  });
  it('retains a discovery failure for malformed source',()=>expect(discoverContractObligations(new Map([['broken.java','class X {']]),'fixture','commit').some(r=>r.kind==='DISCOVERY_FAILURE')).toBe(true));
  it('does not lose large declarations at the native parser buffer boundary',()=>{
    const text='/*'+ 'large source '.repeat(6000)+'*/\n@RestController class C { @GetMapping("/large") String read(){return "ok";} }';
    const rows=discoverContractObligations(new Map([['Large.java',text]]),'fixture','commit');
    expect(rows.map(row=>row.kind)).toEqual(['RESPONSE']);
  });
  it('instantiates Java generic DTO members without repository naming rules',()=>{
    const result=engine({'Envelope.java':'package demo;\npublic class Envelope<T> {\n public T value;\n}', 'Item.java':'package demo;\npublic class Item {\n public String id;\n}'}).extractWireType('Envelope<Item>','Item.java');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'value',type:{kind:'OBJECT',properties:[{wireName:'id'}]}}]});
  });
  it('models null omission without making primitive zero optional',()=>{
    const result=engine({'Bean.java':'package demo;\n@JsonInclude(JsonInclude.Include.NON_NULL)\npublic class Bean {\n public String name;\n public int count;\n}'}).extractWireType('demo.Bean');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'name',nullable:false,optional:true},{wireName:'count',nullable:false,optional:false}]});
  });
  it('rejects unqualified inclusion profiles',()=>{
    const result=engine({'Bean.java':'package demo;\n@JsonInclude(JsonInclude.Include.NON_DEFAULT)\npublic class Bean {\n public int count;\n}'}).extractWireType('demo.Bean');
    expect(result.blockers.some(b=>b.code==='UNSUPPORTED_JACKSON_FEATURE')).toBe(true);
  });
  it('keeps Spring parameter aliases, default requiredness and explicit defaults',()=>{
    const text='package demo;\n@RestController\npublic class C {\n @GetMapping("/x")\n public String read(@RequestParam(name="search") String q, @RequestParam(defaultValue="10") int limit, @RequestHeader(required=false) String token) {return "ok";}\n}';
    const host=new JavaSealedCompilerHost({trackedFiles:['C.java'],readTextFile:()=>text});
    const result=new JavaWireModelEngine(host).extractControllerEndpoints(host.getAllClasses()[0]);
    expect(result.blockers).toEqual([]);
    expect(result.endpoints[0]).toMatchObject({queryParameters:[{name:'search',required:true},{name:'limit',required:false}],headers:[{name:'token',required:false}]});
  });
  it('models an explicitly optional Spring request body',()=>{
    const text='package demo;\n@RestController\npublic class C {\n @PostMapping("/x")\n public String save(@RequestBody(required=false) String body) {return body;}\n}';
    const host=new JavaSealedCompilerHost({trackedFiles:['C.java'],readTextFile:()=>text});
    const result=new JavaWireModelEngine(host).extractControllerEndpoints(host.getAllClasses()[0]);
    expect(result.endpoints.find(e=>e.identity.direction==='REQUEST')?.body?.kind).toBe('OPTIONAL');
  });
});
