import * as assert from 'assert';
import * as ts from 'typescript';
import { TypeScriptContractParser } from '../../src/sajimora/cross-language/TypeScriptContractParser';
import { FetchAdapter, AxiosAdapter } from '../../src/sajimora/cross-language/HttpClientAdapters';
import { UrlConstantResolver } from '../../src/sajimora/cross-language/UrlConstantResolver';

function runTests() {
  console.log('Running TypeScriptContractParser fixes tests...');
  testZodBaseCallParsing();
  testModuleResolution();
  testAxiosFetchAdapters();
  console.log('All tests passed!');
}

function testZodBaseCallParsing() {
  const code = `
    import { z, string } from 'zod';
    const s1 = z.object({
      name: z.string(),
      age: z.number().optional(),
      email: string().min(1),
      tags: z.array(z.string())
    });
  `;
  const files = new Map([['test.ts', code]]);
  const parser = new TypeScriptContractParser(files);
  const result = parser.parseTypeByName('s1', 'test.ts');
  
  assert.strictEqual(result.blockers.length, 1, 'Should produce blocker for .min()');
  assert.strictEqual(result.blockers[0].code, 'UNSUPPORTED_VALIDATION_RULE');
  assert.strictEqual(result.wireType.kind, 'OBJECT');
  if (result.wireType.kind === 'OBJECT') {
    const props = result.wireType.properties;
    assert.strictEqual(props.length, 4);
    assert.strictEqual(props[0].type.kind, 'PRIMITIVE');
    assert.strictEqual(props[1].optional, true);
    assert.strictEqual(props[2].type.kind, 'UNKNOWN');
    assert.strictEqual(props[3].type.kind, 'ARRAY');
  }
}

function testModuleResolution() {
  const file1 = `
    export interface User { id: number; }
  `;
  const file2 = `
    import { User } from './file1';
    export interface Admin extends User { role: string; }
  `;
  const file3 = `
    import { User as AliasedUser } from './file1';
    const u: AliasedUser;
  `;
  const file4 = `
    export interface UnrelatedUser { wrong: boolean; }
  `;
  const files = new Map([
    ['src/file1.ts', file1],
    ['src/file2.ts', file2],
    ['src/file3.ts', file3],
    ['src/other/User.ts', file4],
  ]);
  const parser = new TypeScriptContractParser(files);

  const res1 = parser.parseTypeByName('User', 'src/file2.ts');
  assert.strictEqual(res1.wireType.kind, 'OBJECT');
  
  const res2 = parser.parseTypeByName('AliasedUser', 'src/file3.ts');
  assert.strictEqual(res2.wireType.kind, 'OBJECT');

  const unresolved = parser.parseTypeByName('Missing', 'src/file3.ts');
  assert.strictEqual(unresolved.wireType.kind, 'UNKNOWN');
  assert.strictEqual(unresolved.blockers.length, 1);
  assert.strictEqual(unresolved.blockers[0].code, 'UNRESOLVED_TS_TYPE');
}

function testAxiosFetchAdapters() {
  const code = `
    import axios from 'axios';
    interface MyPayload { test: number; }
    const payload: MyPayload = { test: 1 };
    
    // Fetch test
    fetch('/api/users', { method: 'POST', body: JSON.stringify(payload) });
    
    // Axios test
    axios.post('/api/users', payload);

    // Inline payload
    axios.post('/api/inline', { name: "inline" });
  `;
  const sf = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
  const files = new Map([['test.ts', code]]);
  const parser = new TypeScriptContractParser(files);
  const resolver = new UrlConstantResolver(files);

  const fetchAdapter = new FetchAdapter();
  const res1 = fetchAdapter.extractRequests(sf, resolver, parser);
  assert.strictEqual(res1.requests.length, 1);
  assert.strictEqual(res1.requests[0].requestBodyType?.kind, 'OBJECT');

  const axiosAdapter = new AxiosAdapter();
  const res2 = axiosAdapter.extractRequests(sf, resolver, parser);
  console.log(JSON.stringify(res2.requests[1], null, 2));
  assert.strictEqual(res2.requests.length, 2);
  assert.strictEqual(res2.requests[0].requestBodyType?.kind, 'OBJECT');
  assert.strictEqual(res2.requests[1].requestBodyType?.kind, 'OBJECT');
}

