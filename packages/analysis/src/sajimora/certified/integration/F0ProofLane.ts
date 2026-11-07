import { CertifiedEvaluationOrchestrator, CertifiedExecutionInput } from './CertifiedEvaluationOrchestrator';
import { GenericRepository, VerificationObligation } from '../../../../../core/src/sajimora/verification';

/** Production entry point to the existing sealed F0 kernel. */
export interface F0RouteBundleProvider {
  getExecution(obligation: VerificationObligation, repository: GenericRepository): CertifiedExecutionInput | undefined;
}

export interface F0RouteProof {
  readonly verdict: 'PRESERVED' | 'VIOLATED';
  readonly trace: readonly string[];
}

export class F0ProofLane {
  constructor(private readonly bundles: F0RouteBundleProvider) {}

  public tryProve(obligation: VerificationObligation, repository: GenericRepository): F0RouteProof | undefined {
    const execution = this.bundles.getExecution(obligation, repository);
    if (!execution) return undefined;
    const result = CertifiedEvaluationOrchestrator.evaluate(execution);
    if (result.verdictResult.verdict !== 'PRESERVED' && result.verdictResult.verdict !== 'VIOLATED') return undefined;
    return { verdict: result.verdictResult.verdict, trace: result.passedGates };
  }
}
