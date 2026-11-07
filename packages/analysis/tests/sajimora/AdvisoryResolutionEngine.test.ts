import assert from 'node:assert/strict';
import { AdvisoryTypeScriptImpactAnalyzer } from '../../src/sajimora/advisory';

const analyzer = new AdvisoryTypeScriptImpactAnalyzer();

console.log('Running Advisory Resolution Engine Test Suite...');

// 1. Direct relative imports (.ts, directory /index.ts, .js -> .ts)
{
  const parent = {
    commitSha: 'parent-rel',
    files: {
      'src/components/button.ts': 'export const Button = (): string => "btn";',
      'src/components/index.ts': 'export * from "./button";',
      'src/utils/calc.ts': 'export const add = (a: number, b: number): number => a + b;',
      'src/main.ts': "import { Button } from './components'; import { add } from './utils/calc.js'; export const res = add(1, 2); export const b = Button();"
    }
  };
  const candidate = {
    commitSha: 'candidate-rel',
    files: {
      ...parent.files,
      'src/utils/calc.ts': 'export const add = (a: string, b: number): string => a + b;'
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
  assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2345)); // Argument not assignable
  assert.ok(result.completeness.resolutionTraces.some(t => t.includes('./components: src/components/index.ts')));
  assert.ok(result.completeness.resolutionTraces.some(t => t.includes('./utils/calc.js: src/utils/calc.ts')));
  console.log('  ✅ Relative imports (.ts, directory index, .js -> .ts rewrite) verified');
}

// 2. Path alias mapping (@app/*, @components/*)
{
  const parent = {
    commitSha: 'parent-alias',
    tsconfigPath: 'tsconfig.json',
    files: {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@app/*': ['src/*'],
            '@components/*': ['src/components/*']
          },
          strict: true
        }
      }),
      'src/components/card.ts': 'export const Card = (): string => "card";',
      'src/pages/home.ts': 'import { Card } from "@components/card"; export const view = Card();'
    }
  };
  const candidate = {
    ...parent,
    commitSha: 'candidate-alias',
    files: {
      ...parent.files,
      'src/components/card.ts': 'export const Card = (title: string): string => title;'
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
  assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2554)); // Expected 1 arguments, but got 0
  assert.ok(result.completeness.resolutionTraces.some(t => t.includes('@components/card: src/components/card.ts')));
  console.log('  ✅ Path alias resolution (@components/*) verified');
}

// 3. Subpath conditional exports in package.json
{
  const parent = {
    commitSha: 'parent-pkg-exports',
    tsconfigPath: 'tsconfig.json',
    files: {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          moduleResolution: 'bundler',
          strict: true
        }
      }),
      'node_modules/my-lib/package.json': JSON.stringify({
        name: 'my-lib',
        exports: {
          './feature': {
            types: './dist/feature.ts',
            default: './dist/feature.ts'
          }
        }
      }),
      'node_modules/my-lib/dist/feature.ts': 'export function compute(val: number): number { return val; }',
      'consumer.ts': 'import { compute } from "my-lib/feature"; export const result: number = compute(42);'
    }
  };
  const candidate = {
    ...parent,
    commitSha: 'candidate-pkg-exports',
    files: {
      ...parent.files,
      'node_modules/my-lib/dist/feature.ts': 'export function compute(val: string): number { return Number(val); }'
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
  assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2345));
  assert.ok(result.completeness.resolutionTraces.some(t => t.includes('my-lib/feature: node_modules/my-lib/dist/feature.ts')));
  console.log('  ✅ Package subpath conditional exports (my-lib/feature -> dist/feature.ts) verified');
}

// 4. In-memory virtual workspace linking (monorepo cross-package imports)
{
  const parent = {
    commitSha: 'parent-workspace',
    files: {
      'packages/shared/package.json': JSON.stringify({
        name: '@mono/shared',
        exports: {
          '.': './src/index.ts',
          './math': './src/math.ts'
        }
      }),
      'packages/shared/src/index.ts': 'export const VERSION = "1.0.0";',
      'packages/shared/src/math.ts': 'export function multiply(a: number, b: number): number { return a * b; }',
      'apps/server/package.json': JSON.stringify({
        name: '@mono/server',
        dependencies: { '@mono/shared': '*' }
      }),
      'apps/server/src/server.ts': 'import { VERSION } from "@mono/shared"; import { multiply } from "@mono/shared/math"; export const total: number = multiply(2, 3); export const ver: string = VERSION;'
    }
  };
  const candidate = {
    ...parent,
    commitSha: 'candidate-workspace',
    files: {
      ...parent.files,
      'packages/shared/src/math.ts': 'export function multiply(a: number, b: number): string { return String(a * b); }'
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
  assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2322)); // Type 'string' is not assignable to type 'number'
  assert.ok(result.completeness.resolutionTraces.some(t => t.includes('@mono/shared/math: packages/shared/src/math.ts')));
  console.log('  ✅ In-memory virtual workspace linking (@mono/shared and @mono/shared/math) verified');
}

// 5. Circular re-exports
{
  const parent = {
    commitSha: 'parent-circular',
    files: {
      'a.ts': 'export { bVal } from "./b"; export const aVal = 10;',
      'b.ts': 'export { aVal } from "./a"; export const bVal = 20;',
      'consumer.ts': 'import { aVal, bVal } from "./a"; export const sum: number = aVal + bVal;'
    }
  };
  const candidate = {
    commitSha: 'candidate-circular',
    files: {
      ...parent.files,
      'b.ts': 'export { aVal } from "./a"; export const bVal = "twenty";'
    }
  };

  const result = analyzer.analyze({ parent, candidate });
  assert.equal(result.verdict, 'LIKELY_VIOLATED');
  assert.equal(result.completeness.status, 'COMPLETE');
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].classification, 'NEWLY_FAILING');
  assert.ok(result.impacts[0].diagnostics.some(d => d.code === 2322));
  console.log('  ✅ Circular re-exports termination and impact detection verified');
}

// 6. Dynamic moduleResolution parsing (Bundler vs Node16)
{
  const bundlerParent = {
    commitSha: 'parent-bundler',
    tsconfigPath: 'tsconfig.json',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', strict: true } }),
      'dummy.ts': 'export const ok = true;'
    }
  };
  const node16Parent = {
    commitSha: 'parent-node16',
    tsconfigPath: 'tsconfig.json',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'node16', strict: true } }),
      'dummy.ts': 'export const ok = true;'
    }
  };

  const bundlerResult = analyzer.analyze({ parent: bundlerParent, candidate: bundlerParent });
  assert.equal(bundlerResult.compilerOptions.moduleResolution, 100); // ts.ModuleResolutionKind.Bundler === 100

  const node16Result = analyzer.analyze({ parent: node16Parent, candidate: node16Parent });
  assert.equal(node16Result.compilerOptions.moduleResolution, 3); // ts.ModuleResolutionKind.Node16 === 3

  console.log('  ✅ Dynamic moduleResolution options parsing (Bundler=100, Node16=3) verified');
}

console.log('\nAll Advisory Resolution Engine adversarial tests PASSED!\n');
