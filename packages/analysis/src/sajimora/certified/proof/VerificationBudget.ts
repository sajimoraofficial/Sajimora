import { 
  ResourceKind, 
  ResourceExhaustedDetail, 
  BlockerCode 
} from '../../../../../core/src/sajimora/certified/blockers';
import { ResourceProfile } from '../../../../../core/src/sajimora/certified/protocol';

export class VerificationBudgetExhaustedError extends Error {
  public detail: ResourceExhaustedDetail;

  constructor(detail: ResourceExhaustedDetail) {
    super(`Resource exhausted: ${detail.resourceKind}`);
    this.name = 'VerificationBudgetExhaustedError';
    this.detail = detail;
  }
}

/**
 * Tracks resources and enforces checker-owned limits before expensive allocation/work.
 * Actual work is counted, supports cancellation, fails atomically.
 */
export class VerificationBudget {
  private consumed: Record<ResourceKind, number> = {
    INPUT_BYTES: 0,
    FILE_BYTES: 0,
    VERTICES: 0,
    EDGES: 0,
    SYNTAX_NESTING: 0,
    ALIAS_DEPTH: 0,
    PROOF_NODES: 0,
    CERTIFICATE_BYTES: 0,
    WORK_UNITS: 0,
    WORKER_MEMORY: 0,
    DEADLINE: 0
  };

  private isCancelled: boolean = false;
  private deadlineTimestamp: number;

  constructor(public readonly profile: ResourceProfile) {
    this.deadlineTimestamp = Date.now() + profile.deadlineMs;
  }

  public cancel(): void {
    this.isCancelled = true;
  }

  public checkCancellation(): void {
    if (this.isCancelled) {
      this.throwExhausted('DEADLINE', this.profile.deadlineMs, this.profile.deadlineMs, 'Verification cancelled');
    }
    if (Date.now() > this.deadlineTimestamp) {
      this.throwExhausted('DEADLINE', Date.now(), this.deadlineTimestamp, 'Deadline exceeded');
    }
  }

  public allocate(kind: ResourceKind, amount: number = 1): void {
    this.checkCancellation();
    
    // Check specific limits based on kind
    let limit = 0;
    switch (kind) {
      case 'INPUT_BYTES': limit = this.profile.maxInputBytes; break;
      case 'FILE_BYTES': limit = this.profile.maxFileBytes; break;
      case 'VERTICES': limit = this.profile.maxVertices; break;
      case 'EDGES': limit = this.profile.maxEdges; break;
      case 'SYNTAX_NESTING': limit = this.profile.maxSyntaxNesting; break;
      case 'ALIAS_DEPTH': limit = this.profile.maxAliasDepth; break;
      case 'PROOF_NODES': limit = this.profile.maxProofNodes; break;
      case 'CERTIFICATE_BYTES': limit = this.profile.maxCertificateBytes; break;
      case 'WORK_UNITS': limit = this.profile.maxWorkUnits; break;
      case 'WORKER_MEMORY': limit = this.profile.workerMemoryMb; break;
      case 'DEADLINE': limit = this.profile.deadlineMs; break;
    }

    const proposed = this.consumed[kind] + amount;
    if (proposed > limit) {
      this.throwExhausted(kind, proposed, limit, `Exceeded limit for ${kind}`);
    }

    this.consumed[kind] = proposed;
  }

  public set(kind: ResourceKind, value: number): void {
    this.checkCancellation();
    
    let limit = 0;
    switch (kind) {
      case 'SYNTAX_NESTING': limit = this.profile.maxSyntaxNesting; break;
      case 'ALIAS_DEPTH': limit = this.profile.maxAliasDepth; break;
      case 'WORKER_MEMORY': limit = this.profile.workerMemoryMb; break;
      default:
        // Set is generally for high-water marks (like memory or depth)
        throw new Error(`set() not supported for resource kind ${kind}`);
    }

    if (value > limit) {
      this.throwExhausted(kind, value, limit, `Exceeded limit for ${kind}`);
    }

    // Keep the maximum observed value
    if (value > this.consumed[kind]) {
      this.consumed[kind] = value;
    }
  }

  private throwExhausted(kind: ResourceKind, consumed: number, limit: number, message: string): never {
    throw new VerificationBudgetExhaustedError({
      code: BlockerCode.RESOURCE_EXHAUSTED,
      resourceKind: kind,
      consumed,
      limit,
      message
    });
  }

  public getConsumed(kind: ResourceKind): number {
    return this.consumed[kind];
  }
}
