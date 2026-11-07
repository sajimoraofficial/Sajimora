/**
 * SAJIMORA V32 — Expected Change Model (ECM) Fluent Builder
 * Subordinate to sajimora_v32_foundation_spec.md §1.2.
 */

import {
  ExpectedChangeModel,
  ExpectedFileChange,
  ExpectedSymbolChange,
  ExpectedEdgeChange,
  ExpectedBehavioralObligation,
  ExpectedInvariantTransition,
  ChangeBoundary,
  EcmSource,
} from '../types';
import { validateAndBuildEcm, RawEcmParams } from './validator';

export class EcmBuilder {
  private params: RawEcmParams;

  constructor(workspaceId: string, baseCommitSha: string, candidateCommitSha: string) {
    this.params = {
      workspaceId,
      baseCommitSha,
      candidateCommitSha,
      ecmSource: 'STRUCTURED_INPUT',
      expectedFiles: [],
      expectedSymbols: [],
      expectedEdges: [],
      expectedBehavioralObligations: [],
      expectedInvariantTransitions: [],
      changeBoundary: null,
    };
  }

  setSource(source: EcmSource): this {
    this.params.ecmSource = source;
    return this;
  }

  expectFile(file: ExpectedFileChange): this {
    this.params.expectedFiles = this.params.expectedFiles || [];
    this.params.expectedFiles.push(file);
    return this;
  }

  expectSymbol(symbol: ExpectedSymbolChange): this {
    this.params.expectedSymbols = this.params.expectedSymbols || [];
    this.params.expectedSymbols.push(symbol);
    return this;
  }

  expectEdge(edge: ExpectedEdgeChange): this {
    this.params.expectedEdges = this.params.expectedEdges || [];
    this.params.expectedEdges.push(edge);
    return this;
  }

  expectBehavioralObligation(obligation: ExpectedBehavioralObligation): this {
    this.params.expectedBehavioralObligations = this.params.expectedBehavioralObligations || [];
    this.params.expectedBehavioralObligations.push(obligation);
    return this;
  }

  expectInvariantTransition(transition: ExpectedInvariantTransition): this {
    this.params.expectedInvariantTransitions = this.params.expectedInvariantTransitions || [];
    this.params.expectedInvariantTransitions.push(transition);
    return this;
  }

  setBoundary(boundary: ChangeBoundary | null): this {
    this.params.changeBoundary = boundary;
    return this;
  }

  build(): ExpectedChangeModel {
    return validateAndBuildEcm(this.params);
  }
}
