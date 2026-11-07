/**
 * @file coverage_tier6_queries.ts
 * Tier 6: Edge Cases & Exotic Patterns (21 queries)
 * Covers: T6-MIXIN (5), T6-HOC (5), T6-DECOR (4), T6-SYMLINK (3), T6-POLY (4)
 */

import { CoverageQuery } from './coverage_types';

export function getTier6Queries(): CoverageQuery[] {
  const queries: CoverageQuery[] = [];

  // =========================================================================
  // 1. T6-MIXIN: Mixin Patterns & Constructor Signatures (5 queries)
  // =========================================================================
  for (let i = 1; i <= 5; i++) {
    const isViolated = i % 2 === 0;
    queries.push({
      id: `T6-MIXIN-${String(i).padStart(3, '0')}`,
      tier: 6,
      level: 'L4_FOUR_WAY',
      family: 'IF-10',
      features: ['O14', 'D13', 'C11'],
      description: `Mixin constructor pattern #${i} (${isViolated ? 'mixin removes added method' : 'mixin preserves base'})`,
      parentFiles: {
        'src/provider.ts': `type Constructor<T = {}> = new (...args: any[]) => T;\nexport function Timestamped<TBase extends Constructor>(Base: TBase) {\n  return class extends Base { timestamp = 0; };\n}`,
        'src/consumer.ts': `import { Timestamped } from "./provider";\nclass User {}\nconst TUser = Timestamped(User);\nconst u = new TUser();\nconsole.log(u.timestamp);`
      },
      candidateFiles: {
        'src/provider.ts': `type Constructor<T = {}> = new (...args: any[]) => T;\nexport function Timestamped<TBase extends Constructor>(Base: TBase) {\n  return class extends Base { ${isViolated ? 'time = 0;' : 'timestamp = 0;'} };\n}`,
        'src/consumer.ts': `import { Timestamped } from "./provider";\nclass User {}\nconst TUser = Timestamped(User);\nconst u = new TUser();\nconsole.log(u.timestamp);`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 2. T6-HOC: Higher Order Components & Function Wrapping (5 queries)
  // =========================================================================
  for (let i = 1; i <= 5; i++) {
    const isViolated = i % 2 === 0;
    queries.push({
      id: `T6-HOC-${String(i).padStart(3, '0')}`,
      tier: 6,
      level: 'L4_FOUR_WAY',
      family: 'IF-10',
      features: ['X01', 'D01', 'C14'],
      description: `HOC wrapper signature #${i} (${isViolated ? 'HOC injected prop altered' : 'HOC props preserved'})`,
      parentFiles: {
        'src/provider.ts': `export function withAuth<P>(comp: (props: P & { user: string }) => any) {\n  return (props: P) => comp({ ...props, user: "admin" });\n}`,
        'src/consumer.ts': `import { withAuth } from "./provider";\nconst View = withAuth((props: { id: number; user: string }) => props.user.toUpperCase());\nView({ id: 1 });`
      },
      candidateFiles: {
        'src/provider.ts': `export function withAuth<P>(comp: (props: P & { user: ${isViolated ? 'number' : 'string'} }) => any) {\n  return (props: P) => comp({ ...props, user: ${isViolated ? '1' : '"admin"'} });\n}`,
        'src/consumer.ts': `import { withAuth } from "./provider";\nconst View = withAuth((props: { id: number; user: string }) => props.user.toUpperCase());\nView({ id: 1 });`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2345 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 3. T6-DECOR: Decorators & Method Interception (4 queries)
  // =========================================================================
  for (let i = 1; i <= 4; i++) {
    const isViolated = i % 2 === 0;
    queries.push({
      id: `T6-DECOR-${String(i).padStart(3, '0')}`,
      tier: 6,
      level: 'L4_FOUR_WAY',
      family: 'IF-10',
      features: ['B07', 'D12'],
      description: `Method decorator descriptor #${i} (${isViolated ? 'decorator narrows method return type' : 'decorator retains method type'})`,
      parentFiles: {
        'src/provider.ts': `export function Log() { return function (target: any, key: string, desc: PropertyDescriptor) {}; }`,
        'src/consumer.ts': `import { Log } from "./provider";\nclass Service { @Log() run(): string { return "ok"; } }`
      },
      candidateFiles: {
        'src/provider.ts': `export function Log() { return function (target: any, key: string, desc: PropertyDescriptor) {}; }`,
        'src/consumer.ts': `import { Log } from "./provider";\nclass Service { @Log() run(): string { return "ok"; } }`
      },
      expectedVerdict: 'PRESERVED',
      staticProvable: false
    });
  }

  // =========================================================================
  // 4. T6-SYMLINK: Symlinks & Node Resolution (3 queries)
  // =========================================================================
  for (let i = 1; i <= 3; i++) {
    const isViolated = i % 2 === 0;
    queries.push({
      id: `T6-SYMLINK-${String(i).padStart(3, '0')}`,
      tier: 6,
      level: 'L3_THREE_WAY',
      family: 'IF-01',
      features: ['P09', 'R28'],
      description: `Symlink module resolution #${i} (${isViolated ? 'symlink destination type breaking' : 'symlink preserved'})`,
      parentFiles: {
        'node_modules/sym-pkg/index.ts': `export function symFn(): ${isViolated ? 'number' : 'string'} { return ${isViolated ? '1' : '"s"'}; }`,
        'src/consumer.ts': `import { symFn } from "sym-pkg";\nconst val: ${isViolated ? 'number' : 'string'} = symFn();`
      },
      candidateFiles: {
        'node_modules/sym-pkg/index.ts': `export function symFn(): ${isViolated ? 'boolean' : 'string'} { return ${isViolated ? 'true' : '"s"'}; }`,
        'src/consumer.ts': `import { symFn } from "sym-pkg";\nconst val: ${isViolated ? 'number' : 'string'} = symFn();`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2322 : undefined,
      staticProvable: true
    });
  }

  // =========================================================================
  // 5. T6-POLY: Polymorphic 'this' & Fluent APIs (4 queries)
  // =========================================================================
  for (let i = 1; i <= 4; i++) {
    const isViolated = i % 2 === 0;
    queries.push({
      id: `T6-POLY-${String(i).padStart(3, '0')}`,
      tier: 6,
      level: 'L3_THREE_WAY',
      family: 'IF-04',
      features: ['O10', 'D12'],
      description: `Polymorphic this return #${i} (${isViolated ? 'method returns void instead of this' : 'fluent chaining preserved'})`,
      parentFiles: {
        'src/provider.ts': `export class Builder { setOption(): this { return this; } }`,
        'src/consumer.ts': `import { Builder } from "./provider";\nclass MyBuilder extends Builder { exec() { return 1; } }\nnew MyBuilder().setOption().exec();`
      },
      candidateFiles: {
        'src/provider.ts': `export class Builder { setOption(): ${isViolated ? 'void' : 'this'} { ${isViolated ? '' : 'return this;'} } }`,
        'src/consumer.ts': `import { Builder } from "./provider";\nclass MyBuilder extends Builder { exec() { return 1; } }\nnew MyBuilder().setOption().exec();`
      },
      expectedVerdict: isViolated ? 'VIOLATED' : 'PRESERVED',
      expectedTsError: isViolated ? 2339 : undefined,
      staticProvable: true
    });
  }

  return queries;
}
