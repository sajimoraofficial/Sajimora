import {describe,it,expect} from 'vitest';
import {TypeScriptContractParser} from '../../../src/sajimora/cross-language/TypeScriptContractParser';
const parse=(text:string,name:string)=>new TypeScriptContractParser(new Map([['dto.ts',text]])).parseTypeByName(name,'dto.ts');
describe('generic semantic DTO declarations',()=>{
  it('distinguishes emitted private fields from consumer-visible members and prototype getters',()=>{
    const parser=new TypeScriptContractParser(new Map([['dto.ts','class D {constructor(public id:string,private secret:string){} get label():string{return this.id;} #hidden:string;}']]));
    const consumer=parser.parseTypeByName('D','dto.ts').wireType,producer=parser.parseProducerTypeByName('D','dto.ts').wireType;
    expect(consumer.kind==='OBJECT'&&consumer.properties.map(p=>p.wireName)).toEqual(['id','label']);
    expect(producer.kind==='OBJECT'&&producer.properties.map(p=>p.wireName)).toEqual(['id','secret']);
  });
  it('uses actual numeric enum values and discriminant literals',()=>{
    expect(parse('enum Kind {First, Second=8, Third} type R=Kind;','R').wireType).toMatchObject({kind:'ENUM',values:[0,8,9]});
    expect(parse('enum Kind {First="wire-first"} type R=Kind.First;','R').wireType).toMatchObject({kind:'LITERAL',value:'wire-first'});
  });
  it('models class fields, constructor properties and inherited members',()=>{
    const result=parse('class Base {id:string;} class Item extends Base {kind="item"; constructor(public name:string, private secret:string, readonly count:number){} static cache:string; protected internal:string;}','Item');
    expect(result.blockers).toEqual([]);
    expect(result.wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:'id'},{wireName:'kind',type:{kind:'PRIMITIVE',scalar:'string'}},{wireName:'name'},{wireName:'count'}]});
  });
  it('specializes imported generic class fields',()=>{
    const parser=new TypeScriptContractParser(new Map([['box.ts','export class Box<T> {value:T;}'],['dto.ts',"import {Box} from './box'; type Result=Box<string>;"]]));
    expect(parser.parseTypeByName('Result','dto.ts')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'value',type:{kind:'PRIMITIVE',scalar:'string'}}]}});
  });
  it.each(['Partial','Required','Readonly'])('evaluates %s over a declared DTO',utility=>{
    const result=parse(`interface D {id:string; name?:string;} type R=${utility}<D>;`,'R');
    expect(result.blockers).toEqual([]);
    if(result.wireType.kind==='OBJECT')expect(result.wireType.properties.map(p=>p.optional)).toEqual(utility==='Partial'?[true,true]:utility==='Required'?[false,false]:[false,true]);
  });
  it.each(['Pick','Omit'])('evaluates finite key selection in %s',utility=>expect(parse(`interface D {id:string; label:number;} type R=${utility}<D,"label">;`,'R').wireType).toMatchObject({kind:'OBJECT',properties:[{wireName:utility==='Pick'?'label':'id'}]}));
  it('models finite records and string dictionaries separately',()=>{
    expect(parse('type R=Record<"a"|"b",number>;','R')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'a'},{wireName:'b'}]}});
    expect(parse('type R=Record<string,number>;','R')).toMatchObject({blockers:[],wireType:{kind:'MAP',keyType:{kind:'PRIMITIVE',scalar:'string'},valueType:{kind:'PRIMITIVE',scalar:'number'}}});
  });
  it('combines disjoint object intersections',()=>expect(parse('type R={id:string}&{count:number};','R')).toMatchObject({blockers:[],wireType:{kind:'OBJECT',properties:[{wireName:'id'},{wireName:'count'}]}}));
  it('retains conflicting intersections and opaque initializers as unknown',()=>{
    expect(parse('type R={id:string}&{id:number};','R').wireType.kind).toBe('UNKNOWN');
    expect(parse('class R {value=build();}','R').blockers.length).toBeGreaterThan(0);
  });
});
