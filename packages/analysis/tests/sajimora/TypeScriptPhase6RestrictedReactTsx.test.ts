/** JSX acceptance against sealed installed React declarations, without ambient dependencies. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixture, snapshot } from './TypeScriptSealedContextTestHelpers';
import { TypeScriptJsxSpecializer } from '../../src/sajimora/languages/typescript/production/TypeScriptJsxSpecializer';
const declarations: Record<string, string> = {};
for (const file of ['@types/react/index.d.ts', '@types/react/global.d.ts', 'csstype/index.d.ts']) {
  declarations['node_modules/' + file] = fs.readFileSync(path.resolve(__dirname, '../../../../node_modules', file), 'utf8');
}
function jsxFixture(before: string, after: string, consumer: string) {
  const { repository, obligation } = fixture('', '', '');
  const config = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', jsx: 'preserve', types: [], baseUrl: '.', paths: { react: ['node_modules/@types/react/index.d.ts'], csstype: ['node_modules/csstype/index.d.ts'] } }, include: ['*.ts', '*.tsx'] });
  const component = (props: string) => `import * as React from 'react'; export declare function Comp(props: ${props}): React.JSX.Element;`;
  const files = { ...declarations, 'tsconfig.json': config, 'target.ts': component(before), 'consumer.tsx': `import * as React from 'react'; import { Comp } from './barrel'; ${consumer}`, 'barrel.ts': 'export * from "./target";' };
  repository.parentSnapshot = snapshot('parent', files);
  repository.candidateSnapshot = snapshot('candidate', { ...files, 'target.ts': component(after), 'consumer.tsx': 'export {};' });
  obligation.reference!.kind = 'STATIC_JSX_REFERENCE';
  obligation.reference!.location.filePath = 'consumer.tsx';
  return { repository, obligation };
}
function check(name: string, before: string, after: string, consumer: string, expected: 'PRESERVED' | 'VIOLATED', code?: number) {
  const { repository, obligation } = jsxFixture(before, after, consumer);
  const verdict = TypeScriptJsxSpecializer.evaluateJsxSpecialization(obligation, repository);
  assert.equal(verdict.outcome, expected, `${name}: ${JSON.stringify(verdict.evidence)}`);
  assert.equal(verdict.assurance, 'COMPILER_STATIC');
  if (code) assert.ok(verdict.evidence.compilerStatic?.introducedDiagnostics.some(d => d.code === code), `${name}: ${JSON.stringify(verdict.evidence.compilerStatic)}`);
  console.log(`Passed: ${name}`);
}
check('missing prop', '{ title: string }', '{ title: string; count: number }', 'const element = <Comp title="x" />;', 'VIOLATED', 2741);
check('optional addition and widening', '{ count: number }', '{ count: number | string; subtitle?: string }', 'const element = <Comp count={1} />;', 'PRESERVED');
check('explicit overrides spread', '{ id: string | number }', '{ id: string }', 'const props = { id: 1 }; const element = <Comp {...props} id="override" />;', 'PRESERVED');
// An optional spread avoids a pre-existing TS2783 duplicate-property error while testing order.
check('trailing spread can override explicit', '{ id: string | number }', '{ id: string }', 'const props: { id?: number } = {}; const element = <Comp id="default" {...props} />;', 'VIOLATED', 2322);
check('optional spread required key', '{ token?: string }', '{ token: string }', 'const props: { token?: string } = {}; const element = <Comp {...props} />;', 'VIOLATED', 2322);
check('render child type', '{ children: React.ReactNode }', '{ children: (item: string) => React.ReactNode }', 'const element = <Comp>{"x"}</Comp>;', 'VIOLATED');
check('single child arity', '{ children: React.ReactNode }', '{ children: React.JSX.Element }', 'const element = <Comp><span /><span /></Comp>;', 'VIOLATED', 2746);
check('callback incompatibility', '{ onChange: (value: number) => void }', '{ onChange: (value: string) => void }', 'const element = <Comp onChange={(value: number) => {}} />;', 'VIOLATED', 2322);
check('key and explicit ref contract', '{ label: string; ref?: React.Ref<HTMLDivElement> }', '{ label: string; ref?: React.Ref<HTMLDivElement>; extra?: number }', 'const element = <Comp label="x" key="id" ref={null} />;', 'PRESERVED');
check('qualified barrel import', '{ variant: string }', '{ variant: string; optional?: boolean }', 'const element = <Comp variant="x" />;', 'PRESERVED');
for (const reason of ['UNSUPPORTED_JSX_POLYMORPHIC_AS', 'UNSUPPORTED_JSX_DYNAMIC_SPREAD', 'UNSUPPORTED_JSX_HOC']) {
  const { repository, obligation } = jsxFixture('{}', '{}', 'const element = <Comp />;');
  obligation.reference!.isUnresolvedBoundary = true;
  obligation.reference!.boundaryTaxonomyReason = reason;
  const verdict = TypeScriptJsxSpecializer.evaluateJsxSpecialization(obligation, repository);
  assert.equal(verdict.outcome, 'UNKNOWN');
  assert.equal(verdict.evidence.unresolvedBoundary?.taxonomyCode, reason);
}
console.log('Phase 6 sealed React JSX compatibility passed.');
