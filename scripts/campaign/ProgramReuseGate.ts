import * as ts from 'typescript';
import { ProjectSelectionResult, canonicalCompilerOptions } from '@sajimora/analysis';

export interface OldBuildRecord {
  revisionSha: string;
  snapshotRoot: string;
  buildStatus: 'BUILT' | 'FAILED' | string;
  trackedFiles: readonly string[];
  dependencyRoot: string | undefined;
  selectedConfigs: readonly (string | null)[];
  projectPrograms: Array<{
    configRel: string | null;
    program: ts.Program;
    parsedOptions: ts.CompilerOptions;
  }>;
}

export interface NewBuildContext {
  revisionSha: string;
  snapshotRoot: string;
  trackedFiles: readonly string[];
  dependencyRoot: string | undefined;
  selection: ProjectSelectionResult;
  parsedOptions: Map<string, ts.CompilerOptions | undefined>;
}

/**
 * Evaluates whether the old build's ts.Program objects are safe to pass as oldProgram
 * to ts.createProgram() for the new build.
 *
 * Returns a Map<configRel, ts.Program> on success; undefined on any gate failure.
 * All gates are fail-closed: any missing, ambiguous, or mismatched metadata -> undefined.
 */
export function evaluateProgramReuseEligibility(
  old: OldBuildRecord,
  newCtx: NewBuildContext
): Map<string, ts.Program> | undefined {
  // G1: old build must be clean — partial/failed programs must never be reused
  if (old.buildStatus !== 'BUILT') return undefined;

  // The path inventory does not prove content identity: distinct commits often
  // change bytes without adding or removing a tracked path. Old Program roots
  // must also refer to this exact materialized snapshot.
  if (!old.revisionSha || old.revisionSha !== newCtx.revisionSha) return undefined;
  if (!old.snapshotRoot || old.snapshotRoot !== newCtx.snapshotRoot) return undefined;

  // G2: same trackedFiles — verifies the root-name inventory after snapshot identity
  if (!arraysIdentical(old.trackedFiles, newCtx.trackedFiles)) return undefined;

  // G3: same dependencyRoot — different node_modules -> different resolution
  if (old.dependencyRoot !== newCtx.dependencyRoot) return undefined;

  // G4: same selected project set — selectProjects() is obligation-scoped;
  //     different effectiveChangedFiles can select different tsconfig subsets
  //     even for the same SHA. A program built for sub-package A must not be
  //     used as oldProgram for a build that selected sub-package B.
  const oldConfigs = [...old.selectedConfigs].map(c => c ?? '<implicit>').sort();
  const newConfigs = [...newCtx.selection.selectedConfigs].map(c => c ?? '<implicit>').sort();
  if (!arraysIdentical(oldConfigs, newConfigs)) return undefined;

  // G5: new closure must be proven — unproven closure -> discoveryStatus will be
  //     DISCOVERY_INCOMPLETE regardless; no benefit in reusing a program for
  //     a build that will be treated as incomplete.
  if (newCtx.selection.closureStatus !== 'PROVEN') return undefined;

  // G6 + G7: per-config options comparison and existence check.
  //     old.parsedOptions captured at build time from ts.parseJsonConfigFileContent().
  //     newCtx.parsedOptions freshly parsed from the same temp-dir for the new pair.
  //     These are genuinely independent values; same SHA -> same bytes -> same result
  //     in practice, but verified explicitly here so any divergence is caught.
  const result = new Map<string, ts.Program>();

  for (const configRel of newCtx.selection.selectedConfigs) {
    const key = configRel ?? '<implicit>';

    // G7: every config needed by new build must exist in old build
    const oldProject = old.projectPrograms.find(
      p => (p.configRel ?? '<implicit>') === key
    );
    if (!oldProject) return undefined;

    // G6: compare independently-obtained compiler options
    const newOpts = newCtx.parsedOptions.get(key);
    if (newOpts === undefined) return undefined;

    const oldCanonical = JSON.stringify(canonicalCompilerOptions(oldProject.parsedOptions));
    const newCanonical = JSON.stringify(canonicalCompilerOptions(newOpts));
    if (oldCanonical !== newCanonical) return undefined;

    result.set(key, oldProject.program);
  }

  return result;
}

/** Order-sensitive equality check for readonly string arrays. */
function arraysIdentical(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
