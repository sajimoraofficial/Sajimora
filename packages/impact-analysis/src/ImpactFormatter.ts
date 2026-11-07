/**
 * SAJIMORA — DETERMINISTIC IMPACT FORMATTER
 *
 * Formats impact analysis results and ambiguity states into clean, zero-hallucination Markdown.
 * Zero LLM calls required.
 */

import { ImpactAnalysisResult, TargetResolution } from './types';

export class ImpactFormatter {
  /**
   * Formats an impact analysis result into GitHub-flavored Markdown.
   */
  public static format(result: ImpactAnalysisResult, resolution?: TargetResolution): string {
    // 1. Ambiguity handling
    if (result.resolutionStatus === 'AMBIGUOUS' || resolution?.status === 'AMBIGUOUS') {
      const candidates = (resolution?.status === 'AMBIGUOUS' ? resolution.candidates : []) || [];
      return [
        `# Change Impact Analysis: AMBIGUOUS TARGET`,
        ``,
        `> [!WARNING]`,
        `> Multiple candidates match the requested target **"${resolution?.status === 'AMBIGUOUS' ? resolution.query : ''}"**.`,
        `> In accordance with zero-trust principles, Sajimora will not silently select a candidate.`,
        ``,
        `### Matching Candidates`,
        `| File Path | Match Type | Reason |`,
        `| :--- | :--- | :--- |`,
        ...candidates.map(c => `| \`${c.path}\` | ${c.symbol ? 'Symbol Definition' : 'File Basename'} | ${c.reason} |`),
        ``,
        `*To disambiguate, re-run the query specifying the exact relative path from the repository root.*`
      ].join('\n');
    }

    // 2. Not Found handling
    if (result.resolutionStatus === 'NOT_FOUND' || resolution?.status === 'NOT_FOUND') {
      const closest = (resolution?.status === 'NOT_FOUND' ? resolution.closestMatches : []) || [];
      return [
        `# Change Impact Analysis: TARGET NOT FOUND`,
        ``,
        `> [!WARNING]`,
        `> Could not resolve target **"${resolution?.status === 'NOT_FOUND' ? resolution.query : ''}"** in the repository.`,
        ``,
        `### Closest Matches in Scope`,
        ...closest.map(c => `- \`${c}\``),
        ``,
        `*Please verify the target file path, symbol name, or package identifier.*`
      ].join('\n');
    }

    // 3. Resolved Result Markdown
    const lines: string[] = [
      `# Change Impact & Blast Radius Analysis Report`,
      ``,
      `> [!NOTE]`,
      `> **Epistemic Invariant:** Blast radius is computed exactly over the statically resolved AST dependency graph. Dynamic runtime dispatch, reflection, and runtime DI are not captured.`,
      ``,
      `### Executive Summary`,
      `| Metric | Value |`,
      `| :--- | :--- |`,
      `| **Target Node** | \`${result.targetNode}\` |`,
      `| **Target Kind** | \`${result.targetKind}\`${result.targetSymbol ? ` (Symbol: \`${result.targetSymbol}\`)` : ''}${result.targetPackage ? ` (Package: \`${result.targetPackage}\`)` : ''} |`,
      `| **Static Blast Radius** | **${result.blastRadius} files** |`,
      `| **Direct Dependents (Level 1)** | ${result.directDependents.length} files |`,
      `| **Transitive Dependents (Level 2+)** | ${result.transitiveDependents.length} files |`,
      `| **Impacted Test Suites** | ${result.affectedTests.length} files |`,
      `| **Impacted API Routes** | ${result.affectedRoutes.length} files |`,
      `| **Impacted Data Models** | ${result.affectedSchemas.length} files |`,
      `| **Traversal Depth** | ${result.traversalDepth} (${result.traversalMode}) |`,
      `| **LLM Inference Tokens** | 0 tokens (Zero-Cost Offline Analysis) |`,
      ``,
      `### Graph Evidence Provenance`,
      `- **Static AST Edges (` + '`STATIC_AST`' + `):** ${result.graphStats.staticAstEdges}`,
      `- **Dynamic AST Edges (` + '`DYNAMIC_AST`' + `):** ${result.graphStats.dynamicAstEdges}`,
      `- **Heuristic / Fallback Edges (` + '`HEURISTIC`' + `):** ${result.graphStats.heuristicEdges}`,
      `- **Total Traversed Edges:** ${result.graphStats.edgesTraversed}`,
      ``
    ];

    // Direct Dependents (Level 1)
    if (result.directDependents.length > 0) {
      lines.push(`### Level 1: Direct Dependents (${result.directDependents.length})`);
      lines.push(`Files that directly import or consume the target:`);
      for (const d of result.directDependents) {
        lines.push(`- \`${d}\``);
      }
      lines.push(``);
    } else {
      lines.push(`### Level 1: Direct Dependents (0)`);
      lines.push(`No direct static imports of this file found.`);
      lines.push(``);
    }

    // Transitive Dependents (Level 2+)
    if (result.transitiveDependents.length > 0) {
      lines.push(`### Level 2: Transitive Dependents (${result.transitiveDependents.length})`);
      lines.push(`Downstream files that import direct dependents of the target:`);
      for (const d of result.transitiveDependents) {
        lines.push(`- \`${d}\``);
      }
      lines.push(``);
    }

    // Impacted Test Suites
    if (result.affectedTests.length > 0) {
      lines.push(`### 🧪 Impacted Test Suites (${result.affectedTests.length})`);
      lines.push(`> [!IMPORTANT]`);
      lines.push(`> Mutating the target may break the following test suites:`);
      for (const t of result.affectedTests) {
        lines.push(`- \`${t}\``);
      }
      lines.push(``);
    }

    // Impacted Routes / Controllers
    if (result.affectedRoutes.length > 0) {
      lines.push(`### 🌐 Impacted API Routes & Controllers (${result.affectedRoutes.length})`);
      for (const r of result.affectedRoutes) {
        lines.push(`- \`${r}\``);
      }
      lines.push(``);
    }

    // Impacted Schemas
    if (result.affectedSchemas.length > 0) {
      lines.push(`### 🗄️ Impacted Data Models & Schemas (${result.affectedSchemas.length})`);
      for (const s of result.affectedSchemas) {
        lines.push(`- \`${s}\``);
      }
      lines.push(``);
    }

    return lines.join('\n');
  }
}
