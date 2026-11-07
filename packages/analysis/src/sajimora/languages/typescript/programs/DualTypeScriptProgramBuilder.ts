import * as path from 'node:path';
import * as ts from 'typescript';
import { ConfigurationChange, ConfigurationRelation, DualAnalysisUniverse } from '@sajimora/core';
import { TypeScriptProgramBuilder, TypeScriptProgramBuildResult, TypeScriptSnapshotInput, canonicalCompilerOptions, normalizeToTrackedRelative } from './TypeScriptProgramBuilder';

export interface DualTypeScriptProgramResult {
  parent: TypeScriptProgramBuildResult;
  candidate: TypeScriptProgramBuildResult;
  universe: DualAnalysisUniverse;
}

export interface DualProgramBuildOptions {
  changedFiles?: readonly string[];
  obligations?: readonly any[];
  parentReuseOptions?: { oldPrograms?: Map<string, ts.Program> };
  candidateReuseOptions?: { oldPrograms?: Map<string, ts.Program> };
}

const slash = (value: string) => value.replace(/\\/g, '/');

const material = [
  'strict', 'strictNullChecks', 'noImplicitAny', 'strictFunctionTypes',
  'module', 'moduleResolution', 'baseUrl', 'paths', 'rootDirs',
  'types', 'typeRoots', 'lib', 'target', 'jsx', 'allowJs', 'checkJs'
];

export class DualTypeScriptProgramBuilder {
  constructor(private readonly builder = new TypeScriptProgramBuilder()) {}

  build(
    parentInput: TypeScriptSnapshotInput,
    candidateInput: TypeScriptSnapshotInput,
    options?: DualProgramBuildOptions
  ): DualTypeScriptProgramResult {
    // Extract unified changed files from options or obligations
    const extraFiles: string[] = [];
    if (options?.changedFiles) {
      extraFiles.push(...options.changedFiles);
    }
    if (options?.obligations) {
      for (const obl of options.obligations) {
        const file = obl.mutatedSymbol?.declarationLocation?.filePath;
        if (typeof file === 'string') extraFiles.push(file);
      }
    }

    const normalizeChanged = (input: TypeScriptSnapshotInput): string[] | undefined => {
      const all = [...(input.changedFiles ?? []), ...extraFiles];
      if (all.length === 0) return undefined;
      const rootPath = path.resolve(input.root);
      const set = new Set<string>();
      for (const f of all) {
        const rel = normalizeToTrackedRelative(f, rootPath, input.trackedFiles);
        if (rel) {
          set.add(rel);
        }
      }
      return set.size > 0 ? [...set] : undefined;
    };

    const resolvedParentInput: TypeScriptSnapshotInput = {
      ...parentInput,
      changedFiles: normalizeChanged(parentInput),
      obligations: parentInput.obligations ?? (options?.obligations as any)
    };

    const resolvedCandidateInput: TypeScriptSnapshotInput = {
      ...candidateInput,
      changedFiles: normalizeChanged(candidateInput),
      obligations: candidateInput.obligations ?? (options?.obligations as any)
    };

    const parent = this.builder.build(resolvedParentInput, options?.parentReuseOptions);
    const candidate = this.builder.build(resolvedCandidateInput, options?.candidateReuseOptions);
    const configurationRelation = this.compare(parent, candidate);

    return {
      parent,
      candidate,
      universe: {
        parent: parent.universe,
        candidate: candidate.universe,
        configurationRelation
      }
    };
  }

  private compare(parent: TypeScriptProgramBuildResult, candidate: TypeScriptProgramBuildResult): ConfigurationRelation {
    if (parent.status === 'FAILED' || candidate.status === 'FAILED') return { status: 'UNRESOLVED', changes: [] };
    const byId = <T extends { identity: { projectId: string } }>(xs: T[]) => new Map(xs.map(x => [x.identity.projectId, x]));
    const a = byId(parent.projects);
    const b = byId(candidate.projects);
    const changes: ConfigurationChange[] = [];

    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const pa = a.get(id);
      const pb = b.get(id);
      if (!pa || !pb) {
        changes.push({ projectId: id, option: '<project-set>', parent: Boolean(pa), candidate: Boolean(pb), supported: false });
        continue;
      }
      const po = canonicalCompilerOptions(pa.options);
      const co = canonicalCompilerOptions(pb.options);
      for (const option of material) {
        if (JSON.stringify(po[option]) !== JSON.stringify(co[option])) {
          changes.push({ projectId: id, option, parent: po[option] ?? null, candidate: co[option] ?? null, supported: false });
        }
      }
      if (JSON.stringify(pa.identity.references) !== JSON.stringify(pb.identity.references)) {
        changes.push({ projectId: id, option: 'projectReferences', parent: pa.identity.references, candidate: pb.identity.references, supported: false });
      }
    }
    return { status: changes.length ? 'CHANGED_UNSUPPORTED' : 'EQUIVALENT', changes };
  }
}
