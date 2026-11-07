import {
  RelationKind,
  RelationStatus,
  LanguageAdapter,
  RelationEngineDriver,
  RelationContext,
  RuleExecutionResult,
  TypeRelationResult,
  RelationBlocker,
  IncompatibilityWitness,
  VarianceFrame
} from '@sajimora/core';
import { ProofTreeBuilder } from './ProofTreeBuilder';

export interface GenericEngineOptions {
  readonly maxWorkBudget?: number;
  readonly maxDepth?: number;
}

export class GenericRelationEngine<TTypeIR, TPolicy> implements RelationEngineDriver<TTypeIR, TPolicy> {
  private currentWorkBudget: number;
  private readonly maxWorkBudget: number;
  private readonly maxDepth: number;
  private readonly memoCache = new Map<string, TypeRelationResult>();

  constructor(
    public readonly adapter: LanguageAdapter<TTypeIR, TPolicy, unknown, unknown>,
    options?: GenericEngineOptions
  ) {
    this.maxWorkBudget = options?.maxWorkBudget ?? 500000;
    this.currentWorkBudget = this.maxWorkBudget;
    this.maxDepth = options?.maxDepth ?? 100;
  }

  public resetBudget(): void {
    this.currentWorkBudget = this.maxWorkBudget;
    this.memoCache.clear();
  }

  public consumeWorkBudget(units: number): void {
    this.currentWorkBudget -= units;
  }

  public getWorkConsumed(): number {
    return this.maxWorkBudget - this.currentWorkBudget;
  }

  private currentVariance(varianceStack?: ReadonlyArray<VarianceFrame>): string {
    if (!varianceStack || varianceStack.length === 0) return 'COVARIANT';
    return varianceStack[varianceStack.length - 1].composedVariance;
  }

  public evaluateSubRelation(
    source: TTypeIR,
    target: TTypeIR,
    relation: RelationKind,
    policy: TPolicy,
    context: RelationContext
  ): TypeRelationResult {
    return this.evaluate(source, target, relation, policy, context);
  }

