import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GenericRepository } from '../../../../../../core/src/sajimora/verification';
import { JavaPrimitiveInterfaceFacts, JavaPrimitiveInterfaceSourceFacts } from './JavaPrimitiveInterfaceSourceFacts';

export const JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1 = 'JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1';
export type JavaDeclaredMethod = JavaPrimitiveInterfaceFacts['methods'][number];

/** One narrow question about declarations in two admitted source files.
 * It says nothing about callers, implementers, classpath, binary linking,
 * method behavior, or whether either whole Java project compiles. */
export interface JavaPrimitiveMethodObligation {
  readonly profileId: typeof JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1;
  readonly repositoryId: string;
  readonly parentSnapshotId: string;
  readonly candidateSnapshotId: string;
  readonly parentPath: string;
  readonly candidatePath: string;
  readonly interfaceFqcn: string;
  readonly methodName: string;
  readonly property: 'DECLARED_METHOD_SIGNATURE_PRESERVATION';
}

export interface JavaPrimitiveMethodProof {
  readonly profileId: typeof JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1;
  readonly ruleId: 'JAVA.PRIMITIVE_INTERFACE.EXACT_METHOD_LOOKUP.V1';
  readonly obligationDigest: string;
  readonly parentFacts: JavaPrimitiveInterfaceFacts;
  readonly candidateFacts: JavaPrimitiveInterfaceFacts;
  readonly root: {
    readonly property: 'DECLARED_METHOD_SIGNATURE_PRESERVATION';
    readonly interfaceFqcn: string;
    readonly methodName: string;
    readonly parentMethod: JavaDeclaredMethod;
    readonly candidateMethod: JavaDeclaredMethod | null;
    readonly outcome: 'DECLARATION_PRESERVED' | 'DECLARATION_CHANGED';
  };
}

export type JavaPrimitiveMethodCheck =
  | { readonly status: 'VERIFIED_SOURCE_PROPOSITION'; readonly outcome: JavaPrimitiveMethodProof['root']['outcome']; readonly obligationDigest: string }
  | { readonly status: 'UNVERIFIED'; readonly blocker: string };

const digest = (obligation: JavaPrimitiveMethodObligation): string => createHash('sha256')
  .update('SAJIMORA_JAVA_PRIMITIVE_METHOD_OBLIGATION_V1\0')
  .update(JSON.stringify([
    obligation.profileId, obligation.repositoryId, obligation.parentSnapshotId,
    obligation.candidateSnapshotId, obligation.parentPath, obligation.candidatePath,
    obligation.interfaceFqcn, obligation.methodName, obligation.property
  ])).digest('hex');
const hasExactlyKeys = (value: object, expected: readonly string[]): boolean =>
  isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

export class JavaPrimitiveInterfaceMethodProof {
  /** A producer may construct this proposal. Only check() issues a receipt. */
  static propose(obligation: JavaPrimitiveMethodObligation, repository: GenericRepository): JavaPrimitiveMethodProof | undefined {
    const parent = JavaPrimitiveInterfaceSourceFacts.read(repository.parentSnapshot, obligation.parentPath);
    const candidate = JavaPrimitiveInterfaceSourceFacts.read(repository.candidateSnapshot, obligation.candidatePath);
    if (parent.status !== 'SOURCE_FACTS_CHECKED' || candidate.status !== 'SOURCE_FACTS_CHECKED' ||
        parent.facts.fqcn !== obligation.interfaceFqcn || candidate.facts.fqcn !== obligation.interfaceFqcn) return undefined;
    const parentMethod = parent.facts.methods.find(method => method.name === obligation.methodName);
    if (!parentMethod) return undefined;
    const candidateMethod = candidate.facts.methods.find(method => method.name === obligation.methodName) ?? null;
    return { profileId: JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1,
      ruleId: 'JAVA.PRIMITIVE_INTERFACE.EXACT_METHOD_LOOKUP.V1',
      obligationDigest: digest(obligation), parentFacts: parent.facts, candidateFacts: candidate.facts,
      root: { property: 'DECLARED_METHOD_SIGNATURE_PRESERVATION', interfaceFqcn: obligation.interfaceFqcn,
        methodName: obligation.methodName, parentMethod, candidateMethod,
        outcome: isDeepStrictEqual(parentMethod, candidateMethod) ? 'DECLARATION_PRESERVED' : 'DECLARATION_CHANGED' } };
  }

