import assert from 'node:assert/strict';
import { PRODUCTION_LIMITS, validateProjectGraphBudget } from '../../src/sajimora/verification/ExecutionLimits';
import type { GenericProjectGraph } from '../../src/sajimora/verification/contracts';

const graph = (sourceCounts: readonly number[]): GenericProjectGraph => ({
  graphId: 'budget-test', edges: [], projects: sourceCounts.map((count, index) => ({
    projectId: `project-${index}`, rootDirectory: '/', projectReferences: [], options: {},
    sourceFiles: Array.from({ length: count }, (_, file) => `src/${index}/${file}.ts`)
  }))
});

assert.doesNotThrow(() => validateProjectGraphBudget(graph([1])));
assert.throws(() => validateProjectGraphBudget(graph(Array(PRODUCTION_LIMITS.projects + 1).fill(0))),
  /RESOURCE_LIMIT_PROJECT_COUNT/);
assert.throws(() => validateProjectGraphBudget(graph([
  PRODUCTION_LIMITS.projectSourceMemberships, 1
])), /RESOURCE_LIMIT_PROJECT_SOURCE_MEMBERSHIPS/);
console.log('Production project graph budget PASSED.');
