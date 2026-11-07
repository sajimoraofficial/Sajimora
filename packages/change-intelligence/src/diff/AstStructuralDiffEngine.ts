/**
 * SAJIMORA V32 — AST Structural Diff Engine
 * Subordinate to sajimora_v32_foundation_spec.md §2.1–§2.5 & Final Implementation Plan.
 *
 * Deterministic AST difference computer.
 * Consumes pre-filtered actual Git changes and computes granular structural deltas:
 * - Symbol additions, removals, renames, and signature mutations
 * - Import and export additions and removals
 *
 * Rules:
 * - Zero LLM / Zero ML
 * - Generic symbol vocabulary only: FUNCTION, CLASS, INTERFACE, TYPE_ALIAS, ENUM, CONSTANT, OTHER
 * - Sanitized signature metadata only:
 *   - Both signatures available and different -> SIGNATURE_CHANGED
 *   - Both signatures available and identical -> no signature change
 *   - Unavailable -> do NOT infer change, do NOT fabricate, do NOT classify as BODY_CHANGED
 * - Rename detection: exact signature equality without ambiguity
 */


import {
  ChangeId,
  ChangeSetDelta,
  ChangeSetSummary,
  ChangedFile,
  DiffConfidence,
  ExportDelta,
  FileDelta,
  ImportDelta,
  SymbolDelta,
  SymbolKind,
} from '../types';
import { IBeforeStateProvider, ParseResult } from './LazyBeforeStateProvider';

interface InternalSymbol {
  name: string;
  kind: SymbolKind;
  signature?: string;
  startLine?: number;
  endLine?: number;
}

export class AstStructuralDiffEngine {
  constructor(private beforeStateProvider: IBeforeStateProvider) {}

