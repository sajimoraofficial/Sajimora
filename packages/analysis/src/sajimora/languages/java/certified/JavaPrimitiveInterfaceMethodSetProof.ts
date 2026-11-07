import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GenericRepository } from '../../../../../../core/src/sajimora/verification';
import { JavaPrimitiveInterfaceSourceFacts } from './JavaPrimitiveInterfaceSourceFacts';
import { JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1, JavaPrimitiveInterfaceMethodProof,
  JavaPrimitiveMethodObligation, JavaPrimitiveMethodProof } from './JavaPrimitiveInterfaceMethodProof';

export const JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1 = 'JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1';
export interface JavaPrimitiveInterfaceSetObligation {
  readonly profileId: typeof JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1;
  readonly repositoryId: string;
  readonly parentSnapshotId: string;
  readonly candidateSnapshotId: string;
  readonly parentPath: string;
  readonly candidatePath: string;
  readonly interfaceFqcn: string;
  readonly property: 'OLD_DECLARED_METHOD_SET_INCLUSION';
}
export interface JavaPrimitiveInterfaceSetProof {
  readonly profileId: typeof JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1;
  readonly ruleId: 'JAVA.PRIMITIVE_INTERFACE.FINITE_METHOD_SET_V1';
  readonly obligationDigest: string;
  readonly memberProofs: readonly JavaPrimitiveMethodProof[];
  readonly root: {
    readonly property: 'OLD_DECLARED_METHOD_SET_INCLUSION';
    readonly interfaceFqcn: string;
    readonly parentMethodNames: readonly string[];
    readonly outcome: 'OLD_DECLARATIONS_INCLUDED' | 'OLD_DECLARATIONS_NOT_INCLUDED';
  };
}
export type JavaPrimitiveSetCheck =
  | { readonly status: 'VERIFIED_SOURCE_PROPOSITION'; readonly outcome: JavaPrimitiveInterfaceSetProof['root']['outcome']; readonly obligationDigest: string }
  | { readonly status: 'UNVERIFIED'; readonly blocker: string };

const digest = (obligation: JavaPrimitiveInterfaceSetObligation): string => createHash('sha256')
  .update('SAJIMORA_JAVA_PRIMITIVE_METHOD_SET_OBLIGATION_V1\0')
  .update(JSON.stringify([obligation.profileId, obligation.repositoryId, obligation.parentSnapshotId,
    obligation.candidateSnapshotId, obligation.parentPath, obligation.candidatePath,
    obligation.interfaceFqcn, obligation.property])).digest('hex');
const exactKeys = (value: object, keys: readonly string[]): boolean =>
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

/** Finite source-declaration inclusion only. New abstract interface methods may
 * break implementers, and unchanged declarations do not prove behavior. */
export class JavaPrimitiveInterfaceMethodSetProof {
  private static memberObligation(obligation: JavaPrimitiveInterfaceSetObligation, methodName: string): JavaPrimitiveMethodObligation {
    return { profileId: JAVA_PRIMITIVE_INTERFACE_METHOD_PROOF_V1,
      repositoryId: obligation.repositoryId, parentSnapshotId: obligation.parentSnapshotId,
      candidateSnapshotId: obligation.candidateSnapshotId, parentPath: obligation.parentPath,
      candidatePath: obligation.candidatePath, interfaceFqcn: obligation.interfaceFqcn,
      methodName, property: 'DECLARED_METHOD_SIGNATURE_PRESERVATION' };
  }

  static propose(obligation: JavaPrimitiveInterfaceSetObligation,
    repository: GenericRepository): JavaPrimitiveInterfaceSetProof | undefined {
    const parent = JavaPrimitiveInterfaceSourceFacts.read(repository.parentSnapshot, obligation.parentPath);
    if (parent.status !== 'SOURCE_FACTS_CHECKED' || parent.facts.fqcn !== obligation.interfaceFqcn) return undefined;
    const memberProofs = parent.facts.methods.map(method =>
      JavaPrimitiveInterfaceMethodProof.propose(this.memberObligation(obligation, method.name), repository));
    if (memberProofs.some(proof => !proof)) return undefined;
    return { profileId: JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1,
      ruleId: 'JAVA.PRIMITIVE_INTERFACE.FINITE_METHOD_SET_V1', obligationDigest: digest(obligation),
      memberProofs: memberProofs as JavaPrimitiveMethodProof[],
      root: { property: 'OLD_DECLARED_METHOD_SET_INCLUSION', interfaceFqcn: obligation.interfaceFqcn,
        parentMethodNames: parent.facts.methods.map(method => method.name),
        outcome: memberProofs.every(proof => proof!.root.outcome === 'DECLARATION_PRESERVED')
          ? 'OLD_DECLARATIONS_INCLUDED' : 'OLD_DECLARATIONS_NOT_INCLUDED' } };
  }

