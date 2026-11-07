/**
 * @file JavaIdentityGate.ts
 * Cross-version declaration identity resolution for Java.
 * Compares FQCNs, signatures, fields, detecting stable, mutated, removed, added, ambiguous, or unresolved symbols.
 */

import { JavaClassDeclIR, JavaMethodSignatureIR, JavaFieldIR, JavaParameterIR } from '../ir';
import { JavaSealedCompilerHost } from '../programs/JavaSealedCompilerHost';

export type JavaIdentityStatus =
  | 'STABLE_UNCHANGED'
  | 'SIGNATURE_MUTATED'
  | 'REMOVED'
  | 'ADDED'
  | 'AMBIGUOUS'
  | 'UNRESOLVED';

export interface JavaDeclarationMapping {
  readonly fqcn: string;
  readonly declarationKind: 'CLASS' | 'INTERFACE' | 'ENUM' | 'RECORD';
  readonly status: JavaIdentityStatus;
  readonly parent?: JavaClassDeclIR;
  readonly candidate?: JavaClassDeclIR;
  readonly methodDiffs: ReadonlyArray<{
    readonly methodName: string;
    readonly status: JavaIdentityStatus;
    readonly parent?: JavaMethodSignatureIR;
    readonly candidate?: JavaMethodSignatureIR;
  }>;
  readonly fieldDiffs: ReadonlyArray<{
    readonly fieldName: string;
    readonly status: JavaIdentityStatus;
    readonly parent?: JavaFieldIR;
    readonly candidate?: JavaFieldIR;
  }>;
}

export class JavaIdentityGate {
  public static compareHosts(
    parentHost: JavaSealedCompilerHost,
    candidateHost: JavaSealedCompilerHost
  ): ReadonlyArray<JavaDeclarationMapping> {
    const parentClasses = parentHost.getAllClasses();
    const candidateClasses = candidateHost.getAllClasses();
    const allFQCNs = new Set<string>();

    for (const c of parentClasses) allFQCNs.add(c.fqcn);
    for (const c of candidateClasses) allFQCNs.add(c.fqcn);

    const sortedFQCNs = [...allFQCNs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const results: JavaDeclarationMapping[] = [];

    for (const fqcn of sortedFQCNs) {
      const p = parentHost.getClassByFQCN(fqcn);
      const c = candidateHost.getClassByFQCN(fqcn);

      if (!p && c) {
        results.push({
          fqcn,
          declarationKind: c.kind.toUpperCase() as any,
          status: 'ADDED',
          candidate: c,
          methodDiffs: [],
          fieldDiffs: []
        });
        continue;
      }

      if (p && !c) {
        results.push({
          fqcn,
          declarationKind: p.kind.toUpperCase() as any,
          status: 'REMOVED',
          parent: p,
          methodDiffs: [],
          fieldDiffs: []
        });
        continue;
      }

      if (p && c) {
        // Compare methods
        const methodDiffs: Array<{
          methodName: string;
          status: JavaIdentityStatus;
          parent?: JavaMethodSignatureIR;
          candidate?: JavaMethodSignatureIR;
        }> = [];

        const allMethodNames = new Set<string>();
        for (const m of p.methods) allMethodNames.add(m.name);
        for (const m of c.methods) allMethodNames.add(m.name);

        for (const mName of [...allMethodNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          const pMethods = p.methods.filter((m: JavaMethodSignatureIR) => m.name === mName);
          const cMethods = c.methods.filter((m: JavaMethodSignatureIR) => m.name === mName);

          for (const pm of pMethods) {
            const cm = cMethods.find((m: JavaMethodSignatureIR) =>
              m.parameters.length === pm.parameters.length &&
              m.parameters.every((param: JavaParameterIR, idx: number) => param.type.irContentHash === pm.parameters[idx].type.irContentHash)
            );
            if (!cm) {
              methodDiffs.push({ methodName: mName, status: 'SIGNATURE_MUTATED', parent: pm });
            } else if (pm.irContentHash === cm.irContentHash) {
              methodDiffs.push({ methodName: mName, status: 'STABLE_UNCHANGED', parent: pm, candidate: cm });
            } else {
              methodDiffs.push({ methodName: mName, status: 'SIGNATURE_MUTATED', parent: pm, candidate: cm });
            }
          }

          for (const cm of cMethods) {
            const pm = pMethods.find((m: JavaMethodSignatureIR) =>
              m.parameters.length === cm.parameters.length &&
              m.parameters.every((param: JavaParameterIR, idx: number) => param.type.irContentHash === cm.parameters[idx].type.irContentHash)
            );
            if (!pm) {
              methodDiffs.push({ methodName: mName, status: 'ADDED', candidate: cm });
            }
          }
        }

        // Compare fields
        const fieldDiffs: Array<{
          fieldName: string;
          status: JavaIdentityStatus;
          parent?: JavaFieldIR;
          candidate?: JavaFieldIR;
        }> = [];

        const allFieldNames = new Set<string>();
        for (const f of p.fields) allFieldNames.add(f.name);
        for (const f of c.fields) allFieldNames.add(f.name);

        for (const fName of [...allFieldNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          const pf = p.fields.find((f: JavaFieldIR) => f.name === fName);
          const cf = c.fields.find((f: JavaFieldIR) => f.name === fName);
          if (pf && !cf) {
            fieldDiffs.push({ fieldName: fName, status: 'REMOVED', parent: pf });
          } else if (!pf && cf) {
            fieldDiffs.push({ fieldName: fName, status: 'ADDED', candidate: cf });
          } else if (pf && cf) {
            if (pf.irContentHash === cf.irContentHash) {
              fieldDiffs.push({ fieldName: fName, status: 'STABLE_UNCHANGED', parent: pf, candidate: cf });
            } else {
              fieldDiffs.push({ fieldName: fName, status: 'SIGNATURE_MUTATED', parent: pf, candidate: cf });
            }
          }
        }

        const isMutated =
          p.kind !== c.kind ||
          p.extendsName !== c.extendsName ||
          methodDiffs.some(m => m.status === 'SIGNATURE_MUTATED') ||
          fieldDiffs.some(f => f.status === 'SIGNATURE_MUTATED');

        results.push({
          fqcn,
          declarationKind: p.kind.toUpperCase() as any,
          status: isMutated ? 'SIGNATURE_MUTATED' : 'STABLE_UNCHANGED',
          parent: p,
          candidate: c,
          methodDiffs,
          fieldDiffs
        });
      }
    }

    return results;
  }
}