  /** Independently replay the source leaves and exact root proposition. */
  static check(obligation: JavaPrimitiveMethodObligation, repository: GenericRepository,
    proof: JavaPrimitiveMethodProof): JavaPrimitiveMethodCheck {
    try {
      if (!hasExactlyKeys(obligation, ['profileId', 'repositoryId', 'parentSnapshotId', 'candidateSnapshotId',
        'parentPath', 'candidatePath', 'interfaceFqcn', 'methodName', 'property']) ||
          !proof || !hasExactlyKeys(proof, ['profileId', 'ruleId', 'obligationDigest',
            'parentFacts', 'candidateFacts', 'root']) ||
          obligation.profileId !== JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1 ||
          obligation.property !== 'DECLARED_METHOD_SIGNATURE_PRESERVATION' ||
          repository.repositoryId !== obligation.repositoryId ||
          repository.parentSnapshot.snapshotId !== obligation.parentSnapshotId ||
          repository.candidateSnapshot.snapshotId !== obligation.candidateSnapshotId ||
          proof?.profileId !== JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1 ||
          proof.ruleId !== 'JAVA.PRIMITIVE_INTERFACE.EXACT_METHOD_LOOKUP.V1' ||
          proof.obligationDigest !== digest(obligation)) return { status: 'UNVERIFIED', blocker: 'OBLIGATION_BINDING_FAILED' };
      const parent = JavaPrimitiveInterfaceSourceFacts.read(repository.parentSnapshot, obligation.parentPath);
      const candidate = JavaPrimitiveInterfaceSourceFacts.read(repository.candidateSnapshot, obligation.candidatePath);
      if (parent.status !== 'SOURCE_FACTS_CHECKED' || candidate.status !== 'SOURCE_FACTS_CHECKED') {
        return { status: 'UNVERIFIED', blocker: 'SOURCE_FACTS_UNAVAILABLE' };
      }
      if (parent.facts.fqcn !== obligation.interfaceFqcn || candidate.facts.fqcn !== obligation.interfaceFqcn ||
          !isDeepStrictEqual(parent.facts, proof.parentFacts) || !isDeepStrictEqual(candidate.facts, proof.candidateFacts)) {
        return { status: 'UNVERIFIED', blocker: 'SOURCE_FACTS_MISMATCH' };
      }
      const parentMethod = parent.facts.methods.filter(method => method.name === obligation.methodName);
      const candidateMethod = candidate.facts.methods.filter(method => method.name === obligation.methodName);
      if (parentMethod.length !== 1 || candidateMethod.length > 1) return { status: 'UNVERIFIED', blocker: 'METHOD_IDENTITY_UNRESOLVED' };
      const actualCandidate = candidateMethod[0] ?? null;
      const expectedRoot: JavaPrimitiveMethodProof['root'] = {
        property: obligation.property, interfaceFqcn: obligation.interfaceFqcn,
        methodName: obligation.methodName, parentMethod: parentMethod[0], candidateMethod: actualCandidate,
        outcome: isDeepStrictEqual(parentMethod[0], actualCandidate) ? 'DECLARATION_PRESERVED' : 'DECLARATION_CHANGED'
      };
      if (!isDeepStrictEqual(proof.root, expectedRoot)) return { status: 'UNVERIFIED', blocker: 'ROOT_PROPOSITION_MISMATCH' };
      return { status: 'VERIFIED_SOURCE_PROPOSITION', outcome: expectedRoot.outcome, obligationDigest: digest(obligation) };
    } catch {
      return { status: 'UNVERIFIED', blocker: 'CHECKER_FAILURE' };
    }
  }
}
