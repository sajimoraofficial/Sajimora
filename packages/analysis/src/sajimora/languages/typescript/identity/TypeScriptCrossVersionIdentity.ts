import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as ts from 'typescript';
import { binaryCompare, CanonicalReferenceOccurrence, CanonicalSymbolIdentity, CrossVersionConsumerMapping, CrossVersionIdentityBundle, CrossVersionSymbolMapping, IdentityEvidence, RepositoryAnalysisUniverse, SymbolKind, SymbolRef } from '@sajimora/core';
import { GitDiffFileEvidence } from '../../../snapshots/GitDiffReader';
import { TypeScriptProgramBuildResult } from '../programs/TypeScriptProgramBuilder';
import { AnalysisContext } from '../../../context/AnalysisContext';
import { ConsumerDiscoveryCoordinator } from '../../../closures/ConsumerDiscoveryCoordinator';

const slash = (s: string) => s.replace(/\\/g, '/');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const location = (d: CanonicalSymbolIdentity) => ({ file: d.moduleIdentity, line: d.sourceSpan.line, column: d.sourceSpan.column });
const normalizedText = (node: ts.Node, sf: ts.SourceFile) => node.getText(sf).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/\s+/g, ' ').replace(/\b[A-Za-z_$][\w$]*\b(?=\s*[({<])/g, '<name>').trim();

export const programDiscoveryCache = new WeakMap<ts.Program, Map<string, import('../../../closures/ConsumerDiscoveryCoordinator').ConsumerDiscoveryEvidence>>();

function canonicalizeDiffPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().trim();
}

export class TypeScriptDeclarationIndexer {
  index(build: TypeScriptProgramBuildResult, root: string, filterFiles?: ReadonlySet<string>): CanonicalSymbolIdentity[] {
    const out: CanonicalSymbolIdentity[] = [];
    const findOwner = (file: string) => {
      const candidates = build.projects.filter(p => {
        if (p.identity.rootFiles.includes(file)) return true;
        if (!p.identity.configFile) return true;
        const pdir = slash(path.dirname(p.identity.configFile));
        return pdir === '.' || file === pdir || file.startsWith(pdir + '/');
      });
      if (candidates.length <= 1) return candidates[0] ?? null;
      candidates.sort((a, b) => {
        const adir = a.identity.configFile ? slash(path.dirname(a.identity.configFile)) : '';
        const bdir = b.identity.configFile ? slash(path.dirname(b.identity.configFile)) : '';
        return bdir.length - adir.length;
      });
      return candidates[0];
    };

    for (const project of [...build.projects].sort((a,b) => binaryCompare(a.identity.projectId, b.identity.projectId))) for (const sf of project.program.getSourceFiles()) {
      const rel = slash(path.relative(root, sf.fileName)); if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
      if (filterFiles && !filterFiles.has(canonicalizeDiffPath(rel))) continue;
      if (build.projects.length > 1 && findOwner(rel) !== project) continue;
      const ordinals = new Map<string, number>();
      const visit = (node: ts.Node, owners: string[]) => {
        let name: string | undefined; let kind: string | undefined; let params = '';
        let isFunctionLike = false;
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
          isFunctionLike = true;
          name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
          kind = ts.SyntaxKind[node.kind];
          params = node.parameters.map(p => p.type?.getText(sf) ?? '?').join(',');
        } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
          name = node.name?.text;
          kind = ts.SyntaxKind[node.kind];
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const isModuleLevel = node.parent && ts.isVariableDeclarationList(node.parent) &&
                                node.parent.parent && ts.isVariableStatement(node.parent.parent) &&
                                node.parent.parent.parent && ts.isSourceFile(node.parent.parent.parent);
          if (isModuleLevel) {
            name = node.name.text;
            kind = 'VariableDeclaration';
          }
        }
        const nextOwners = name && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) ? [...owners, name] : owners;
        if (name && kind) {
          const key = `${owners.join('.')}:${kind}:${name}`;
          const ordinal = ordinals.get(key) ?? 0;
          ordinals.set(key, ordinal + 1);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const end = sf.getLineAndCharacterOfPosition(node.getEnd());
          const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
          const exported = modifiers?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword) ?? (node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent && ts.isVariableStatement(node.parent.parent) && node.parent.parent.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword));
          const identityId = hash(`${project.identity.projectId}|${rel}|${owners.join('.')}|${kind}|${name}|${ordinal}`);
          out.push({ identityId, projectId: project.identity.projectId, moduleIdentity: rel, ownerChain: owners, localName: name, declarationKind: kind, declarationOrdinal: ordinal, sourceSpan: { start: node.getStart(sf), end: node.getEnd(), line: pos.line + 1, column: pos.character + 1, endLine: end.line + 1, endColumn: end.character + 1 }, exportPaths: exported ? [`${rel}#${name}`] : [], parameterShape: params, astFingerprint: hash(normalizedText(node, sf)) });
        }
        if (!isFunctionLike) {
          ts.forEachChild(node, child => visit(child, nextOwners));
        }
      }; visit(sf, []);
    }
    return out.sort((a,b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0));
  }
}