function testConstArrayTupleIndexedAccess() {
  const code = `
    export const cssUnits = ['px', 'em', '%'] as const;
    type cssUnitTuple = typeof cssUnits;
    export type cssUnit = cssUnitTuple[number];
    export interface WidgetSettings {
      unit: cssUnit;
    }
  `;
  const files = new Map([['models.ts', code]]);
  const parser = new TypeScriptContractParser(files);
  const result = parser.parseTypeByName('WidgetSettings', 'models.ts');

  assert.strictEqual(result.blockers.length, 0, 'Should have zero blockers for tuple indexed access');
  assert.strictEqual(result.wireType.kind, 'OBJECT');
  if (result.wireType.kind === 'OBJECT') {
    const unitProp = result.wireType.properties.find(p => p.wireName === 'unit');
    assert.ok(unitProp, 'Should find property unit');
    assert.strictEqual(unitProp.type.kind, 'UNION');
    if (unitProp.type.kind === 'UNION') {
      assert.strictEqual(unitProp.type.types.length, 3);
      assert.deepStrictEqual(unitProp.type.types.map((t: any) => t.value), ['px', 'em', '%']);
    }
  }
}

function testMutableArrayInfersPrimitiveArrayNotLiteralUnion() {
  const code = `
    export const values = ['px', 'em'];
    export type ValuesType = typeof values;
    export type ValueElem = ValuesType[number];
    export type FirstElem = ValuesType[0];
  `;
  const files = new Map([['test.ts', code]]);
  const parser = new TypeScriptContractParser(files);

  const valuesRes = parser.parseTypeByName('ValuesType', 'test.ts');
  assert.strictEqual(valuesRes.wireType.kind, 'ARRAY');
  if (valuesRes.wireType.kind === 'ARRAY') {
    assert.strictEqual(valuesRes.wireType.elementType.kind, 'PRIMITIVE');
    if (valuesRes.wireType.elementType.kind === 'PRIMITIVE') {
      assert.strictEqual(valuesRes.wireType.elementType.scalar, 'string');
    }
    assert.strictEqual(valuesRes.wireType.tupleElements, undefined, 'Mutable array must not have tupleElements');
  }

  const elemRes = parser.parseTypeByName('ValueElem', 'test.ts');
  assert.strictEqual(elemRes.wireType.kind, 'PRIMITIVE');
  if (elemRes.wireType.kind === 'PRIMITIVE') {
    assert.strictEqual(elemRes.wireType.scalar, 'string');
  }

  const firstRes = parser.parseTypeByName('FirstElem', 'test.ts');
  assert.strictEqual(firstRes.wireType.kind, 'PRIMITIVE');
  if (firstRes.wireType.kind === 'PRIMITIVE') {
    assert.strictEqual(firstRes.wireType.scalar, 'string', 'Mutable array index [0] must be string, not literal');
  }
}

function testTuplePositionsPreservedOnNumericIndex() {
  const code = `
    export const tuple = ['first', 'second', 'third'] as const;
    export type Pos0 = (typeof tuple)[0];
    export type Pos1 = (typeof tuple)[1];
    export type Pos2 = (typeof tuple)[2];
    export type PosUnion = (typeof tuple)[number];

    export type DeclaredTuple = [number, string, boolean];
    export type DeclPos0 = DeclaredTuple[0];
    export type DeclPos1 = DeclaredTuple[1];
    export type DeclPos2 = DeclaredTuple[2];
  `;
  const files = new Map([['test.ts', code]]);
  const parser = new TypeScriptContractParser(files);

  const p0 = parser.parseTypeByName('Pos0', 'test.ts');
  assert.strictEqual(p0.wireType.kind, 'LITERAL');
  if (p0.wireType.kind === 'LITERAL') assert.strictEqual(p0.wireType.value, 'first');

  const p1 = parser.parseTypeByName('Pos1', 'test.ts');
  assert.strictEqual(p1.wireType.kind, 'LITERAL');
  if (p1.wireType.kind === 'LITERAL') assert.strictEqual(p1.wireType.value, 'second');

  const p2 = parser.parseTypeByName('Pos2', 'test.ts');
  assert.strictEqual(p2.wireType.kind, 'LITERAL');
  if (p2.wireType.kind === 'LITERAL') assert.strictEqual(p2.wireType.value, 'third');

  const pUnion = parser.parseTypeByName('PosUnion', 'test.ts');
  assert.strictEqual(pUnion.wireType.kind, 'UNION');
  if (pUnion.wireType.kind === 'UNION') {
    assert.deepStrictEqual(pUnion.wireType.types.map((t: any) => t.value), ['first', 'second', 'third']);
  }

  const d0 = parser.parseTypeByName('DeclPos0', 'test.ts');
  assert.strictEqual(d0.wireType.kind, 'PRIMITIVE');
  if (d0.wireType.kind === 'PRIMITIVE') assert.strictEqual(d0.wireType.scalar, 'number');

  const d1 = parser.parseTypeByName('DeclPos1', 'test.ts');
  assert.strictEqual(d1.wireType.kind, 'PRIMITIVE');
  if (d1.wireType.kind === 'PRIMITIVE') assert.strictEqual(d1.wireType.scalar, 'string');

  const d2 = parser.parseTypeByName('DeclPos2', 'test.ts');
  assert.strictEqual(d2.wireType.kind, 'PRIMITIVE');
  if (d2.wireType.kind === 'PRIMITIVE') assert.strictEqual(d2.wireType.scalar, 'boolean');
}