  /**
   * Computes the complete ChangeSetDelta for a pre-filtered set of changed files.
   */
  async computeDiff(
    changeId: ChangeId,
    workspaceId: string,
    baseCommitSha: string,
    candidateCommitSha: string,
    changedFiles: ChangedFile[]
  ): Promise<ChangeSetDelta> {
    const fileDeltas: FileDelta[] = [];

    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;
    let filesRenamed = 0;

    let symbolsAdded = 0;
    let symbolsRemoved = 0;
    let symbolsRenamed = 0;
    let symbolsSignatureChanged = 0;

    let importsAdded = 0;
    let importsRemoved = 0;
    let exportsAdded = 0;
    let exportsRemoved = 0;

    let deterministicFileCount = 0;
    let partialFileCount = 0;
    let unparseableFileCount = 0;

    // Stable sort files by filePath
    const sortedFiles = [...changedFiles].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));

    for (const file of sortedFiles) {
      const { filePath, changeType, oldFilePath } = file;

      let beforeParse: ParseResult | null = null;
      let afterParse: ParseResult | null = null;

      if (changeType === 'ADDED') {
        filesAdded++;
        afterParse = await this.beforeStateProvider.getAfterParseResult(filePath, candidateCommitSha);
      } else if (changeType === 'DELETED') {
        filesDeleted++;
        beforeParse = await this.beforeStateProvider.getBeforeParseResult(workspaceId, baseCommitSha, filePath);
      } else if (changeType === 'MODIFIED') {
        filesModified++;
        beforeParse = await this.beforeStateProvider.getBeforeParseResult(workspaceId, baseCommitSha, filePath);
        afterParse = await this.beforeStateProvider.getAfterParseResult(filePath, candidateCommitSha);
      } else if (changeType === 'RENAMED') {
        filesRenamed++;
        const beforePathToUse = oldFilePath || filePath;
        beforeParse = await this.beforeStateProvider.getBeforeParseResult(workspaceId, baseCommitSha, beforePathToUse);
        afterParse = await this.beforeStateProvider.getAfterParseResult(filePath, candidateCommitSha);
      }

      // Compute diff confidence for this file
      const confidenceReasons: string[] = [];
      let diffConfidence: DiffConfidence = 'DETERMINISTIC';

      if (changeType === 'ADDED') {
        if (!afterParse) {
          diffConfidence = 'UNPARSEABLE';
          confidenceReasons.push('AFTER state parse result was null or unparseable.');
        } else if (afterParse.parserType !== 'native' || afterParse.completeness !== 'full') {
          diffConfidence = 'PARTIAL';
          confidenceReasons.push(`AFTER state used fallback parser (${afterParse.parserType}) or partial completeness (${afterParse.completeness}).`);
        }
      } else if (changeType === 'DELETED') {
        if (!beforeParse) {
          diffConfidence = 'UNPARSEABLE';
          confidenceReasons.push('BEFORE state parse result was null or unparseable.');
        } else if (beforeParse.parserType !== 'native' || beforeParse.completeness !== 'full') {
          diffConfidence = 'PARTIAL';
          confidenceReasons.push(`BEFORE state used fallback parser (${beforeParse.parserType}) or partial completeness (${beforeParse.completeness}).`);
        }
      } else {
        // MODIFIED or RENAMED
        if (!beforeParse || !afterParse) {
          diffConfidence = 'UNPARSEABLE';
          if (!beforeParse) confidenceReasons.push('BEFORE state parse result was null.');
          if (!afterParse) confidenceReasons.push('AFTER state parse result was null.');
        } else if (
          beforeParse.parserType !== 'native' ||
          beforeParse.completeness !== 'full' ||
          afterParse.parserType !== 'native' ||
          afterParse.completeness !== 'full'
        ) {
          diffConfidence = 'PARTIAL';
          confidenceReasons.push('At least one state used regex fallback or partial completeness.');
        }
      }

      if (diffConfidence === 'DETERMINISTIC') deterministicFileCount++;
      else if (diffConfidence === 'PARTIAL') partialFileCount++;
      else unparseableFileCount++;

      // Compute sub-deltas (empty if unparseable to prevent fabricating deltas against null states)
      const symbolDeltas = diffConfidence === 'UNPARSEABLE' ? [] : this.diffSymbols(beforeParse, afterParse);
      const importDeltas = diffConfidence === 'UNPARSEABLE' ? [] : this.diffImports(beforeParse, afterParse);
      const exportDeltas = diffConfidence === 'UNPARSEABLE' ? [] : this.diffExports(beforeParse, afterParse);

      // Accumulate counts
      for (const sd of symbolDeltas) {
        if (sd.changeType === 'ADDED') symbolsAdded++;
        else if (sd.changeType === 'REMOVED') symbolsRemoved++;
        else if (sd.changeType === 'RENAMED') symbolsRenamed++;
        else if (sd.changeType === 'SIGNATURE_CHANGED') symbolsSignatureChanged++;
      }

      for (const id of importDeltas) {
        if (id.changeType === 'ADDED') importsAdded++;
        else if (id.changeType === 'REMOVED') importsRemoved++;
      }

      for (const ed of exportDeltas) {
        if (ed.changeType === 'ADDED') exportsAdded++;
        else if (ed.changeType === 'REMOVED') exportsRemoved++;
      }

      fileDeltas.push({
        filePath,
        fileChangeType: changeType,
        oldFilePath,
        symbolDeltas,
        importDeltas,
        exportDeltas,
        diffConfidence,
        confidenceReasons,
      });
    }

    // Overall change set confidence
    let overallConfidence: DiffConfidence = 'DETERMINISTIC';
    if (unparseableFileCount > 0) {
      overallConfidence = unparseableFileCount === sortedFiles.length ? 'UNPARSEABLE' : 'PARTIAL';
    } else if (partialFileCount > 0) {
      overallConfidence = 'PARTIAL';
    }

    const summary: ChangeSetSummary = {
      totalFilesChanged: sortedFiles.length,
      filesAdded,
      filesModified,
      filesDeleted,
      filesRenamed,
      symbolsAdded,
      symbolsRemoved,
      symbolsRenamed,
      symbolsSignatureChanged,
      importsAdded,
      importsRemoved,
      exportsAdded,
      exportsRemoved,
      deterministicFileCount,
      partialFileCount,
      unparseableFileCount,
    };

    return {
      changeId,
      workspaceId,
      baseCommitSha,
      candidateCommitSha,
      computedAt: new Date(),
      fileDeltas,
      summary,
      overallConfidence,
    };
  }

  /**
   * Deterministically computes symbol deltas between two parse results.
   */
  private diffSymbols(
    before: ParseResult | null,
    after: ParseResult | null
  ): SymbolDelta[] {
    const beforeSymbols = this.extractSymbols(before);
    const afterSymbols = this.extractSymbols(after);

    const beforeMap = new Map<string, InternalSymbol>();
    for (const s of beforeSymbols) {
      beforeMap.set(s.name, s);
    }

    const afterMap = new Map<string, InternalSymbol>();
    for (const s of afterSymbols) {
      afterMap.set(s.name, s);
    }

    const removedCandidates: InternalSymbol[] = [];
    const addedCandidates: InternalSymbol[] = [];
    const deltas: SymbolDelta[] = [];

    // Identify shared and removed
    for (const [name, bSym] of beforeMap.entries()) {
      if (!afterMap.has(name)) {
        removedCandidates.push(bSym);
      } else {
        const aSym = afterMap.get(name)!;
        // Signature check:
        // - Both signatures available & differ -> SIGNATURE_CHANGED
        // - Both identical -> no change
        // - Unavailable -> do NOT infer change
        if (bSym.signature && aSym.signature && bSym.signature !== aSym.signature) {
          deltas.push({
            changeType: 'SIGNATURE_CHANGED',
            symbolName: name,
            symbolKind: aSym.kind,
            oldSignature: bSym.signature,
            newSignature: aSym.signature,
            startLine: aSym.startLine,
            endLine: aSym.endLine,
          });
        }
      }
    }

    // Identify added candidates
    for (const [name, aSym] of afterMap.entries()) {
      if (!beforeMap.has(name)) {
        addedCandidates.push(aSym);
      }
    }

    // Deterministic rename detection (signature equality without ambiguity)
    const consumedRemoved = new Set<string>();
    const consumedAdded = new Set<string>();

    for (const aSym of addedCandidates) {
      if (!aSym.signature) continue;

      // Find removed symbols with matching signature
      const matches = removedCandidates.filter(
        (r) => !consumedRemoved.has(r.name) && r.signature && r.signature === aSym.signature
      );

      // Must be unambiguous (exactly 1 match)
      if (matches.length === 1) {
        const rSym = matches[0];
        consumedRemoved.add(rSym.name);
        consumedAdded.add(aSym.name);
        deltas.push({
          changeType: 'RENAMED',
          symbolName: aSym.name,
          symbolKind: aSym.kind,
          oldSymbolName: rSym.name,
          oldSignature: rSym.signature,
          newSignature: aSym.signature,
          startLine: aSym.startLine,
          endLine: aSym.endLine,
        });
      }
    }

    // Emit remaining removed
    for (const rSym of removedCandidates) {
      if (!consumedRemoved.has(rSym.name)) {
        deltas.push({
          changeType: 'REMOVED',
          symbolName: rSym.name,
          symbolKind: rSym.kind,
          oldSignature: rSym.signature,
        });
      }
    }

    // Emit remaining added
    for (const aSym of addedCandidates) {
      if (!consumedAdded.has(aSym.name)) {
        deltas.push({
          changeType: 'ADDED',
          symbolName: aSym.name,
          symbolKind: aSym.kind,
          newSignature: aSym.signature,
          startLine: aSym.startLine,
          endLine: aSym.endLine,
        });
      }
    }

    // Deterministic sort by symbolName
    deltas.sort((a, b) => (a.symbolName < b.symbolName ? -1 : a.symbolName > b.symbolName ? 1 : 0));
    return deltas;
  }

  /**
   * Extracts generic symbols (FUNCTION, CLASS, etc.) from a ParseResult.
   */
  private extractSymbols(parse: ParseResult | null): InternalSymbol[] {
    if (!parse) return [];
    const symbols: InternalSymbol[] = [];

    // Functions
    for (const fn of parse.functions || []) {
      symbols.push({
        name: fn.name,
        kind: 'FUNCTION',
        signature: fn.signature,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
    }

    // Classes
    for (const cls of parse.classes || []) {
      symbols.push({
        name: cls.name,
        kind: 'CLASS',
      });
      for (const m of cls.methods || []) {
        symbols.push({
          name: `${cls.name}.${m.name}`,
          kind: 'FUNCTION',
          signature: m.signature,
          startLine: m.startLine,
          endLine: m.endLine,
        });
      }
    }

    return symbols;
  }

  /**
   * Deterministically computes import deltas between two parse results.
   */
  private diffImports(
    before: ParseResult | null,
    after: ParseResult | null
  ): ImportDelta[] {
    const beforeSet = new Set(before?.imports || []);
    const afterSet = new Set(after?.imports || []);

    const deltas: ImportDelta[] = [];

    // Added imports: in after, not in before
    for (const spec of afterSet) {
      if (!beforeSet.has(spec)) {
        deltas.push({
          changeType: 'ADDED',
          moduleSpecifier: spec,
          resolvedTarget: spec.startsWith('.') ? spec : 'EXTERNAL',
        });
      }
    }

    // Removed imports: in before, not in after
    for (const spec of beforeSet) {
      if (!afterSet.has(spec)) {
        deltas.push({
          changeType: 'REMOVED',
          moduleSpecifier: spec,
          resolvedTarget: spec.startsWith('.') ? spec : 'EXTERNAL',
        });
      }
    }

    deltas.sort((a, b) => (a.moduleSpecifier < b.moduleSpecifier ? -1 : a.moduleSpecifier > b.moduleSpecifier ? 1 : 0));
    return deltas;
  }

  /**
   * Deterministically computes export deltas between two parse results.
   */
  private diffExports(
    before: ParseResult | null,
    after: ParseResult | null
  ): ExportDelta[] {
    const beforeSet = new Set(before?.exports || []);
    const afterSet = new Set(after?.exports || []);

    const deltas: ExportDelta[] = [];

    // Added exports
    for (const exp of afterSet) {
      if (!beforeSet.has(exp)) {
        deltas.push({
          changeType: 'ADDED',
          exportedName: exp,
        });
      }
    }

    // Removed exports
    for (const exp of beforeSet) {
      if (!afterSet.has(exp)) {
        deltas.push({
          changeType: 'REMOVED',
          exportedName: exp,
        });
      }
    }

    deltas.sort((a, b) => (a.exportedName < b.exportedName ? -1 : a.exportedName > b.exportedName ? 1 : 0));
    return deltas;
  }
}