  static check(obligation: JavaPrimitiveInterfaceSetObligation, repository: GenericRepository,
    proof: JavaPrimitiveInterfaceSetProof): JavaPrimitiveSetCheck {
    try {
      if (!exactKeys(obligation, ['profileId', 'repositoryId', 'parentSnapshotId', 'candidateSnapshotId',
        'parentPath', 'candidatePath', 'interfaceFqcn', 'property']) ||
          !proof || !exactKeys(proof, ['profileId', 'ruleId', 'obligationDigest', 'memberProofs', 'root']) ||
          obligation.profileId !== JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1 ||
          obligation.property !== 'OLD_DECLARED_METHOD_SET_INCLUSION' ||
          proof.profileId !== JAVA_PRIMITIVE_INTERFACE_SET_PROOF_V1 ||
          proof.ruleId !== 'JAVA.PRIMITIVE_INTERFACE.FINITE_METHOD_SET_V1' ||
          proof.obligationDigest !== digest(obligation) ||
          repository.repositoryId !== obligation.repositoryId ||
          repository.parentSnapshot.snapshotId !== obligation.parentSnapshotId ||
          repository.candidateSnapshot.snapshotId !== obligation.candidateSnapshotId) {
        return { status: 'UNVERIFIED', blocker: 'OBLIGATION_BINDING_FAILED' };
      }
      const parent = JavaPrimitiveInterfaceSourceFacts.read(repository.parentSnapshot, obligation.parentPath);
      const candidate = JavaPrimitiveInterfaceSourceFacts.read(repository.candidateSnapshot, obligation.candidatePath);
      if (parent.status !== 'SOURCE_FACTS_CHECKED' || candidate.status !== 'SOURCE_FACTS_CHECKED' ||
          parent.facts.fqcn !== obligation.interfaceFqcn || candidate.facts.fqcn !== obligation.interfaceFqcn) {
        return { status: 'UNVERIFIED', blocker: 'SOURCE_FACTS_UNAVAILABLE' };
      }
      const expectedNames = parent.facts.methods.map(method => method.name);
      const suppliedNames = proof.memberProofs.map(member => member.root.methodName);
      if (proof.memberProofs.length !== expectedNames.length ||
          !isDeepStrictEqual(suppliedNames, expectedNames) ||
          !isDeepStrictEqual(proof.root.parentMethodNames, expectedNames)) {
        return { status: 'UNVERIFIED', blocker: 'METHOD_COVERAGE_FAILED' };
      }
      const results = proof.memberProofs.map((member, index) =>
        JavaPrimitiveInterfaceMethodProof.check(this.memberObligation(obligation, expectedNames[index]), repository, member));
      if (results.some(result => result.status !== 'VERIFIED_SOURCE_PROPOSITION')) {
        return { status: 'UNVERIFIED', blocker: 'MEMBER_PROOF_FAILED' };
      }
      const outcome = results.every(result => result.status === 'VERIFIED_SOURCE_PROPOSITION' && result.outcome === 'DECLARATION_PRESERVED')
        ? 'OLD_DECLARATIONS_INCLUDED' as const : 'OLD_DECLARATIONS_NOT_INCLUDED' as const;
      if (!isDeepStrictEqual(proof.root, { property: obligation.property, interfaceFqcn: obligation.interfaceFqcn,
        parentMethodNames: expectedNames, outcome })) {
        return { status: 'UNVERIFIED', blocker: 'ROOT_PROPOSITION_MISMATCH' };
      }
      return { status: 'VERIFIED_SOURCE_PROPOSITION', outcome, obligationDigest: digest(obligation) };
    } catch {
      return { status: 'UNVERIFIED', blocker: 'CHECKER_FAILURE' };
    }
  }
}
