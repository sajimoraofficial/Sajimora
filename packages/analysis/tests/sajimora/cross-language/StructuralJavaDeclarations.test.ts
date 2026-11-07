import {describe,it,expect} from 'vitest';
import {JavaTypeIRExtractor} from '../../../src/sajimora/languages/java/ir/JavaTypeIRExtractor';
import {JavaSealedCompilerHost} from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import {JavaWireModelEngine} from '../../../src/sajimora/cross-language/JavaWireModelEngine';
describe('structural Java declaration identity',()=>{
  it('distinguishes enum constants from helper fields and preserves enum methods',()=>{
    const source='package demo; enum E { A(1), B(2); static final E DEFAULT=A; private int value; E(int value){this.value=value;} public String helper(){return "x";} }';
    const cls=JavaTypeIRExtractor.parseJavaSource('E.java',source).classes[0];
    expect(cls.fields.filter(field=>field.isEnumConstant).map(field=>field.name)).toEqual(['A','B']);
    expect(cls.methods.map(method=>method.name)).toEqual(['E','helper']);
    const host=new JavaSealedCompilerHost({trackedFiles:['E.java'],readTextFile:()=>source});
    expect(new JavaWireModelEngine(host).extractWireType('demo.E')).toMatchObject({blockers:[],wireType:{kind:'ENUM',values:['A','B']}});
  });
  it('keeps custom enum JSON representations unresolved',()=>{
    const source='package demo; enum E { A; @JsonValue public String value(){return "custom";} }';
    const host=new JavaSealedCompilerHost({trackedFiles:['E.java'],readTextFile:()=>source});
    expect(new JavaWireModelEngine(host).extractWireType('demo.E').blockers.some(blocker=>blocker.message.includes('Custom enum JSON'))).toBe(true);
  });
  it('does not treat parentheses in annotation strings as signature delimiters',()=>{
    const source='class C {public String read(@Description("left (") String value){return value;}}';
    expect(JavaTypeIRExtractor.parseJavaSource('C.java',source).classes[0].methods[0].parameters).toMatchObject([{name:'value',type:{display:'String'},annotations:['Description']}]);
  });
  it('models default field getters and primitive versus boxed boolean getter names',()=>{
    const source='package demo;\n@Data\nclass C {\n private Boolean active;\n private boolean isEnabled;\n}\nclass D {\n @Getter\n private String name;\n private String hidden;\n}';
    const host=new JavaSealedCompilerHost({trackedFiles:['C.java'],readTextFile:()=>source}),engine=new JavaWireModelEngine(host);
    expect(engine.extractWireType('demo.C')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'active',nullable:true},{wireName:'enabled',nullable:false}]}});
    expect(engine.extractWireType('demo.D')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'name'}]}});
  });
  it('does not turn body calls or return statements into declarations',()=>{
    const source='package demo; class C {\n public String read(\n String value) {\n return read(value);\n }\n}';
    const cls=JavaTypeIRExtractor.parseJavaSource('C.java',source).classes[0];
    expect(cls.methods).toHaveLength(1);
    expect(cls.methods[0]).toMatchObject({name:'read',returnType:{display:'String'},lineStart:2,lineEnd:5});
  });
  it('captures compact multiple fields and methods without local variables',()=>{
    const cls=JavaTypeIRExtractor.parseJavaSource('C.java','package demo; class C {public String a,b; public int count(){int local=1; return local;} public String read(){return a;} }').classes[0];
    expect(cls.fields.map(field=>field.name)).toEqual(['a','b']);
    expect(cls.methods.map(method=>method.name)).toEqual(['count','read']);
  });
  it('recognizes method headers longer than eight lines',()=>{
    const parameters=Array.from({length:12},(_,i)=>`String p${i}`).join(',\n');
    const cls=JavaTypeIRExtractor.parseJavaSource('C.java',`class C {\n public String read(\n${parameters}\n){return p0;}\n}`).classes[0];
    expect(cls.methods[0].parameters).toHaveLength(12);
  });
  it('models generic maps with statically qualified string keys',()=>{
    const host=new JavaSealedCompilerHost({trackedFiles:['C.java'],readTextFile:()=> 'package demo; class C {public java.util.Map<String, Integer> values;}'});
    expect(new JavaWireModelEngine(host).extractWireType('demo.C')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'values',type:{kind:'MAP',keyType:{scalar:'string'},valueType:{scalar:'number'}}}]}});
  });
});
