import {describe,it,expect} from 'vitest';
import {operationFailure,conditionalOperationFailure} from '../../../src/sajimora/cross-language/ConsumerOperationObligations';
import {mkObjectWireType,mkPrimitiveWireType} from '../../../src/sajimora/cross-language/CanonicalContractIR';
const shape=(scalar:'number'|'string')=>mkObjectWireType([{wireName:'id',type:mkPrimitiveWireType(scalar),optional:false,nullable:false,validationConstraints:[]}]);
describe('consumer operations rather than annotation assertions',()=>{
  it('reports a new rejected branch without promoting nullable baseline coverage',()=>{
    const nullable=(type:ReturnType<typeof shape>)=>({kind:'NULLABLE' as const,innerType:type});
    const site={file:'money.ts',line:1,sourceSha256:'a'.repeat(64),usage:'value.toFixed(2)',propertyPath:'$.id.toFixed',operation:'METHOD_CALL' as const};
    expect(operationFailure(nullable(shape('number')),nullable(shape('string')),site)).toBeUndefined();
    expect(conditionalOperationFailure(nullable(shape('number')),nullable(shape('string')),site)).toMatchObject({kind:'CONDITIONAL_OPERATION_FAILURE',receiverPath:'$.id',baselineReceiverKind:'number',candidateReceiverKind:'string',universalCompatibility:false});
    expect(conditionalOperationFailure(nullable(shape('number')),nullable(shape('number')),site)).toBeUndefined();
    expect(conditionalOperationFailure(nullable(shape('string')),nullable(shape('string')),site)).toBeUndefined();
    expect(conditionalOperationFailure(nullable(shape('number')),nullable(shape('string')),{...site,guards:['conversion branch']})).toBeUndefined();
    expect(conditionalOperationFailure({kind:'UNKNOWN',reason:'missing baseline'},nullable(shape('string')),site)).toBeUndefined();
    expect(conditionalOperationFailure(shape('number'),shape('string'),site)).toBeUndefined();
  });
  it('recognizes array sort while retaining ambiguous, guarded and already-invalid receivers',()=>{
    const array={kind:'ARRAY' as const,elementType:shape('string')},object=shape('string');
    const site={file:'base-data.ts',line:26,usage:'entities.sort(compare)',propertyPath:'$.sort',operation:'METHOD_CALL' as const};
    expect(operationFailure(array,object,site)).toMatchObject({path:'$',reason:'Captured sort() call requires a array receiver'});
    expect(operationFailure({kind:'UNKNOWN',reason:'unselected handler'},object,site)).toBeUndefined();
    expect(operationFailure(object,object,site)).toBeUndefined();
    expect(operationFailure(array,object,{...site,guards:['unqualified branch']})).toBeUndefined();
  });
  it('requires an invoked rejecting method rather than a bare property read',()=>{
    const site={file:'client.ts',line:1,usage:'dto.id',propertyPath:'$.id',operation:'PROPERTY_READ' as const};
    expect(operationFailure(shape('number'),shape('string'),site)).toBeUndefined();
    expect(operationFailure(shape('number'),shape('string'),{...site,usage:'dto.id.toFixed()',propertyPath:'$.id.toFixed',operation:'METHOD_CALL'})).toMatchObject({path:'$.id'});
  });
  it('does not mistake identical length operations for an array/string runtime break',()=>{
    const site={file:'client.ts',line:1,usage:'dto.length.toFixed()',propertyPath:'$.length.toFixed',operation:'METHOD_CALL' as const};
    expect(operationFailure({kind:'ARRAY',elementType:mkPrimitiveWireType('number')},mkPrimitiveWireType('string'),site)).toBeUndefined();
  });
  it('proves a new null dereference but retains guarded or pre-existing failures separately',()=>{
    const previous=shape('number'),next={kind:'NULLABLE' as const,innerType:previous},site={file:'client.ts',line:1,usage:'dto.id',propertyPath:'$.id',operation:'PROPERTY_READ' as const};
    expect(operationFailure(previous,next,site)).toMatchObject({path:'$'});
    expect(operationFailure(previous,next,{...site,guards:['null guard']})).toBeUndefined();
    expect(operationFailure(next,next,site)).toBeUndefined();
  });
});
