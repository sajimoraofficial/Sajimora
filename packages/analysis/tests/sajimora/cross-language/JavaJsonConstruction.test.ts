import {describe,it,expect} from 'vitest';
import {summarizeJavaJsonConstruction} from '../../../src/sajimora/cross-language/JavaJsonConstruction';
import {validateTypeGraph} from '../../../src/sajimora/cross-language/RecursiveWireGraph';
import {graphInclusion} from '../../../src/sajimora/cross-language/GraphInclusion';
import {declaredWireGraph} from '../../../src/sajimora/cross-language/WireTypeGraph';
import {mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';
const source=(body:string,helpers='')=>'import com.fasterxml.jackson.databind.JsonNode;import com.fasterxml.jackson.databind.node.*;class Api{JsonNode read(){'+body+'}'+helpers+'}';
function summary(body:string,helpers=''){return summarizeJavaJsonConstruction({text:source(body,helpers),file:'Api.java',method:'read',snapshot:'commit',libraryProfile:'JACKSON_TREE_2_18_POSITIVE_V1'});}
describe('source-constructed Java JSON under an explicit historical profile',()=>{
  it('recovers literal keys and a finite rejecting value from an actual tree builder',()=>{
    const result=summary('ObjectNode node=JsonNodeFactory.instance.objectNode();node.put("id","wrong");return node;');expect(result.status).toBe('CONSTRUCTED_DOMAIN');expect(validateTypeGraph(result.graph)).toBe(true);
    const expected=declaredWireGraph(mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]),'commit');expect(graphInclusion(result.graph!,expected,'body','body')).toMatchObject({status:'BREAK_PROVED',witness:{path:'$.id'}});
  });
  it('preserves alias mutations and nested JsonNode references',()=>{
    const result=summary('ObjectNode root=JsonNodeFactory.instance.objectNode();ObjectNode child=JsonNodeFactory.instance.objectNode();root.set("child",child);ObjectNode alias=child;alias.put("id",1);return root;');expect(result.status).toBe('CONSTRUCTED_DOMAIN');expect(validateTypeGraph(result.graph)).toBe(true);
    expect(JSON.stringify(result.graph)).toContain('"wireName":"id"');
  });
  it('returns the removed node instead of the mutated parent',()=>{
    const result=summary('ObjectNode node=JsonNodeFactory.instance.objectNode();node.put("id",1);return node.remove("id");');expect(graphInclusion(result.graph!,declaredWireGraph(mkPrimitiveWireType('number'),'commit'),'body','body').status).toBe('COMPATIBILITY_PROVED_IN_SCOPE');
  });
  it('allocates distinct helper instances without leaking helper-local names',()=>{
    const result=summary('ObjectNode a=make();ObjectNode b=make();a.put("id",1);return b;','ObjectNode make(){ObjectNode node=JsonNodeFactory.instance.objectNode();return node;}');expect(result.status).toBe('CONSTRUCTED_DOMAIN');
    const expected=declaredWireGraph(mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType('number'),optional:false,nullable:false,validationConstraints:[]}]),'commit');expect(graphInclusion(result.graph!,expected,'body','body').status).toBe('BREAK_PROVED');
  });
  it('keeps unknown-write, branch and numeric rounding effects as exact evidence requests',()=>{
    for(const body of ['ObjectNode n=JsonNodeFactory.instance.objectNode();unknown(n);return n;','ObjectNode n=JsonNodeFactory.instance.objectNode();if(flag)n.put("id",1);return n;','ObjectNode n=JsonNodeFactory.instance.objectNode();n.put("id",9007199254740993L);return n;'])expect(summary(body).status).toBe('EVIDENCE_REQUIRED');
  });
  it('requires a pinned profile instead of applying tree semantics to any Jackson version',()=>{
    expect(summarizeJavaJsonConstruction({text:source('return JsonNodeFactory.instance.objectNode();'),file:'Api.java',method:'read',snapshot:'commit'}).status).toBe('EVIDENCE_REQUIRED');
  });
  it('does not serialize a runtime node identity cycle as a recursive DTO language',()=>{
    const result=summary('ObjectNode n=JsonNodeFactory.instance.objectNode();n.set("self",n);return n;');expect(result.status).toBe('EVIDENCE_REQUIRED');expect(result.missingEvidence.some(reason=>reason.includes('circular'))).toBe(true);
  });
});
