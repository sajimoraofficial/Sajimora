/**
 * SAJIMORA V32 — Deterministic Commit & PR Message Extractor
 * Subordinate to sajimora_v32_foundation_spec.md §1.3 (ECM-R7) & §8 (OQ-2).
 *
 * Deterministic regex-based extractor. Zero LLM, zero ML.
 */

import {
  ExpectedFileChange,
  ExpectedSymbolChange,
  ExpectedBehavioralObligation,
  ExpectationProvenance,
} from '../types';
import { normalizePosixPath } from './validator';

export interface CommitExtractionResult {
  expectedFiles: ExpectedFileChange[];
  expectedSymbols: ExpectedSymbolChange[];
  expectedBehavioralObligations: ExpectedBehavioralObligation[];
}

/**
 * Deterministically extracts expectations from a commit message or PR description.
 */
export function extractExpectationsFromText(
  text: string,
  isPr: boolean = false
): CommitExtractionResult {
  const expectedFiles: ExpectedFileChange[] = [];
  const expectedSymbols: ExpectedSymbolChange[] = [];
  const expectedBehavioralObligations: ExpectedBehavioralObligation[] = [];

  if (!text || typeof text !== 'string') {
    return { expectedFiles, expectedSymbols, expectedBehavioralObligations };
  }

  const provenance: ExpectationProvenance = isPr
    ? 'PR_DESCRIPTION_PARSED'
    : 'COMMIT_MESSAGE_PARSED';

  const lines = text.split(/\r?\n/);

  // 1. Scan for explicit file path mentions or markdown diff lines
  // e.g. "modified: src/parser/AstExtractor.ts" or "File: src/index.ts" or bullet points with file paths
  const filePathRegex = /(?:modified|added|deleted|renamed|file|path):\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/i;
  const pathInBackticksRegex = /`([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)`/g;

  // Track unique file paths extracted
  const seenFiles = new Set<string>();

  for (const line of lines) {
    // Check explicit file label
    const match = line.match(filePathRegex);
    if (match && match[1]) {
      const p = normalizePosixPath(match[1]);
      if (p && !seenFiles.has(p)) {
        seenFiles.add(p);
        let changeType: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' = 'MODIFIED';
        if (/add|new/i.test(line)) changeType = 'ADDED';
        else if (/del|remove/i.test(line)) changeType = 'DELETED';
        else if (/rename/i.test(line)) changeType = 'RENAMED';

        expectedFiles.push({
          filePath: p,
          changeType,
          provenance,
          confidence: 0.85,
        });
      }
    }

    // Check backticks for files
    let backtickMatch: RegExpExecArray | null;
    while ((backtickMatch = pathInBackticksRegex.exec(line)) !== null) {
      const candidate = backtickMatch[1];
      // Must have file extension and directory separator
      if (candidate.includes('/') || candidate.includes('\\')) {
        const p = normalizePosixPath(candidate);
        if (p && !seenFiles.has(p)) {
          seenFiles.add(p);
          expectedFiles.push({
            filePath: p,
            changeType: 'MODIFIED',
            provenance,
            confidence: 0.75,
          });
        }
      }
    }

    // Check for symbol changes: e.g. "function myFunction" or "symbol: mySymbol"
    const symbolRegex = /(?:function|class|method|interface|symbol)\s+`?([a-zA-Z0-9_$]+)`?/i;
    const symMatch = line.match(symbolRegex);
    if (symMatch && symMatch[1]) {
      const symName = symMatch[1];
      // Associate with the first extracted file or empty if unknown
      const associatedFile = expectedFiles.length > 0 ? expectedFiles[0].filePath : '';
      if (associatedFile) {
        let symChangeType: 'ADDED' | 'REMOVED' | 'RENAMED' | 'SIGNATURE_CHANGED' = 'SIGNATURE_CHANGED';
        if (/add|new/i.test(line)) symChangeType = 'ADDED';
        else if (/remove|delete/i.test(line)) symChangeType = 'REMOVED';
        else if (/rename/i.test(line)) symChangeType = 'RENAMED';

        expectedSymbols.push({
          filePath: associatedFile,
          symbolName: symName,
          symbolKind: /class/i.test(line) ? 'CLASS' : /interface/i.test(line) ? 'INTERFACE' : 'FUNCTION',
          changeType: symChangeType,
          provenance,
          confidence: 0.75,
        });
      }
    }

    // Check for behavioral obligations or issue references: e.g. "Closes #123" or "Fixes #456"
    const closesRegex = /(?:closes|fixes|resolves)\s+(#\d+|[A-Z]+-\d+)/i;
    const closesMatch = line.match(closesRegex);
    if (closesMatch && closesMatch[1]) {
      expectedBehavioralObligations.push({
        obligationId: closesMatch[1],
        description: `Satisfy resolved issue ${closesMatch[1]}`,
        verificationStrategy: 'STRUCTURAL_AST',
        targetEntities: expectedFiles.map((f) => f.filePath),
        contentHints: [closesMatch[1]],
        provenance,
        confidence: 0.80,
      });
    }
  }

  return {
    expectedFiles,
    expectedSymbols,
    expectedBehavioralObligations,
  };
}
