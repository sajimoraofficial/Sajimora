/**
 * SAJIMORA — OFFLINE IMPACT ENGINE
 *
 * Traverses the inverted dependency graph using BFS with visited-set cycle termination.
 * Computes exact blast radius over the statically resolved graph with 0 LLM calls.
 */

import * as path from 'path';
import {
  ImpactAnalysisResult,
  TargetKind,
  TargetResolution,
  DependencyEdge
} from './types';
import { OfflineDependencyGraph } from './OfflineDependencyGraph';

export interface ImpactEngineOptions {
  traversalMode?: 'BOUNDED' | 'FULL';
  maxBoundedDepth?: number;
}

export class OfflineImpactEngine {
  private traversalMode: 'BOUNDED' | 'FULL';
  private maxBoundedDepth: number;

  constructor(options: ImpactEngineOptions = {}) {
    this.traversalMode = options.traversalMode || 'BOUNDED';
    this.maxBoundedDepth = options.maxBoundedDepth ?? 2;
  }

  /**
   * Executes reverse BFS traversal starting at targetNode.
   */
  public analyze(
    resolution: TargetResolution,
    graph: OfflineDependencyGraph
  ): ImpactAnalysisResult {
    if (resolution.status !== 'RESOLVED' || !resolution.node) {
      return {
        archetype: 'IMPACT_ANALYSIS',
        targetNode: '',
        targetKind: (resolution.status === 'AMBIGUOUS' && resolution.targetKind) ? resolution.targetKind : 'FILE',
        resolutionStatus: resolution.status,
        blastRadius: 0,
        directDependents: [],
        transitiveDependents: [],
        affectedTests: [],
        affectedRoutes: [],
        affectedSchemas: [],
        traversalDepth: 0,
        traversalMode: this.traversalMode,
        graphStats: {
          nodesVisited: 0,
          edgesTraversed: 0,
          staticAstEdges: graph.staticAstEdgeCount,
          dynamicAstEdges: graph.dynamicAstEdgeCount,
          heuristicEdges: graph.heuristicEdgeCount,
        },
        llmCalls: 0,
        tokenCost: 0,
        ...((resolution.blockers?.length || graph.blockers.length) ? {
          blockers: [...(resolution.blockers ?? []), ...graph.blockers]
        } : {})
      };
    }

    const targetNode = resolution.node;
    const visited = new Set<string>([targetNode]);
    const queue: Array<{ node: string; depth: number }> = [{ node: targetNode, depth: 0 }];

    const directDependents = new Set<string>();
    const transitiveDependents = new Set<string>();
    let edgesTraversed = 0;
    let maxDepthReached = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > maxDepthReached) {
        maxDepthReached = current.depth;
      }

      if (this.traversalMode === 'BOUNDED' && current.depth >= this.maxBoundedDepth) {
        continue;
      }

      const incoming = graph.getIncomingEdges(current.node);
      for (const edge of incoming) {
        edgesTraversed++;
        const caller = edge.from;
        if (!visited.has(caller)) {
          visited.add(caller);
          const nextDepth = current.depth + 1;
          if (nextDepth === 1) {
            directDependents.add(caller);
          } else {
            transitiveDependents.add(caller);
          }
          queue.push({ node: caller, depth: nextDepth });
        }
      }
    }

    // Role classification (Structural evidence separation)
    const affectedTests: string[] = [];
    const affectedRoutes: string[] = [];
    const affectedSchemas: string[] = [];

    for (const file of visited) {
      if (file === targetNode) continue; // Level 0 target excluded from affected classifications
      const lower = file.toLowerCase();

      // Test suites
      if (
        lower.includes('.spec.') ||
        lower.includes('.test.') ||
        lower.includes('/__tests__/') ||
        lower.includes('/tests/') ||
        lower.includes('/src/test/') ||
        lower.endsWith('test.java') ||
        lower.endsWith('tests.java') ||
        lower.endsWith('testcase.java') ||
        lower.endsWith('it.java') ||
        lower.endsWith('_test.go') ||
        lower.endsWith('_test.rs') ||
        lower.endsWith('tests.rs') ||
        lower.endsWith('_test.py') ||
        path.basename(lower).startsWith('test_')
      ) {
        affectedTests.push(file);
      }

      // API Routes & Controllers
      if (
        lower.includes('controller') ||
        lower.includes('/route.') ||
        lower.includes('/router.') ||
        lower.includes('/routes/') ||
        lower.endsWith('handler.go') ||
        lower.endsWith('handlers.go') ||
        lower.endsWith('handler.rs') ||
        lower.endsWith('handlers.rs')
      ) {
        affectedRoutes.push(file);
      }

      // Data Models & Schemas
      if (
        lower.endsWith('.prisma') ||
        lower.includes('.model.') ||
        lower.includes('.entity.') ||
        lower.includes('/schema/') ||
        lower.includes('/schemas/') ||
        lower.endsWith('entity.java') ||
        lower.endsWith('model.java') ||
        lower.endsWith('model.go') ||
        lower.endsWith('schema.rs')
      ) {
        affectedSchemas.push(file);
      }
    }

    // Blast radius: strict unique count of affected dependents (target itself excluded)
    const blastRadius = visited.size - 1;

    return {
      archetype: 'IMPACT_ANALYSIS',
      targetNode,
      targetKind: resolution.targetKind,
      targetSymbol: resolution.symbol,
      targetPackage: resolution.packageName,
      resolutionStatus: 'RESOLVED',
      blastRadius: Math.max(0, blastRadius),
      directDependents: Array.from(directDependents).sort(),
      transitiveDependents: Array.from(transitiveDependents).sort(),
      affectedTests: affectedTests.sort(),
      affectedRoutes: affectedRoutes.sort(),
      affectedSchemas: affectedSchemas.sort(),
      traversalDepth: maxDepthReached,
      traversalMode: this.traversalMode,
      graphStats: {
        nodesVisited: visited.size,
        edgesTraversed,
        staticAstEdges: graph.staticAstEdgeCount,
        dynamicAstEdges: graph.dynamicAstEdgeCount,
        heuristicEdges: graph.heuristicEdgeCount,
      },
      llmCalls: 0,
      tokenCost: 0,
      ...((resolution.blockers?.length || graph.blockers.length) ? {
        blockers: [...(resolution.blockers ?? []), ...graph.blockers]
      } : {})
    };
  }
}