export class TypeScriptReferenceIndexer {
  index(build: TypeScriptProgramBuildResult, root: string, target: CanonicalSymbolIdentity): CanonicalReferenceOccurrence[] {
    const out: CanonicalReferenceOccurrence[] = [];
    for (const project of build.projects) {
      const checker = project.program.getTypeChecker();
      const declarationFile = project.program.getSourceFiles().find(sf => slash(path.relative(root, sf.fileName)) === target.moduleIdentity);
      const declaration = declarationFile && this.findNode(declarationFile, target.sourceSpan.start, target.sourceSpan.end);
      const nameNode = declaration && this.nameNode(declaration); let targetSymbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
      if (!targetSymbol) continue; if (targetSymbol.flags & ts.SymbolFlags.Alias) targetSymbol = checker.getAliasedSymbol(targetSymbol);
      for (const sf of project.program.getSourceFiles()) {
        const rel = slash(path.relative(root, sf.fileName)); if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
        const counters = new Map<string, number>();
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) && node !== nameNode && !this.isDeclarationName(node)) {
            let symbol = checker.getSymbolAtLocation(node); if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const boundToTarget = symbol === targetSymbol; const sameSpellingUnbound = node.text === target.localName && symbol !== targetSymbol;
            if (boundToTarget || sameSpellingUnbound) {
              const role = this.role(node); const enclosing = this.enclosingAnchor(node, sf); const base = `${rel}|${enclosing}|${role}`; const ordinal = counters.get(base) ?? 0; counters.set(base, ordinal + 1);
              const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf)); const neighborhood = hash(node.parent.getText(sf).replace(/\s+/g, ' ')); const occurrenceId = hash(`${base}|${ordinal}`);
              out.push({ occurrenceId, sourceFile: rel, sourceSpan: { start: node.getStart(sf), end: node.getEnd(), line: pos.line + 1, column: pos.character + 1 }, syntaxKind: node.kind, semanticRole: this.typePosition(node) ? 'TYPE' : 'VALUE', usageRole: role, referencedSymbol: target.identityId, declarationSymbol: boundToTarget ? target.identityId : '<different-or-unresolved>', signatureAnchor: neighborhood, resolutionStatus: boundToTarget ? 'RESOLVED' : 'UNRESOLVED', enumerationStatus: 'COMPLETE', provenance: [] });
            }
          }
          ts.forEachChild(node, visit);
        }; visit(sf);
      }
    }
    return [...new Map(out.map(o => [o.occurrenceId, o])).values()].sort((a,b) => binaryCompare(a.occurrenceId, b.occurrenceId));
  }
  private findNode(sf: ts.SourceFile, start: number, end: number): ts.Node | undefined { let found: ts.Node | undefined; const visit=(n:ts.Node)=>{ if(n.getStart(sf)===start && n.getEnd()===end) found=n; else if(start>=n.getStart(sf)&&end<=n.getEnd()) ts.forEachChild(n,visit); }; visit(sf); return found; }
  private nameNode(n: ts.Node): ts.Node | undefined { return (n as ts.NamedDeclaration).name; }
  private isDeclarationName(n: ts.Identifier): boolean { return (n.parent as ts.NamedDeclaration).name === n || ts.isImportSpecifier(n.parent) || ts.isImportClause(n.parent); }
  private enclosingAnchor(n: ts.Node, sf: ts.SourceFile): string { let p=n.parent; while(p && !ts.isSourceFile(p)){ if((ts.isFunctionLike(p)||ts.isClassLike(p)||ts.isInterfaceDeclaration(p)) && (p as ts.NamedDeclaration).name) return `${ts.SyntaxKind[p.kind]}:${(p as ts.NamedDeclaration).name!.getText(sf)}`; p=p.parent; } return '<module>'; }
  private role(n: ts.Identifier): CanonicalReferenceOccurrence['usageRole'] { if(ts.isCallExpression(n.parent)&&n.parent.expression===n) return 'CALL_SITE'; if(ts.isTypeReferenceNode(n.parent)) return 'TYPE_ANNOTATION'; if(ts.isHeritageClause(n.parent.parent)) return 'INHERITANCE'; if(ts.isExportSpecifier(n.parent)) return 'RE_EXPORTER'; return 'REFERENCE_OCCURRENCE'; }
  private typePosition(n: ts.Node): boolean { for(let p=n.parent;p;p=p.parent){ if(ts.isTypeNode(p)) return true; if(ts.isExpressionStatement(p)||ts.isBlock(p)||ts.isSourceFile(p)) return false; } return false; }
}

