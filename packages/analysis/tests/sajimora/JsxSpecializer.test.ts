// @ts-nocheck
import { describe, test, expect, beforeEach } from 'vitest';
import { Project, ts } from 'ts-morph';
import { AnalysisContext } from '../../src/sajimora/context/AnalysisContext';
import { RepositoryAnalysisUniverse } from '@sajimora/core';
import { TypeScriptUsageSpecializer } from '../../src/sajimora/languages/typescript/specialization/TypeScriptUsageSpecializer';
import { CanonicalReferenceOccurrence } from '@sajimora/core';

describe('TypeScriptUsageSpecializer - JSX_ELEMENT', () => {
  let project: Project;
  let context: AnalysisContext;

  beforeEach(() => {
    project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('react.d.ts', `
      declare namespace JSX {
        interface Element {}
        interface IntrinsicElements { div: any; span: any; }
        interface ElementChildrenAttribute { children: {}; }
      }
      declare namespace React {
        type ReactNode = any;
      }
    `);
    const universe: RepositoryAnalysisUniverse = {
      rootPath: '/',
      discoveredFiles: ['react.d.ts'],
      discoveredFileSet: new Set(['react.d.ts']),
      excludedFiles: new Map(),
      unsupportedFiles: [],
      unreadableFiles: [],
      parseFailures: new Map(),
      discoveryStatus: 'DISCOVERY_COMPLETE',
      discoveryEvidence: ''
    };
    context = new AnalysisContext(universe, {
      compilerHost: project.getCompilerOptions() as any,
      getTypeChecker: () => project.getProgram().compilerObject.getTypeChecker() as any,
      getUniverseSourceFiles: () => project.getSourceFiles().map(sf => sf.compilerNode),
      getUniverseSourceFile: (name) => project.getSourceFile(name)?.compilerNode
    } as any);
  });

  function createSite(sourceFile: string, span: { start: number, end: number }): any {
    const site: any = {
      occurrenceId: 'test-1',
      sourceFile,
      consumerFile: sourceFile,
      sourceSpan: { start: span.start, end: span.end, line: 1, column: 1 },
      location: { line: 1, column: 1 },
      syntaxKind: ts.SyntaxKind.JsxOpeningElement,
      semanticRole: 'VALUE',
      usageRole: 'JSX_ELEMENT',
      referencedSymbol: 'test-sym',
      declarationSymbol: 'test-decl',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    } as any;
    return {
      canonicalOccurrence: site,
      ...site
    } as any;
  }

  function runTest(code: string, componentName: string) {
    const sf = project.createSourceFile('test.tsx', code);
    const start = code.indexOf('<' + componentName);
    const end = start + componentName.length + 1; // approximate tag span
    
    // Actually search for the JsxOpeningElement or JsxSelfClosingElement tag name
    let tagNode: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === componentName) {
        tagNode = node.tagName;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf.compilerNode);
    if (!tagNode) throw new Error('Tag not found in code');

    const site = createSite('test.tsx', { start: tagNode.pos, end: tagNode.end });
    return TypeScriptUsageSpecializer.specializeSite(site, { parentProgram: project.getProgram().compilerObject });
  }

  test('1. Function component', () => {
    const code = `
      function FnComp(props: { name: string }) { return <div/>; }
      const ui = <FnComp name="test" />;
    `;
    const result = runTest(code, 'FnComp');
    expect(result.success).toBe(true);
    if (result.success) {
    expect((result as any).specializedContract.arguments).toBeDefined();
    expect((result as any).specializedContract.arguments![0].type.kind).toBe('OBJECT');
    }
  });

  test('2. Class component', () => {
    const code = `
      class ClsComp { constructor(props: { age: number }) {} }
      const ui = <ClsComp age={10} />;
    `;
    const result = runTest(code, 'ClsComp');
    expect(result.success).toBe(true);
  });

  test('3. Generic JSX component', () => {
    const code = `
      function GenComp<T>(props: { item: T }) { return <div/>; }
      const ui = <GenComp<string> item="hello" />;
    `;
    const result = runTest(code, 'GenComp');
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result as any).specializedContract.genericTypeArguments).toBeDefined();
      expect((result as any).specializedContract.genericTypeArguments!.length).toBe(1);
    }
  });

  test('4. Spread props', () => {
    const code = `
      function SpreadComp(props: { a: number, b: string }) { return <div/>; }
      const p = { a: 1, b: 'b' };
      const ui = <SpreadComp {...p} />;
    `;
    const result = runTest(code, 'SpreadComp');
    expect(result.success).toBe(true);
  });

  test('5. Children', () => {
    const code = `
      function ChildComp(props: { children: React.ReactNode }) { return <div/>; }
      const ui = <ChildComp>hello</ChildComp>;
    `;
    const result = runTest(code, 'ChildComp');
    expect(result.success).toBe(true);
  });

  test('6. Overloaded component', () => {
    const code = `
      function OverComp(props: { variant: 'a' }): JSX.Element;
      function OverComp(props: { variant: 'b', extra: boolean }): JSX.Element;
      function OverComp(props: any) { return <div/>; }
      const ui = <OverComp variant="b" extra={true} />;
    `;
    const result = runTest(code, 'OverComp');
    expect(result.success).toBe(true);
  });

  test('7. Intrinsic JSX element', () => {
    const code = `
      const ui = <div className="cls" />;
    `;
    const result = runTest(code, 'div');
    // Intrinsic elements might lack a concrete function declaration, but we check if it handles them gracefully without crashing
    expect(result.success).toBe(true);
  });
});