  public evaluate(
    source: TTypeIR,
    target: TTypeIR,
    relation: RelationKind,
    policy: TPolicy,
    context?: Partial<RelationContext>
  ): TypeRelationResult {
    const depth = context?.depth ?? 0;
    const visitedPairs = new Set(context?.visitedPairs ?? []);
    const varianceStack = context?.varianceStack ?? [];
    const structuralGuardDepth = context?.structuralGuardDepth ?? 0;
    const effectivePolicy = (context?.effectivePolicy ?? {}) as Record<string, unknown>;

    const sourceHash = this.adapter.hashTypeIR(source);
    const targetHash = this.adapter.hashTypeIR(target);
    const policyHash = this.adapter.hashPolicy(policy);
    const variance = this.currentVariance(varianceStack);

    // 5-tuple cycle key: (sourceHash, targetHash, relation, policyHash, variance)
    const cycleKey = `${sourceHash}|${targetHash}|${relation}|${policyHash}|${variance}`;

    // Depth check
    if (depth > this.maxDepth) {
      return ProofTreeBuilder.createUndecidableNode({
        relation,
        rule: 'DEPTH_BUDGET_EXCEEDED',
        adapterId: this.adapter.languageId,
        adapterVersion: this.adapter.schemaVersion,
        ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
        source,
        target,
        sourceHash,
        targetHash,
        effectivePolicy,
        blockers: [
          {
            blockerId: 'DEPTH_BUDGET_EXCEEDED',
            snapshot: 'PARENT',
            detail: `Maximum recursion depth ${this.maxDepth} exceeded`,
            sourceIRContentHash: sourceHash,
            targetIRContentHash: targetHash
          }
        ],
        depth,
        workConsumed: this.getWorkConsumed()
      });
    }

    // Work budget check
    this.consumeWorkBudget(1);
    if (this.currentWorkBudget <= 0) {
      return ProofTreeBuilder.createUndecidableNode({
        relation,
        rule: 'WORK_BUDGET_EXCEEDED',
        adapterId: this.adapter.languageId,
        adapterVersion: this.adapter.schemaVersion,
        ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
        source,
        target,
        sourceHash,
        targetHash,
        effectivePolicy,
        blockers: [
          {
            blockerId: 'WORK_BUDGET_EXCEEDED',
            snapshot: 'PARENT',
            detail: `Work budget exhausted (${this.maxWorkBudget} units)`,
            sourceIRContentHash: sourceHash,
            targetIRContentHash: targetHash
          }
        ],
        depth,
        workConsumed: this.getWorkConsumed()
      });
    }

    // Coinductive Cycle Detection
    if (visitedPairs.has(cycleKey)) {
      if (structuralGuardDepth >= 1) {
        // Coinductive hypothesis discharged with guarded structural progress
        return ProofTreeBuilder.createCompatibleNode({
          relation,
          rule: 'COINDUCTIVE_CYCLE_DISCHARGE',
          rulePremises: [
            {
              premiseId: 'GUARDED_STRUCTURAL_PROGRESS',
              description: `Cycle matched with guard depth ${structuralGuardDepth} >= 1`,
              verified: true
            }
          ],
          dischargedObligations: ['RECURSIVE_TYPE_COINDUCTIVE_OBLIGATION'],
          adapterId: this.adapter.languageId,
          adapterVersion: this.adapter.schemaVersion,
          ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
          source,
          target,
          sourceHash,
          targetHash,
          effectivePolicy,
          hypothesisDischarged: true,
          structuralGuardDepth,
          depth,
          workConsumed: this.getWorkConsumed()
        });
      } else {
        // Unguarded cycle (guard depth = 0)
        return ProofTreeBuilder.createUndecidableNode({
          relation,
          rule: 'UNGUARDED_RECURSIVE_CYCLE',
          adapterId: this.adapter.languageId,
          adapterVersion: this.adapter.schemaVersion,
          ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
          source,
          target,
          sourceHash,
          targetHash,
          effectivePolicy,
          blockers: [
            {
              blockerId: 'UNGUARDED_RECURSIVE_CYCLE',
              snapshot: 'PARENT',
              detail: 'Unguarded recursive cycle detected without structural progress',
              sourceIRContentHash: sourceHash,
              targetIRContentHash: targetHash
            }
          ],
          depth,
          workConsumed: this.getWorkConsumed()
        });
      }
    }

    // Memoization check
    if (this.memoCache.has(cycleKey)) {
      return this.memoCache.get(cycleKey)!;
    }

    // Mark pair as visited for child sub-relations
    const nextVisitedPairs = new Set(visitedPairs);
    nextVisitedPairs.add(cycleKey);

    const relContext: RelationContext = {
      workBudget: this.currentWorkBudget,
      depth,
      visitedPairs: nextVisitedPairs,
      varianceStack,
      effectivePolicy,
      structuralGuardDepth
    };

    // Rule selection protocol: lowest priority number first
    const selectedRule = this.adapter.semanticRules.selectRule(source, target, relation, policy);

    if (!selectedRule) {
      // Fallback R99
      const fallbackResult = ProofTreeBuilder.createUndecidableNode({
        relation,
        rule: 'UNSUPPORTED_TYPE_RELATION',
        adapterId: this.adapter.languageId,
        adapterVersion: this.adapter.schemaVersion,
        ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
        source,
        target,
        sourceHash,
        targetHash,
        effectivePolicy,
        blockers: [
          {
            blockerId: 'UNSUPPORTED_TYPE_RELATION',
            snapshot: 'PARENT',
            detail: `No matching rule found for relation ${relation}`,
            sourceIRContentHash: sourceHash,
            targetIRContentHash: targetHash
          }
        ],
        depth,
        workConsumed: this.getWorkConsumed()
      });
      this.memoCache.set(cycleKey, fallbackResult);
      return fallbackResult;
    }

    // Rule execution with branch-local try/catch error boundary
    let executionResult: RuleExecutionResult<TTypeIR>;
    try {
      executionResult = selectedRule.evaluate(
        source,
        target,
        relation,
        policy,
        this,
        relContext
      );
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : 'UnknownError';
      const errorMessage = err instanceof Error ? err.message : String(err);
      const normalizedDetail = `Compiler API failure in rule ${selectedRule.id}: [${errorName}] ${errorMessage}`;

      const errorNode = ProofTreeBuilder.createUndecidableNode({
        relation,
        rule: selectedRule.id,
        adapterId: this.adapter.languageId,
        adapterVersion: this.adapter.schemaVersion,
        ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
        source,
        target,
        sourceHash,
        targetHash,
        effectivePolicy,
        blockers: [
          {
            blockerId: 'COMPILER_API_FAILURE',
            snapshot: 'PARENT',
            ruleAttempted: selectedRule.id,
            detail: normalizedDetail,
            sourceIRContentHash: sourceHash,
            targetIRContentHash: targetHash
          }
        ],
        depth,
        workConsumed: this.getWorkConsumed()
      });
      return errorNode;
    }

    // Process sub-relations if any
    const childNodes: TypeRelationResult[] = [];
    if (executionResult.subRelations && executionResult.subRelations.length > 0) {
      for (const sub of executionResult.subRelations) {
        this.consumeWorkBudget(1);
        const child = this.evaluate(
          sub.source,
          sub.target,
          sub.relation,
          sub.policy as TPolicy,
          sub.context
        );
        childNodes.push(child);
      }
    }

    // Aggregate status if rule didn't produce a terminal leaf
    const aggregationMode = executionResult.aggregationMode ?? 'UNIVERSAL_CONJUNCTION';
    let finalStatus: RelationStatus = executionResult.status;
    let witness: IncompatibilityWitness | undefined = executionResult.witness as IncompatibilityWitness | undefined;
    const blockers: RelationBlocker[] = [...((executionResult.blockers as RelationBlocker[]) ?? [])];
    let anyDependency = executionResult.anyDependency ?? false;

    if (childNodes.length > 0) {
      for (const c of childNodes) {
        if (c.anyDependency) anyDependency = true;
      }

      if (aggregationMode === 'UNIVERSAL_CONJUNCTION') {
        const firstIncompatible = childNodes.find(c => c.status === 'INCOMPATIBLE');
        if (firstIncompatible) {
          finalStatus = 'INCOMPATIBLE';
          if (!witness) witness = firstIncompatible.witness;
        } else {
          const firstUndecidable = childNodes.find(c => c.status === 'UNDECIDABLE');
          if (firstUndecidable) {
            finalStatus = 'UNDECIDABLE';
            blockers.push(...firstUndecidable.blockers);
          } else {
            finalStatus = 'COMPATIBLE';
          }
        }
      } else if (aggregationMode === 'EXISTENTIAL_DISJUNCTION') {
        const firstCompatible = childNodes.find(c => c.status === 'COMPATIBLE');
        if (firstCompatible) {
          finalStatus = 'COMPATIBLE';
        } else {
          const firstUndecidable = childNodes.find(c => c.status === 'UNDECIDABLE');
          if (firstUndecidable) {
            finalStatus = 'UNDECIDABLE';
            blockers.push(...firstUndecidable.blockers);
          } else {
            finalStatus = 'INCOMPATIBLE';
            for (const c of childNodes) {
              if (c.witness && !witness) witness = c.witness;
            }
          }
        }
      }
    }

    const finalNode = ProofTreeBuilder.createNode(finalStatus, {
      relation,
      rule: executionResult.ruleId,
      rulePremises: executionResult.premises,
      dischargedObligations: executionResult.dischargedObligations,
      adapterId: this.adapter.languageId,
      adapterVersion: this.adapter.schemaVersion,
      ruleNamespace: `${this.adapter.languageId}-compatibility-v1`,
      source,
      target,
      sourceHash,
      targetHash,
      effectivePolicy,
      children: childNodes,
      varianceStack,
      witness,
      blockers,
      anyDependency,
      structuralGuardDepth,
      depth,
      workConsumed: this.getWorkConsumed(),
      aggregationMode
    });

    this.memoCache.set(cycleKey, finalNode);
    return finalNode;
  }
}