export class TypeScriptClosureReferenceIndexer {
  index(build: TypeScriptProgramBuildResult, root: string, target: CanonicalSymbolIdentity): CanonicalReferenceOccurrence[] {
    const occurrences: CanonicalReferenceOccurrence[] = [];
    for (const project of build.projects) {
      const files = project.program.getSourceFiles().map(sf=>slash(sf.fileName)).filter(f=>{const r=slash(path.relative(root,f));return !r.startsWith('../')&&!path.isAbsolute(r)}).sort();
      if (!files.some(f=>slash(path.relative(root,f))===target.moduleIdentity)) continue;

      let discovery: import('../../../closures/ConsumerDiscoveryCoordinator').ConsumerDiscoveryEvidence;
      let progCache = programDiscoveryCache.get(project.program);
      if (!progCache) {
        progCache = new Map();
        programDiscoveryCache.set(project.program, progCache);
      }

      const cached = progCache.get(target.identityId);
      if (cached) {
        discovery = cached;
      } else {
        const universe: RepositoryAnalysisUniverse = { rootPath: slash(path.resolve(root)), discoveredFiles: files, discoveredFileSet: new Set(files), excludedFiles: new Map(), unsupportedFiles: [], unreadableFiles: [], parseFailures: new Map(), discoveryStatus: build.universe.discoveryStatus, discoveryEvidence: 'Phase 3 reuse of Phase 2 program universe', compilerOptions: project.options as Record<string,unknown> };
        const kindMap: Record<string,SymbolKind>={FunctionDeclaration:'FUNCTION',MethodDeclaration:'METHOD',Constructor:'METHOD',ClassDeclaration:'CLASS',InterfaceDeclaration:'INTERFACE',TypeAliasDeclaration:'TYPE_ALIAS',EnumDeclaration:'ENUM',VariableDeclaration:'FIELD'};
        const absolute=path.resolve(root,...target.moduleIdentity.split('/')); const kind=kindMap[target.declarationKind]??'FIELD'; const ref: SymbolRef={persistentSymbolId:target.identityId,symbolId:target.localName,qualifiedName:target.localName,kind,ownerId:null,declarationLocation:{filePath:absolute,line:target.sourceSpan.line},fingerprint:{value:target.astFingerprint,components:{globallyQualifiedOwner:absolute,symbolLocalName:target.localName,kind,parameterTypeFingerprint:target.parameterShape}}};
        const context=new AnalysisContext(universe,{program:project.program,compilerOptions:project.options});
        discovery = new ConsumerDiscoveryCoordinator().discover(context,ref,universe);
        progCache.set(target.identityId, discovery);
      }

      const rollup = discovery.rollup;
      const counters=new Map<string,number>();
      for(const occurrence of rollup.occurrences){
        const rel=slash(path.relative(root,occurrence.sourceFile));
        const base=`${rel}|${occurrence.usageRole}|${occurrence.syntaxKind}`;
        const ordinal=counters.get(base)??0;
        counters.set(base,ordinal+1);
        occurrences.push({
          ...occurrence,
          sourceFile: rel,
          consumerFile: rel,
          occurrenceId: occurrence.occurrenceId,
          correlationKey: `${base}|${ordinal}`
        } as any);
      }
    }
    return [...new Map(occurrences.map(o=>[o.occurrenceId,o])).values()].sort((a,b)=>(a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0));
  }
}