function testOptionalIndexedPropertyPreservesOptionality() {
  const code = `
    export type Config = {
      port?: number;
      host: string;
      description?: string | null;
    };
    export type PortType = Config['port'];
    export type HostType = Config['host'];
    export type DescType = Config['description'];
  `;
  const files = new Map([['test.ts', code]]);
  const parser = new TypeScriptContractParser(files);

  const portRes = parser.parseTypeByName('PortType', 'test.ts');
  assert.strictEqual(portRes.wireType.kind, 'OPTIONAL', 'Config["port"] must preserve OPTIONAL');
  if (portRes.wireType.kind === 'OPTIONAL') {
    assert.strictEqual(portRes.wireType.innerType.kind, 'PRIMITIVE');
    if (portRes.wireType.innerType.kind === 'PRIMITIVE') {
      assert.strictEqual(portRes.wireType.innerType.scalar, 'number');
    }
  }

  const hostRes = parser.parseTypeByName('HostType', 'test.ts');
  assert.strictEqual(hostRes.wireType.kind, 'PRIMITIVE', 'Config["host"] is required string');
  if (hostRes.wireType.kind === 'PRIMITIVE') {
    assert.strictEqual(hostRes.wireType.scalar, 'string');
  }

  const descRes = parser.parseTypeByName('DescType', 'test.ts');
  assert.strictEqual(descRes.wireType.kind, 'OPTIONAL', 'Config["description"] must preserve OPTIONAL');
  if (descRes.wireType.kind === 'OPTIONAL') {
    assert.strictEqual(descRes.wireType.innerType.kind, 'NULLABLE');
    if (descRes.wireType.innerType.kind === 'NULLABLE') {
      assert.strictEqual(descRes.wireType.innerType.innerType.kind, 'PRIMITIVE');
    }
  }
}

function testCrossFileImportedConstTupleAndIndexedAccess() {
  const fileA = `
    export const fontStyles = ['normal', 'italic', 'oblique'] as const;
    export type FontStyleTuple = typeof fontStyles;
  `;
  const fileB = `
    import { fontStyles, FontStyleTuple } from './fileA';
    export type StyleByIndex = FontStyleTuple[1];
    export type StyleByNumber = FontStyleTuple[number];
    export type StyleDirect = (typeof fontStyles)[0];
  `;
  const files = new Map([
    ['src/fileA.ts', fileA],
    ['src/fileB.ts', fileB],
  ]);
  const parser = new TypeScriptContractParser(files);

  const byIndex = parser.parseTypeByName('StyleByIndex', 'src/fileB.ts');
  assert.strictEqual(byIndex.wireType.kind, 'LITERAL');
  if (byIndex.wireType.kind === 'LITERAL') {
    assert.strictEqual(byIndex.wireType.value, 'italic');
  }

  const direct = parser.parseTypeByName('StyleDirect', 'src/fileB.ts');
  assert.strictEqual(direct.wireType.kind, 'LITERAL');
  if (direct.wireType.kind === 'LITERAL') {
    assert.strictEqual(direct.wireType.value, 'normal');
  }

  const byNumber = parser.parseTypeByName('StyleByNumber', 'src/fileB.ts');
  assert.strictEqual(byNumber.wireType.kind, 'UNION');
  if (byNumber.wireType.kind === 'UNION') {
    assert.deepStrictEqual(byNumber.wireType.types.map((t: any) => t.value), ['normal', 'italic', 'oblique']);
  }
}

runTests();
testConstArrayTupleIndexedAccess();
testMutableArrayInfersPrimitiveArrayNotLiteralUnion();
testTuplePositionsPreservedOnNumericIndex();
testOptionalIndexedPropertyPreservesOptionality();
testCrossFileImportedConstTupleAndIndexedAccess();

const boundsParser = new TypeScriptContractParser(new Map([['bounds.ts',
  "const tuple = ['px', 1] as const; type Outside = (typeof tuple)[2];"]]));
const outside = boundsParser.parseTypeByName('Outside', 'bounds.ts');
assert.strictEqual(outside.wireType.kind, 'UNKNOWN');
assert.ok(outside.blockers.length > 0, 'Out-of-range tuple index must remain unresolved');
console.log('All extended TypeScriptContractParser tests passed!');
