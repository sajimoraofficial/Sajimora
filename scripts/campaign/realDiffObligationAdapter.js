"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveRealDiffObligations = deriveRealDiffObligations;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const ts = __importStar(require("typescript"));
function git(root, args) {
    return (0, child_process_1.execFileSync)('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function sourceAt(root, revision, file) {
    try {
        return git(root, ['show', `${revision}:${file}`]);
    }
    catch {
        return undefined;
    }
}
function contract(node) {
    return {
        parameters: node.parameters.map(parameter => ({
            name: parameter.name.getText(),
            type: parameter.type?.getText() ?? 'unknown',
            isRequired: !parameter.questionToken && !parameter.initializer
        })),
        returnType: node.type?.getText()
    };
}
function declarations(file, text) {
    if (text === undefined)
        return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const result = [];
    const add = (name, kind, node, signature) => {
        if (!name)
            return;
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        result.push({ name: name.text, kind, file, line: pos.line + 1, text: node.getText(source), contract: signature ? contract(signature) : {} });
    };
    for (const node of source.statements) {
        if (ts.isFunctionDeclaration(node))
            add(node.name, 'FUNCTION', node, node);
        else if (ts.isClassDeclaration(node)) {
            add(node.name, 'CLASS', node);
            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name))
                    add(member.name, 'METHOD', member, member);
                else if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name))
                    add(member.name, 'METHOD', member, member);
                else if (ts.isSetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name))
                    add(member.name, 'METHOD', member, member);
            }
        }
        else if (ts.isInterfaceDeclaration(node))
            add(node.name, 'INTERFACE', node);
        else if (ts.isTypeAliasDeclaration(node))
            add(node.name, 'TYPE_ALIAS', node);
        else if (ts.isEnumDeclaration(node))
            add(node.name, 'ENUM', node);
        else if (ts.isVariableStatement(node))
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name))
                    add(declaration.name, 'FIELD', declaration);
            }
    }
    return result;
}
function key(declaration) { return `${declaration.file}::${declaration.kind}::${declaration.name}`; }
function makeObligation(repositoryRoot, before, after) {
    const current = after ?? before;
    const absoluteFile = path.resolve(repositoryRoot, current.file).replace(/\\/g, '/');
    const persistentSymbolId = `${absoluteFile}::${current.kind}::${current.name}`;
    const symbol = {
        persistentSymbolId,
        symbolId: current.name,
        fingerprint: {
            value: `${persistentSymbolId}:${current.contract.parameters?.map(p => p.type).join(',') ?? ''}`,
            components: { globallyQualifiedOwner: absoluteFile, symbolLocalName: current.name, kind: current.kind, parameterTypeFingerprint: current.contract.parameters?.map(p => p.type).join(',') ?? '' }
        },
        qualifiedName: current.name,
        kind: current.kind,
        ownerId: null,
        declarationLocation: { filePath: absoluteFile, line: current.line }
    };
    const classification = !after ? 'SYMBOL_DELETED' : (current.kind === 'INTERFACE' || current.kind === 'TYPE_ALIAS' ? 'TYPE_DEF_MUTATED' : 'EXPORTED_SIGNATURE_MUTATED');
    return {
        invariantId: `DIFF:${persistentSymbolId}`,
        relation: 'STRUCTURAL_CO_EVOLUTION',
        mutatedSymbol: symbol,
        providerMutation: {
            targetSymbolId: persistentSymbolId, beforeExists: true, afterExists: Boolean(after), classification,
            isAstDiffDerived: true, beforeParsed: true, afterParsed: Boolean(after)
        },
        providerContracts: { before: before.contract, after: after?.contract ?? {} }
    };
}
/** Derives only unambiguous changed top-level declarations from real git blobs. */
function deriveRealDiffObligations(repositoryRoot, parentSha, candidateSha, analysisRoot = repositoryRoot) {
    let files;
    let actualDiff;
    try {
        files = git(repositoryRoot, ['diff', '--name-only', parentSha, candidateSha]).split(/\r?\n/).filter(Boolean);
        actualDiff = git(repositoryRoot, ['diff', '--no-ext-diff', '--unified=0', parentSha, candidateSha]);
    }
    catch (error) {
        return { status: 'OBLIGATION_DERIVATION_UNCERTAIN', changedFiles: [], actualDiff: '', reason: error instanceof Error ? error.message : String(error) };
    }
    const sourceFiles = files.filter(file => /\.(?:ts|tsx|js|jsx)$/.test(file));
    const before = sourceFiles.flatMap(file => declarations(file, sourceAt(repositoryRoot, parentSha, file)));
    const after = sourceFiles.flatMap(file => declarations(file, sourceAt(repositoryRoot, candidateSha, file)));
    const beforeByKey = new Map(before.map(item => [key(item), item]));
    const afterByKey = new Map(after.map(item => [key(item), item]));
    const obligations = [];
    for (const [declarationKey, oldDeclaration] of beforeByKey) {
        const newDeclaration = afterByKey.get(declarationKey);
        if (!newDeclaration || oldDeclaration.text !== newDeclaration.text)
            obligations.push(makeObligation(analysisRoot, oldDeclaration, newDeclaration));
    }
    if (obligations.length === 0)
        return { status: 'OBLIGATION_DERIVATION_UNCERTAIN', changedFiles: files, actualDiff, reason: 'No changed top-level declaration could be derived unambiguously from the diff.' };
    return { status: 'DERIVED', changedFiles: files, actualDiff, obligations };
}