export class TypeScriptConsumerIdentityMapper {
  map(parent: CanonicalReferenceOccurrence[], candidate: CanonicalReferenceOccurrence[]): CrossVersionConsumerMapping[] {
    const candidatesByExactId = new Map<string, CanonicalReferenceOccurrence[]>();
    const candidatesByCorrelation = new Map<string, CanonicalReferenceOccurrence[]>();
    for (const c of candidate) {
      candidatesByExactId.set(c.occurrenceId, [...(candidatesByExactId.get(c.occurrenceId) ?? []), c]);
      const corr = (c as any).correlationKey;
      if (corr) {
        candidatesByCorrelation.set(corr, [...(candidatesByCorrelation.get(corr) ?? []), c]);
      }
    }

    const usedCandidateIds = new Set<string>();
    const result: CrossVersionConsumerMapping[] = [];

    for (const p of [...parent].sort((a,b) => (a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0))) {
      let selected: CanonicalReferenceOccurrence | undefined;
      let isAmbiguous = false;

      const exactMatches = candidatesByExactId.get(p.occurrenceId) ?? [];
      if (exactMatches.length === 1) {
        selected = exactMatches[0];
      } else if (exactMatches.length > 1) {
        isAmbiguous = true;
      } else {
        const corr = (p as any).correlationKey;
        const corrMatches = corr ? candidatesByCorrelation.get(corr) ?? [] : [];
        if (corrMatches.length === 1) {
          selected = corrMatches[0];
        } else if (corrMatches.length > 1) {
          isAmbiguous = true;
        }
      }

      if (selected && usedCandidateIds.has(selected.occurrenceId)) {
        isAmbiguous = true;
        selected = undefined;
      }

      if (selected) {
        usedCandidateIds.add(selected.occurrenceId);
      }

      const bindingRemoved = selected?.declarationSymbol === '<different-or-unresolved>';
      const lifecycle = isAmbiguous
        ? 'AMBIGUOUS_ACROSS_VERSIONS'
        : bindingRemoved
          ? 'BINDING_REMOVED_IN_CANDIDATE'
          : selected
            ? (selected.signatureAnchor === p.signatureAnchor ? 'STABLE_UNCHANGED' : 'STABLE_CHANGED_SAME_COMMIT')
            : 'REMOVED_IN_CANDIDATE';

      const mappingObj: any = {
        mappingId: hash(`consumer|${p.occurrenceId}|${selected?.occurrenceId ?? lifecycle}`),
        lifecycle,
        parentOccurrenceId: p.occurrenceId,
        ...(selected ? { candidateOccurrenceId: selected.occurrenceId } : {}),
        targetIdentity: isAmbiguous ? 'UNCERTAIN' : bindingRemoved ? 'DIFFERENT' : (selected || (lifecycle === 'REMOVED_IN_CANDIDATE' && p.declarationSymbol !== '<different-or-unresolved>')) ? 'SAME' : 'UNCERTAIN',
        evidence: [{
          evidenceId: hash(`role|${p.occurrenceId}`),
          kind: 'SYNTAX_ROLE',
          parentLocation: { file: slash(p.sourceFile), line: p.sourceSpan.line, column: p.sourceSpan.column },
          detail: `${p.usageRole}:${p.syntaxKind}`
        }]
      };
      Object.defineProperty(mappingObj, 'parentOccurrence', {
        value: p,
        enumerable: false,
        writable: true,
        configurable: true
      });
      result.push(mappingObj);
    }

    for (const c of [...candidate].filter(c => !usedCandidateIds.has(c.occurrenceId) && c.declarationSymbol !== '<different-or-unresolved>').sort((a,b) => (a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0))) {
      result.push({
        mappingId: hash(`added|${c.occurrenceId}`),
        lifecycle: 'ADDED_IN_CANDIDATE',
        candidateOccurrenceId: c.occurrenceId,
        targetIdentity: 'SAME',
        evidence: []
      });
    }

    return result.sort((a,b) => (a.mappingId < b.mappingId ? -1 : a.mappingId > b.mappingId ? 1 : 0));
  }
}

