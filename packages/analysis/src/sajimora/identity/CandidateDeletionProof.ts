import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as ts from 'typescript';
import { CandidateDeletionProof, CanonicalReferenceOccurrence, CrossVersionIdentityBundle } from '@sajimora/core';

const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const normalized = (node: ts.Node, sf: ts.SourceFile) => node.getText(sf)
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/\s+/g, ' ')
  .replace(/\b[A-Za-z_$][\w$]*\b(?=\s*[({<])/g, '<name>').trim();

/** Candidate absence is a separate fact from a mutation label or a missing contract. */
export function proveCandidateBindingAbsent(input: {
  occurrence: CanonicalReferenceOccurrence;
  persistentSymbolId: string;
  bundle?: CrossVersionIdentityBundle;
  parentPrograms?: ts.Program[];
  candidatePrograms?: ts.Program[];
  closureProvenance: string[];
}): CandidateDeletionProof {
  const { occurrence: occ, persistentSymbolId, bundle } = input;
  let mapping = bundle?.targetMappings.find(m => m.parent?.identityId === persistentSymbolId);
  let parentAmbiguous = false;
  // The discovery closure and the declaration index use different ID formats.
  // Link them through the parent checker declaration node, never through a name.
  if (!mapping && occ.resolutionStatus === 'RESOLVED' && occ.referencedSymbol === persistentSymbolId) {
    for (const program of input.parentPrograms ?? []) {
      const sf = program.getSourceFiles().find(file => file.fileName.replace(/\\/g, '/').toLowerCase() ===
        occ.sourceFile.replace(/\\/g, '/').toLowerCase());
      if (!sf) continue;
      let reference: ts.Node | undefined;
      const find = (node: ts.Node) => {
        if (node.getStart(sf) === occ.sourceSpan.start && node.getEnd() === occ.sourceSpan.end) {
          reference = node;
          return;
        }
        if (node.getStart(sf) <= occ.sourceSpan.start && node.getEnd() >= occ.sourceSpan.end) ts.forEachChild(node, find);
      };
      find(sf);
      if (!reference) continue;
      const checker = program.getTypeChecker();
      const symbol = checker.getSymbolAtLocation(reference);
      const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
      const matches = bundle?.targetMappings.filter(candidate => candidate.parent && target?.declarations?.some(decl => {
        const source = decl.getSourceFile();
        return source.fileName.replace(/\\/g, '/').endsWith('/' + candidate.parent!.moduleIdentity) &&
          decl.getStart(source) === candidate.parent!.sourceSpan.start &&
          decl.getEnd() === candidate.parent!.sourceSpan.end;
      })) ?? [];
      if (matches.length === 1) mapping = matches[0];
      if (matches.length > 1) parentAmbiguous = true;
      if (mapping) break;
    }
  }
  const parent = mapping?.parent;
  const programs = [...new Set(input.candidatePrograms ?? [])];
  const blockers: string[] = [];
  if (parentAmbiguous) blockers.push('AMBIGUOUS_PARENT_DECLARATION');
  const candidateBindingTargets: string[] = [];
  const plausibleCandidateDeclarations: string[] = [];
  const candidateAliasChain: string[] = [];
  const candidateFiles: string[] = [];
  const parentBinding = occ.resolutionStatus === 'RESOLVED' && occ.referencedSymbol === persistentSymbolId &&
    parent ? occ.declarationSymbol : null;
  if (!parentBinding) blockers.push('PARENT_BINDING_UNPROVEN');
  if (!parent) blockers.push('PARENT_DECLARATION_UNAVAILABLE');
  if (mapping?.status !== 'REMOVED_DECLARATION') blockers.push(`TARGET_IDENTITY_${mapping?.status ?? 'MISSING'}`);
  if (!programs.length || bundle?.status !== 'COMPLETE' ||
      bundle.blockers.includes('PROGRAM_DISCOVERY_INCOMPLETE')) blockers.push('CANDIDATE_UNIVERSE_INCOMPLETE');
  for (const candidateId of mapping?.plausibleCandidateIds ?? []) {
    plausibleCandidateDeclarations.push(candidateId);
  }

  // Any added declaration in a changed file can be a rename, move, or
  // replacement, including a change of declaration kind.
  if (parent && bundle?.targetMappings.some(m => m.status === 'ADDED_DECLARATION')) {
    blockers.push('POSSIBLE_REPLACEMENT_IN_CHANGED_FILES');
    for (const added of bundle.targetMappings.filter(m => m.status === 'ADDED_DECLARATION' && m.candidate)) {
      plausibleCandidateDeclarations.push(`${added.candidate!.identityId}:${added.candidate!.moduleIdentity}`);
    }
  }

  if (parent && programs.length) {
    const seen = new Set<string>();
    for (const program of programs) {
      const checker = program.getTypeChecker();
      for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        const relativeFile = path.relative(program.getCurrentDirectory(), sf.fileName).replace(/\\/g, '/');
        candidateFiles.push(`${relativeFile}|${digest(sf.text)}`);
        const visit = (node: ts.Node) => {
          if (ts.isExportDeclaration(node) && !node.exportClause) {
            blockers.push('STAR_REEXPORT_CANNOT_PROVE_ABSENCE');
          }
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
              !checker.getSymbolAtLocation(node.moduleSpecifier)) {
            blockers.push('UNRESOLVED_CANDIDATE_MODULE');
          }
          if (ts.isIdentifier(node) && node.text === parent.localName) {
            const symbol = checker.getSymbolAtLocation(node);
            const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
            const id = `${relativeFile}:${node.getStart(sf)}:${resolved?.getName() ?? '<unresolved>'}`;
            if (!seen.has(id)) { seen.add(id); candidateBindingTargets.push(id); }
            if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
              candidateAliasChain.push(`${relativeFile}:${node.getStart(sf)}:${symbol.getName()}->${resolved?.getName() ?? '<unresolved>'}`);
            }
            if (!resolved) blockers.push('UNRESOLVED_CANDIDATE_REFERENCE');
          }
          if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
              ts.isTypeAliasDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
            const name = (node as ts.NamedDeclaration).name;
            if (name && ts.isIdentifier(name) &&
                (name.text === parent.localName || digest(normalized(node, sf)) === parent.astFingerprint)) {
              blockers.push('PLAUSIBLE_CANDIDATE_DECLARATION');
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
  }
  if (candidateFiles.length === 0) blockers.push('CANDIDATE_UNIVERSE_EMPTY');
  if (candidateBindingTargets.length) blockers.push('CANDIDATE_BINDING_OR_ALIAS_PRESENT');
  const uniqueBlockers = [...new Set(blockers)].sort();
  const candidateUniverseFingerprint = digest([...new Set(candidateFiles)].sort().join('\n'));
  const status: CandidateDeletionProof['status'] = parentAmbiguous || mapping?.status === 'AMBIGUOUS' ||
    (mapping?.plausibleCandidateIds.length ?? 0) > 1
    ? 'AMBIGUOUS' : uniqueBlockers.length ? 'IDENTITY_UNPROVEN' : 'PROVEN_ABSENT';
  const deduplicationKey = [occ.referencedSymbol, occ.declarationSymbol, occ.semanticRole,
    occ.usageRole, occ.sourceFile, occ.sourceSpan.start, occ.sourceSpan.end].join('|');
  const payload = JSON.stringify({ persistentSymbolId, occurrenceId: occ.occurrenceId,
    sourceFile: occ.sourceFile, sourceSpan: occ.sourceSpan, status, parentBinding,
    candidateUniverseFingerprint, candidateBindingTargets: candidateBindingTargets.sort(),
    plausibleCandidateDeclarations: plausibleCandidateDeclarations.sort(),
    candidateAliasChain: candidateAliasChain.sort(), aliasChain: occ.provenance,
    closureProvenance: [...input.closureProvenance].sort(), deduplicationKey, blockers: uniqueBlockers });
  const proofHash = digest(payload);
  return {
    status, evidenceId: digest(`CANDIDATE_BINDING_ABSENCE|${proofHash}`), proofHash,
    occurrenceId: occ.occurrenceId, persistentSymbolId, declarationId: parent?.identityId ?? persistentSymbolId,
    sourceFile: occ.sourceFile, sourceSpan: occ.sourceSpan, parentBinding,
    candidateBindingTargets, plausibleCandidateDeclarations,
    aliasChain: occ.provenance, candidateAliasChain,
    closureProvenance: input.closureProvenance, deduplicationKey,
    candidateUniverseFingerprint,
    candidateUniverseComplete: candidateFiles.length > 0 && programs.length > 0 && bundle?.status === 'COMPLETE' &&
      !bundle.blockers.includes('PROGRAM_DISCOVERY_INCOMPLETE'),
    blockers: uniqueBlockers
  };
}
