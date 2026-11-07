import * as ts from 'typescript';
import { AnalysisBlocker } from './CrossLanguageContracts';
import { findBinding } from './ClientAstBindings';
import { SnapshotModuleResolver } from './SnapshotModuleResolver';
import {snapshotSourceFile} from './SnapshotSourcePool';
import {deriveRouteDomain,RouteDomain} from './RouteDomain';

export interface ResolvedRouteUrl { readonly url: string; readonly isDynamic: boolean; readonly blocker?: AnalysisBlocker; readonly domain?:RouteDomain; readonly alternatives?: readonly string[]; }

export class UrlConstantResolver {
  private readonly sources = new Map<string, ts.SourceFile>();
  private readonly modules: SnapshotModuleResolver;
  constructor(private readonly files: ReadonlyMap<string, string>) {
    this.modules = new SnapshotModuleResolver(files);
  }
  public getSourceFile(file: string): ts.SourceFile | undefined {
    if(!this.sources.has(file)&&/\.(?:[jt]sx?|[mc][jt]s)$/.test(file)){const source=snapshotSourceFile(this.files,file);if(source)this.sources.set(file,source);}
    return this.sources.get(file);
  }
  public resolveImportedDeclaration(name: string, file: string, visited = new Set<string>()): { node: ts.Node; file: string } | undefined {
    const key = `${file}#${name}`;
    if (visited.has(key)) return undefined;
    visited = new Set([...visited, key]);
    const sf = this.getSourceFile(file);
    if (!sf) return undefined;
    for (const statement of sf.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === name) return {node:statement,file};
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { node: statement, file };
      if (ts.isEnumDeclaration(statement) && statement.name?.text === name) return { node: statement, file };
      if (ts.isTypeAliasDeclaration(statement) && statement.name?.text === name) return { node: statement, file };
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return { node: declaration, file };
      }
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.importClause.namedBindings.elements.find(e => e.name.text === name);
        const target = this.resolveModule(statement.moduleSpecifier.text, file);
        if (specifier && target) return this.resolveImportedDeclaration(specifier.propertyName?.text ?? specifier.name.text, target, visited);
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = this.resolveModule(statement.moduleSpecifier.text, file);
        if (!target) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const specifier = statement.exportClause.elements.find(e => e.name.text === name);
          if (specifier) return this.resolveImportedDeclaration(specifier.propertyName?.text ?? specifier.name.text, target, visited);
        } else if (!statement.exportClause) {
          const declaration = this.resolveImportedDeclaration(name, target, visited);
          if (declaration) return declaration;
        }
      }
    }
    return undefined;
  }
  public resolveModule(name: string, file: string): string | undefined {
    return this.modules.resolve(name, file);
  }
  public capturedText(file:string):string|undefined{return this.files.get(file);}
  public resolveUrl(expr: ts.Expression, currentFile: string, visited = new Set<string>()): ResolvedRouteUrl {
    const domain=deriveRouteDomain(expr,this);
    if(domain.pathComplete){
      const primaryUrl = domain.alternatives[0]?.url ?? '<dynamic>';
      const isDynamic = domain.alternatives.length > 1;
      return {
        url: primaryUrl,
        isDynamic,
        domain,
        alternatives: domain.alternatives.map(a => a.url),
        ...(domain.missingEvidence.length ? { blocker: { code: 'UNRESOLVED_HTTP_WRAPPER' as const, file: currentFile, message: domain.missingEvidence.join('; ') } } : {})
      };
    }
    return {url:'<dynamic>',isDynamic:true,domain,blocker:{code:'DYNAMIC_URL',file:currentFile,message:`Route '${expr.getText().slice(0,160)}' requires ${domain.missingEvidence.join('; ')||'finite alternative endpoint ownership analysis'}`}};
  }
  private resolveLegacyUrl(expr: ts.Expression, currentFile: string, visited = new Set<string>()): ResolvedRouteUrl {
    const dynamic = (): ResolvedRouteUrl => ({ url: '<dynamic>', isDynamic: true, blocker: { code: 'DYNAMIC_URL', file: currentFile, message: `Unresolved route expression '${expr.getText()}'` } });
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { url: expr.text, isDynamic: false };
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return this.resolveUrl(expr.expression, currentFile, visited);
    if (ts.isTemplateExpression(expr)) {
      let url = expr.head.text;
      let queryUnresolved=false;
      for (const span of expr.templateSpans) {
        const value = this.resolveUrl(span.expression, currentFile, visited);
        if (!value.isDynamic) url += value.url;
        else if (ts.isIdentifier(span.expression) && url.endsWith('/') && (!span.literal.text || span.literal.text.startsWith('/'))) url += `\${${span.expression.text}}`;
        else if(url.includes('?')){url+='${unresolvedQueryValue}';queryUnresolved=true;}
        else return dynamic();
        url += span.literal.text;
      }
      return { url, isDynamic: false,...(queryUnresolved?{blocker:{code:'UNRESOLVED_HTTP_WRAPPER' as const,file:currentFile,message:'Endpoint path is resolved; dynamic query values and constraints require qualification'}}:{}) };
    }
    if (ts.isIdentifier(expr)) {
      const key = `${currentFile}#${expr.text}`;
      if (visited.has(key)) return dynamic();
      const lexical = findBinding(expr.text, expr);
      if (lexical && ts.isParameter(lexical)) return dynamic();
      if (lexical && ts.isVariableDeclaration(lexical)) {
        if (!(lexical.parent.flags & ts.NodeFlags.Const) || !lexical.initializer) return dynamic();
        return this.resolveUrl(lexical.initializer, currentFile, new Set([...visited, key]));
      }
      const declaration = this.resolveImportedDeclaration(expr.text, currentFile);
      if (declaration && ts.isVariableDeclaration(declaration.node) && declaration.node.initializer) return this.resolveUrl(declaration.node.initializer, declaration.file, new Set([...visited, key]));
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.resolveUrl(expr.left, currentFile, visited);
      const right = this.resolveUrl(expr.right, currentFile, visited);
      if (!left.isDynamic && !right.isDynamic) return { url: left.url + right.url, isDynamic: false };
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const declaration = this.resolveImportedDeclaration(expr.expression.text, currentFile);
      if (declaration && ts.isVariableDeclaration(declaration.node)) {
        let initializer = declaration.node.initializer;
        if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
        if (initializer && ts.isObjectLiteralExpression(initializer)) {
          const property = initializer.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === expr.name.text);
          if (property && ts.isPropertyAssignment(property)) return this.resolveUrl(property.initializer, declaration.file, visited);
        }
      }
    }
    return dynamic();
  }
}