export class TypeScriptCrossVersionIdentityAnalyzer {
  analyze(parent: TypeScriptProgramBuildResult, candidate: TypeScriptProgramBuildResult, parentRoot: string, candidateRoot: string, diffs: GitDiffFileEvidence[]): CrossVersionIdentityBundle {
    const diffFiles = new Set<string>();
    for (const d of diffs) {
      if (d.parentPath) diffFiles.add(canonicalizeDiffPath(d.parentPath));
      if (d.candidatePath) diffFiles.add(canonicalizeDiffPath(d.candidatePath));
    }
    const declarations = new TypeScriptDeclarationIndexer(); const mapper = new TypeScriptTargetIdentityMapper();
    const bundle = mapper.map(declarations.index(parent, parentRoot, diffFiles), declarations.index(candidate, candidateRoot, diffFiles), diffs);
    const references = new TypeScriptClosureReferenceIndexer(); const consumers = new TypeScriptConsumerIdentityMapper();
    const hasHunks = diffs.some(d => d.hunks && d.hunks.length > 0);
    for (const mapping of bundle.targetMappings) {
      if (mapping.parent && mapping.status !== 'AMBIGUOUS' && (mapping.status !== 'UNRESOLVED' || Boolean(mapping.candidate))) {
        const inDiffHunk = mapping.evidence.some(e => e.kind === 'DIFF_CORRESPONDENCE' && e.detail && !e.detail.includes('hunks=[]'));
        const changed = !mapping.candidate || mapping.parent.astFingerprint !== mapping.candidate.astFingerprint || mapping.parent.parameterShape !== mapping.candidate.parameterShape;
        if (hasHunks && !inDiffHunk && !changed && mapping.status !== 'REMOVED_DECLARATION') {
          continue;
        }
        const parentRefs = references.index(parent, parentRoot, mapping.parent);
        const candRefs = mapping.candidate ? references.index(candidate, candidateRoot, mapping.candidate) : [];
        const cms = consumers.map(parentRefs, candRefs);
        for (const cm of cms) {
          Object.defineProperty(cm, 'targetParentId', {
            value: mapping.parent.identityId,
            enumerable: false,
            writable: true,
            configurable: true
          });
          if (mapping.candidate) {
            Object.defineProperty(cm, 'targetCandidateId', {
              value: mapping.candidate.identityId,
              enumerable: false,
              writable: true,
              configurable: true
            });
          }
        }
        bundle.consumerMappings.push(...cms);
      }
    }
    bundle.consumerMappings.sort((a,b) => (a.mappingId < b.mappingId ? -1 : a.mappingId > b.mappingId ? 1 : 0));
    if (parent.universe.discoveryStatus !== 'DISCOVERY_COMPLETE' || candidate.universe.discoveryStatus !== 'DISCOVERY_COMPLETE') { bundle.status = 'INCOMPLETE'; bundle.blockers.push('PROGRAM_DISCOVERY_INCOMPLETE'); }
    bundle.blockers.sort(); bundle.boundaryAudit.compilerObjectsInArtifact=this.countCompilerObjects(bundle); return bundle;
  }
  private countCompilerObjects(value: unknown, seen=new WeakSet<object>()): number { if(!value||typeof value!=='object')return 0;const object=value as Record<string,unknown>;if(seen.has(object))return 0;seen.add(object);if((typeof object.getSourceFile==='function'&&typeof object.kind==='number')||(typeof object.getFlags==='function'&&Array.isArray(object.declarations)))return 1;return Object.values(object).reduce<number>((sum,item)=>sum+this.countCompilerObjects(item,seen),0); }
}

export class TypeScriptTargetIdentityMapper {
  map(parent: CanonicalSymbolIdentity[], candidate: CanonicalSymbolIdentity[], diffs: GitDiffFileEvidence[]): CrossVersionIdentityBundle {
    const affectedParent = parent.filter(p => diffs.some(d => d.parentPath === p.moduleIdentity));
    const mappings = affectedParent.map(p => this.mapOne(p, candidate, diffs));
    const mapped = new Set(mappings.map(m => m.candidate?.identityId).filter(Boolean));
    for (const c of candidate.filter(c => diffs.some(d => d.candidatePath === c.moduleIdentity) && !mapped.has(c.identityId))) mappings.push({ candidate: c, status: 'ADDED_DECLARATION', evidence: [], plausibleCandidateIds: [] });
    mappings.sort((a,b) => {
      const ak = a.parent?.identityId ?? a.candidate!.identityId;
      const bk = b.parent?.identityId ?? b.candidate!.identityId;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    const blockers = mappings.filter(m => m.status === 'AMBIGUOUS' || (m.status === 'UNRESOLVED' && !m.candidate)).map(m => `${m.status}:${m.parent?.identityId ?? m.candidate?.identityId}`);
    return { targetMappings: mappings, consumerMappings: [], status: blockers.length ? 'INCOMPLETE' : 'COMPLETE', blockers, phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' }, boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 } };
  }
  private mapOne(p: CanonicalSymbolIdentity, candidates: CanonicalSymbolIdentity[], diffs: GitDiffFileEvidence[]): CrossVersionSymbolMapping {
    const diff = diffs.find(d => d.parentPath === p.moduleIdentity); if (!diff?.candidatePath) return { parent: p, status: 'REMOVED_DECLARATION', evidence: [], plausibleCandidateIds: [] };
    const pool = candidates.filter(c => c.moduleIdentity === diff.candidatePath && c.declarationKind === p.declarationKind && c.ownerChain.join('.') === p.ownerChain.join('.'));
    const exact = pool.filter(c => c.localName === p.localName && c.declarationOrdinal === p.declarationOrdinal);
    const structural = pool.filter(c => c.astFingerprint === p.astFingerprint && c.parameterShape === p.parameterShape);
    const viable = exact.length ? exact : structural; const containing = diff.hunks.filter(h => p.sourceSpan.line >= h.parentStart && p.sourceSpan.line <= h.parentStart + Math.max(0,h.parentLines-1)); const evidence: IdentityEvidence[] = [{ evidenceId: hash(`diff|${p.identityId}|${diff.candidatePath}|${JSON.stringify(containing)}`), kind: 'DIFF_CORRESPONDENCE', parentLocation: location(p), detail: `${diff.status}:${p.moduleIdentity}->${diff.candidatePath};hunks=${JSON.stringify(containing)}` }];
    
    if (viable.length === 0) {
      if (containing.length > 0) {
        const hunkCandidates = pool.filter(c => containing.some(h => c.sourceSpan.line >= h.candidateStart && c.sourceSpan.line <= h.candidateStart + Math.max(0, h.candidateLines - 1)));
        if (hunkCandidates.length === 0) {
          evidence.push({ evidenceId: hash(`deleted|${p.identityId}`), kind: 'DIFF_CORRESPONDENCE', parentLocation: location(p), detail: `DECLARATION_DELETED_IN_DIFF_HUNK:${p.localName}` });
          return { parent: p, status: 'REMOVED_DECLARATION', evidence, plausibleCandidateIds: [] };
        }
      }
      return { parent: p, status: 'UNRESOLVED', evidence, plausibleCandidateIds: [] };
    }
    
    if (viable.length > 1) {
      return { parent: p, status: 'AMBIGUOUS', evidence, plausibleCandidateIds: viable.map(v => v.identityId).sort() };
    }

    const match = viable[0];
    evidence.push({
      evidenceId: hash(`kind|${p.identityId}|${match.identityId}`),
      kind: 'DECLARATION_KIND',
      parentLocation: location(p),
      candidateLocation: location(match),
      detail: p.declarationKind
    });
    const moved = p.moduleIdentity !== match.moduleIdentity;
    const renamed = p.localName !== match.localName;
    return {
      parent: p,
      candidate: match,
      status: renamed ? 'RENAMED_DECLARATION' : moved ? 'MOVED_DECLARATION' : 'SAME_DECLARATION',
      evidence,
      plausibleCandidateIds: [match.identityId]
    };
  }
}
