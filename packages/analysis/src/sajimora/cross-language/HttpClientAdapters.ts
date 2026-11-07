/**
 * HttpClientAdapters.ts
 *
 * Pluggable HTTP Client Adapter Architecture.
 * Normalizes HTTP calls from:
 *   - fetch(url, { method, body })
 *   - Axios: axios.get<T>, axios.post<T>, axios.put, axios.delete, axios.patch, axios.create(), custom instance calls
 *   - TanStack Query / React Query: useQuery({ queryKey, queryFn }), useMutation
 *   - SWR: useSWR(url, fetcher)
 *   - Angular HttpClient: this.http.get<T>, this.http.post<T>
 *
 * Each adapter produces canonical ClientRequestContracts without special-casing
 * client libraries inside the core compatibility engine.
 */

import * as ts from 'typescript';
import {
  WireType,
  NormalizedRouteContract,
  SourceProvenance,
  mkPrimitiveWireType,
  mkObjectWireType
} from './CanonicalContractIR';
import { normalizeRouteSegments } from './EndpointIdentity';
import { UrlConstantResolver } from './UrlConstantResolver';
import { TypeScriptContractParser } from './TypeScriptContractParser';
import { AnalysisBlocker, TsExpectationKind } from './CrossLanguageContracts';
import { findBinding, importedFrom, inferPayload } from './ClientAstBindings';
import { resolveAxiosBinding } from './ImportedAxiosBinding';
import { summarizeHttpOptions } from './HttpOptionSummary';
import { callIdentity } from './CallIdentity';
import {deriveTransportBody,TransportBody} from './TransportBody';

export interface ClientRequestContract {
  readonly requestTransport?:TransportBody;
  readonly requestEffectsQualified?:boolean;
  readonly routeDomain?:import('./RouteDomain').RouteDomain;
  readonly httpOptionsEvidence?:HttpOptionsEvidence;
  readonly responseEffectsQualified?: boolean;
  readonly clientKind: 'FETCH' | 'AXIOS' | 'TANSTACK_QUERY' | 'SWR' | 'ANGULAR';
  readonly method: string;
  readonly rawUrl: string;
  readonly route: NormalizedRouteContract;
  readonly requestBodyType?: WireType | null;
  readonly expectedResponseType?: WireType | null;
  readonly responseTypeName?: string | null;
  readonly expectationKind: TsExpectationKind;
  readonly provenance: SourceProvenance;
}

export interface AdapterExtractionResult {
  readonly requests: readonly ClientRequestContract[];
  readonly blockers: readonly AnalysisBlocker[];
}
export interface HttpOptionsEvidence {
  readonly sourceEvidence?:readonly {file:string;sha256:string}[];
  readonly version:'SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1';
  readonly observe:string|null;
  readonly responseType:string|null;
  readonly decoderOptionsComplete:boolean;
  readonly requestBodyAbsent?:boolean;
  readonly queryParametersAbsent?:boolean;
  readonly missingEvidence:readonly string[];
}

export interface HttpClientAdapter {
  extractRequests(
    sf: ts.SourceFile,
    urlResolver: UrlConstantResolver,
    typeParser: TypeScriptContractParser
  ): AdapterExtractionResult;
}

// ---------------------------------------------------------------------------
// 1. Fetch Adapter
// ---------------------------------------------------------------------------

export class FetchAdapter implements HttpClientAdapter {
  extractRequests(
    sf: ts.SourceFile,
    urlResolver: UrlConstantResolver,
    typeParser: TypeScriptContractParser
  ): AdapterExtractionResult {
    const requests: ClientRequestContract[] = [];
    const blockers: AnalysisBlocker[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        let isFetch = false;
        if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
          isFetch = !findBinding('fetch', node);
          if (!isFetch) blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: 'Shadowed or imported fetch requires an explicit client profile' });
        }

        if (isFetch && node.arguments.length > 0) {
          const urlArg = node.arguments[0];
          const resolvedUrl = urlResolver.resolveUrl(urlArg, sf.fileName);
          if (resolvedUrl.blocker) blockers.push(resolvedUrl.blocker);

          let method = 'GET';
          let bodyExpr: ts.Expression | undefined;
          if (node.arguments[1] && !ts.isObjectLiteralExpression(node.arguments[1])) {method='<dynamic>';blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: 'Nonliteral fetch options may change method/body' });}

          if (node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])) {
            for (const prop of node.arguments[1].properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                if (prop.name.text === 'method') {
                  if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) method = prop.initializer.text.toUpperCase();
                  else {method='<dynamic>';blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: 'Dynamic fetch method is unresolved' });}
                }
                if (prop.name.text === 'body') {
                  bodyExpr = prop.initializer;
                }
              } else {method='<dynamic>';blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: 'Computed/spread fetch options are unresolved' });}
            }
          }

          // Inspect return type context
          const { responseTypeName, expectedType, expectationKind } = this.inferResponseTypeFromContext(node, typeParser, sf.fileName);
          if (responseTypeName) blockers.push(...typeParser.parseTypeByName(responseTypeName, sf.fileName).blockers);

          let rawUrl = resolvedUrl.url;
          if (rawUrl === '<dynamic>') {
            if (ts.isTemplateExpression(urlArg)) {
              let templatePath = urlArg.head.text;
              for (const span of urlArg.templateSpans) {
                const exprText = span.expression.getText().trim();
                if (templatePath === '' && /(?:api_?base|base_?url|api_?url)/i.test(exprText) && span.literal.text.startsWith('/')) {
                  templatePath += span.literal.text;
                } else {
                  templatePath += '${' + exprText.replace(/[^a-zA-Z0-9_$]/g, '_') + '}' + span.literal.text;
                }
              }
              if (templatePath.startsWith('/') || /^\w+:\/\//.test(templatePath)) {
                rawUrl = templatePath;
              }
            } else if (ts.isBinaryExpression(urlArg) && urlArg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
              if (ts.isStringLiteral(urlArg.right) || ts.isNoSubstitutionTemplateLiteral(urlArg.right)) {
                rawUrl = urlArg.right.text;
              }
            }
          }

          requests.push({
            clientKind: 'FETCH',
            requestTransport:deriveTransportBody(bodyExpr),
            requestEffectsQualified:!node.arguments[1]||ts.isObjectLiteralExpression(node.arguments[1])&&node.arguments[1].properties.every(p=>ts.isPropertyAssignment(p)&&ts.isIdentifier(p.name)&&['method','body','headers'].includes(p.name.text)&&(p.name.text!=='method'||ts.isStringLiteralLike(p.initializer))&&(p.name.text!=='headers'||ts.isObjectLiteralExpression(p.initializer)&&p.initializer.properties.every(h=>ts.isPropertyAssignment(h)&&(ts.isIdentifier(h.name)||ts.isStringLiteral(h.name))&&ts.isStringLiteralLike(h.initializer)))),
            responseEffectsQualified: !node.arguments[1],
            method,
            rawUrl,
            routeDomain:resolvedUrl.domain,
            route: normalizeRouteSegments(rawUrl),
            requestBodyType: bodyExpr ? this.inferRequestBodyType(bodyExpr, typeParser, sf) : null,
            expectedResponseType: expectedType,
            responseTypeName,
            expectationKind,
            provenance: {
              language: 'TYPESCRIPT',
              file: sf.fileName,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              column: sf.getLineAndCharacterOfPosition(node.getStart(sf)).character + 1,
              astIdentity: `fetch(${resolvedUrl.url})`,
              callIdentity: callIdentity(node, 'FETCH'),
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
    return { requests, blockers };
  }

  private inferResponseTypeFromContext(
    fetchNode: ts.CallExpression,
    typeParser: TypeScriptContractParser,
    filePath: string
  ): { responseTypeName: string | null; expectedType: WireType | null; expectationKind: TsExpectationKind } {
    let parent = fetchNode.parent;
    if (ts.isAwaitExpression(parent)) parent = parent.parent;

    // Pattern: const res = await fetch(...); const data: UserDto = await res.json();
    let varName: string | null = null;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      varName = parent.name.text;
    }

    if (varName) {
      let scope: ts.Node | undefined = fetchNode.parent;
      while (scope && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope) && !ts.isArrowFunction(scope) && !ts.isSourceFile(scope)) {
        scope = scope.parent;
      }
      if (scope) {
        let foundType: { responseTypeName: string; expectedType: WireType; expectationKind: TsExpectationKind } | null = null;
        const findJsonUsage = (node: ts.Node) => {
          if (foundType) return;
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === varName && findBinding(varName!, node) === parent && node.expression.name.text === 'json') {
              let p = node.parent;
              if (ts.isAwaitExpression(p)) p = p.parent;
              if (ts.isVariableDeclaration(p) && p.type) {
                const typeName = p.type.getText();
                foundType = { responseTypeName: typeName, expectedType: typeParser.parseTypeByName(typeName, filePath).wireType, expectationKind: 'INFERRED_TYPE' };
                return;
              }
              if (ts.isAsExpression(p) && p.type) {
                const typeName = p.type.getText();
                foundType = { responseTypeName: typeName, expectedType: typeParser.parseTypeByName(typeName, filePath).wireType, expectationKind: 'TYPE_ASSERTION' };
                return;
              }
              if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
                if (p.expression.name.text === 'parse' || p.expression.name.text === 'safeParse') {
                  const schemaName = p.expression.expression.getText();
                  const parsed = typeParser.parseTypeByName(schemaName, filePath);
                  foundType = { responseTypeName: schemaName, expectedType: parsed.wireType, expectationKind: 'ZOD_DECODER' };
                  return;
                }
              }
            }
          }
          ts.forEachChild(node, findJsonUsage);
        };
        findJsonUsage(scope);
        if (foundType) return foundType;
      }
    }

    return { responseTypeName: null, expectedType: null, expectationKind: 'UNKNOWN' };
  }

  protected inferRequestBodyType(expr: ts.Expression, typeParser: TypeScriptContractParser, sf: ts.SourceFile): WireType {
    return inferPayload(expr, typeParser, sf.fileName);
  }
}

// ---------------------------------------------------------------------------
// 2. Axios Adapter (axios.get, axios.post, custom axios instances)
// ---------------------------------------------------------------------------

export class AxiosAdapter implements HttpClientAdapter {
  extractRequests(
    sf: ts.SourceFile,
    urlResolver: UrlConstantResolver,
    typeParser: TypeScriptContractParser
  ): AdapterExtractionResult {
    const requests: ClientRequestContract[] = [];
    const blockers: AnalysisBlocker[] = [];
    const axiosMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const propAccess = node.expression;
        const methodName = propAccess.name.text.toLowerCase();

        if (axiosMethods.has(methodName) && node.arguments.length > 0) {
          const callerText = propAccess.expression.getText();
          // Check if caller is axios or api/client instance
          const binding = ts.isIdentifier(propAccess.expression) ? findBinding(propAccess.expression.text, node) : undefined;
          const client = resolveAxiosBinding(propAccess.expression, urlResolver);
          const urlEvidence = ts.isStringLiteralLike(node.arguments[0])
            ? /^(?:\/|https?:\/\/)/i.test(node.arguments[0].text)
            : ts.isTemplateExpression(node.arguments[0]) && /^(?:\/|https?:\/\/)/i.test(node.arguments[0].head.text);
          if (!client && binding && (ts.isImportClause(binding) || ts.isImportSpecifier(binding)) && urlEvidence) {
            blockers.push({ code: 'UNRESOLVED_TS_CLIENT', file: sf.fileName, message: 'Imported HTTP-like receiver ' + callerText + ' could not be qualified at line ' + (sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1) });
          }
          if (client) {
            const urlArg = node.arguments[0];
            const resolvedUrl = urlResolver.resolveUrl(urlArg, sf.fileName);
            if (resolvedUrl.blocker) blockers.push(resolvedUrl.blocker);

            let responseTypeName: string | null = null;
            let expectedType: WireType | null = null;
            let expectationKind: TsExpectationKind = 'UNKNOWN';

            // Extract generic type: axios.get<UserDto>('/users')
            if (node.typeArguments && node.typeArguments.length > 0) {
              responseTypeName = node.typeArguments[0].getText();
              const parseRes = typeParser.parseTypeByName(responseTypeName, sf.fileName);
              expectedType = parseRes.wireType;
              blockers.push(...parseRes.blockers);
              expectationKind = 'INFERRED_TYPE';
            }

            // A cast of this exact response binding's data qualifies the body;
            // function return annotations alone do not prove Axios decoding.
            if (!node.typeArguments?.length) {
              let declaration: ts.Node = node.parent;
              if (ts.isAwaitExpression(declaration)) declaration = declaration.parent;
              if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
                const responseName = declaration.name.text;
                let scope: ts.Node = declaration;
                while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
                const names = new Set<string>();
                const inspect = (n: ts.Node) => {
                  if (n !== scope && ts.isFunctionLike(n)) return;
                  if (ts.isAsExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'data' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === responseName && findBinding(responseName, n) === declaration) names.add(n.type.getText());
                  ts.forEachChild(n, inspect);
                };
                inspect(scope);
                if (names.size === 1) {
                  responseTypeName = [...names][0];
                  const parsed = typeParser.parseTypeByName(responseTypeName, sf.fileName);
                  expectedType = parsed.wireType;
                  blockers.push(...parsed.blockers);
                  expectationKind = 'TYPE_ASSERTION';
                }
              }
            }

            let rawUrl = resolvedUrl.url;
            if (rawUrl === '<dynamic>') {
              if (ts.isTemplateExpression(urlArg)) {
                let templatePath = urlArg.head.text;
                for (const span of urlArg.templateSpans) {
                  const exprText = span.expression.getText().trim();
                  if (templatePath === '' && /(?:api_?base|base_?url|api_?url)/i.test(exprText) && span.literal.text.startsWith('/')) {
                    templatePath += span.literal.text;
                  } else {
                    templatePath += '${' + exprText.replace(/[^a-zA-Z0-9_$]/g, '_') + '}' + span.literal.text;
                  }
                }
                if (templatePath.startsWith('/') || /^\w+:\/\//.test(templatePath)) {
                  rawUrl = templatePath;
                }
              } else if (ts.isBinaryExpression(urlArg) && urlArg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                if (ts.isStringLiteral(urlArg.right) || ts.isNoSubstitutionTemplateLiteral(urlArg.right)) {
                  rawUrl = urlArg.right.text;
                }
              }
            }
            if (client.instance) {
              const instanceFile = client.instance.getSourceFile().fileName;
              const options = client.instance.arguments[0];
              if (options) {
                const base = ts.isObjectLiteralExpression(options) ? options.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'baseURL') : undefined;
                if (base && ts.isPropertyAssignment(base)) {
                  const resolvedBase = urlResolver.resolveUrl(base.initializer, instanceFile);
                  if (resolvedBase.blocker) {
                    blockers.push(resolvedBase.blocker);
                    rawUrl = '<dynamic>';
                  } else if (rawUrl !== '<dynamic>' && !/^\w+:\/\//.test(rawUrl)) {
                    rawUrl = resolvedBase.url.replace(/\/$/, '') + '/' + rawUrl.replace(/^\//, '');
                  }
                }
                if (!ts.isObjectLiteralExpression(options) || options.properties.some(p => !ts.isPropertyAssignment(p) || (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ['transformRequest', 'transformResponse', 'adapter', 'paramsSerializer'].includes(p.name.text))) {
                  blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: instanceFile, message: 'Axios dynamic configuration or transformations are not qualified' });
                  if (!ts.isObjectLiteralExpression(options) || options.properties.some(p => ts.isSpreadAssignment(p))) rawUrl = '<dynamic>';
                }
              }
              // Interceptors and mutable defaults may affect request/response facts.
              const declaration = client.instance.parent;
              if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
                const instanceName = declaration.name.text;
                let mutated = false;
                const inspect = (n: ts.Node) => {
                  if (ts.isPropertyAccessExpression(n) && ['interceptors', 'defaults'].includes(n.name.text) && ts.isIdentifier(n.expression) && n.expression.text === instanceName && findBinding(instanceName, n) === declaration) mutated = true;
                  ts.forEachChild(n, inspect);
                };
                inspect(client.instance.getSourceFile());
                if (mutated) blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: instanceFile, message: 'Axios interceptors or mutable defaults require qualification' });
              }
            }
            const configIndex = ['post', 'put', 'patch'].includes(methodName) ? 2 : 1;
            const config = node.arguments[configIndex];
            // Literal credentials affect transport/authentication, not URL or
            // body decoding. Other configuration still requires qualification.
            const credentialsOnly = config && ts.isObjectLiteralExpression(config) && config.properties.every(p =>
              ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'withCredentials' &&
              [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(p.initializer.kind));
            if (config && !credentialsOnly) blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: 'Axios per-call configuration/interceptors are not qualified' });

            requests.push({
              clientKind: 'AXIOS',
              requestTransport:deriveTransportBody(['post','put','patch'].includes(methodName)?node.arguments[1]:undefined),
              requestEffectsQualified:false,
              method: methodName.toUpperCase(),
              rawUrl,
              routeDomain:resolvedUrl.domain,
              route: normalizeRouteSegments(rawUrl),
              requestBodyType: ['post', 'put', 'patch'].includes(methodName) && node.arguments.length > 1
                ? this.inferRequestBodyType(node.arguments[1], typeParser, sf) : null,
              expectedResponseType: expectedType,
              responseTypeName,
              expectationKind,
              provenance: {
                language: 'TYPESCRIPT',
                file: sf.fileName,
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                column: sf.getLineAndCharacterOfPosition(node.getStart(sf)).character + 1,
                astIdentity: `${callerText}.${methodName}(${resolvedUrl.url})`,
                callIdentity: callIdentity(node, 'AXIOS'),
              }
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
    return { requests, blockers };
  }

  protected inferRequestBodyType(expr: ts.Expression, typeParser: TypeScriptContractParser, sf: ts.SourceFile): WireType {
    return inferPayload(expr, typeParser, sf.fileName);
  }
}

// ---------------------------------------------------------------------------
// 3. TanStack Query / SWR / Angular Adapter
// ---------------------------------------------------------------------------

export class AngularAdapter implements HttpClientAdapter {
  extractRequests(sf: ts.SourceFile, urlResolver: UrlConstantResolver, typeParser: TypeScriptContractParser): AdapterExtractionResult {
    const requests: ClientRequestContract[] = [];
    const blockers: AnalysisBlocker[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(node.expression.name.text) && node.arguments[0]) {
        const receiver = node.expression.expression;
        let binding = ts.isIdentifier(receiver) ? findBinding(receiver.text, node) : undefined;
        if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
          let owner: ts.Node | undefined = node;
          while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent;
          if (owner && ts.isClassDeclaration(owner)) for (const member of owner.members) {
            if (ts.isPropertyDeclaration(member) && member.name.getText() === receiver.name.text) binding = member;
            if (ts.isConstructorDeclaration(member)) binding = member.parameters.find(p => p.name.getText() === receiver.name.text) ?? binding;
          }
        }
        const annotation = binding && (ts.isParameter(binding) || ts.isVariableDeclaration(binding) || ts.isPropertyDeclaration(binding)) ? binding.type : undefined;
        let angularType = annotation && ts.isTypeReferenceNode(annotation) && ts.isIdentifier(annotation.typeName) ? findBinding(annotation.typeName.text, annotation) : undefined;
        const initializer=binding&&(ts.isVariableDeclaration(binding)||ts.isPropertyDeclaration(binding))?binding.initializer:undefined;
        if(initializer&&ts.isCallExpression(initializer)&&ts.isIdentifier(initializer.expression)&&initializer.arguments.length===1&&ts.isIdentifier(initializer.arguments[0])){
          const factory=findBinding(initializer.expression.text,initializer);
          if(factory&&ts.isImportSpecifier(factory)&&(factory.propertyName?.text??factory.name.text)==='inject'&&importedFrom(factory,'@angular/core'))angularType=findBinding(initializer.arguments[0].text,initializer);
        }
        if (angularType && ts.isImportSpecifier(angularType) && (angularType.propertyName?.text ?? angularType.name.text) === 'HttpClient' && importedFrom(angularType, '@angular/common/http')) {
          const url = urlResolver.resolveUrl(node.arguments[0], sf.fileName);
          if (url.blocker) blockers.push(url.blocker);
          let name = node.typeArguments?.[0]?.getText() ?? null;
          // A direct assignment to a declared Observable constrains this
          // exact call's body. Do not infer through operators or callbacks.
          if(!name&&(ts.isVariableDeclaration(node.parent)||ts.isPropertyDeclaration(node.parent))&&node.parent.initializer===node){
            const type=node.parent.type;
            if(type&&ts.isTypeReferenceNode(type)&&ts.isIdentifier(type.typeName)&&type.typeArguments?.length===1){
              const binding=findBinding(type.typeName.text,type);
              if(binding&&ts.isImportSpecifier(binding)&&(binding.propertyName?.text??binding.name.text)==='Observable'&&importedFrom(binding,'rxjs'))name=type.typeArguments[0].getText();
            }
          }
          // A direct return retains the body's type; pipe/map callbacks may transform it.
          if (!name && ts.isReturnStatement(node.parent)) {
            let owner: ts.Node | undefined = node.parent;
            while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
            const type = owner && ts.isFunctionLike(owner) ? owner.type : undefined;
            if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeArguments?.length===1) {
              const binding = findBinding(type.typeName.text,type);
              if (binding && ts.isImportSpecifier(binding) && (binding.propertyName?.text ?? binding.name.text)==='Observable' && importedFrom(binding,'rxjs')) name=type.typeArguments[0].getText();
            }
          }
          const parsed = name ? typeParser.parseTypeByName(name, sf.fileName) : null;
          if (parsed) blockers.push(...parsed.blockers);
          const method = node.expression.name.text.toUpperCase();
          const options = node.arguments[['POST','PUT','PATCH'].includes(method) ? 2 : 1];
          let response = parsed?.wireType ?? null;
          let observeUnqualified = false;
          let optionsEvidence:HttpOptionsEvidence={version:'SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1',observe:'body',responseType:'json',decoderOptionsComplete:true,requestBodyAbsent:true,queryParametersAbsent:true,missingEvidence:[]};
          if (options) {
            const summary = summarizeHttpOptions(options, urlResolver);
            const fields = summary.kind === 'object' ? summary.fields : new Map();
            const mode=(key:string,fallback:string):string|null=>{const value=fields.get(key);if(!value)return summary.kind==='object'&&!summary.unknownWrites?fallback:null;return value.kind==='literal'?(value.value===undefined?fallback:typeof value.value==='string'?value.value:null):null;};
            const rawObserve=mode('observe','body'),rawResponseType=mode('responseType','json');
            const observe=rawObserve&&['body','response','events'].includes(rawObserve)?rawObserve:null,responseType=rawResponseType&&['json','text','blob','arraybuffer'].includes(rawResponseType)?rawResponseType:null;
            const missingEvidence:string[]=[];
            if(!observe)missingEvidence.push('Exact valid observe option alternatives required');
            if(!responseType)missingEvidence.push('Exact valid responseType option alternatives required');
            for(const key of ['headers','params']){const value=fields.get(key);if(value)missingEvidence.push(value.kind==='unknown'?`${key}: ${value.reason}`:value.kind==='framework'?`${key}: pinned ${value.name} builder, encoding and acceptance summary required`:`${key}: query/header acceptance obligations require qualification`);}
            if(summary.kind!=='object'||summary.unknownWrites)missingEvidence.push(summary.kind==='unknown'?summary.reason:'Unknown option writes require request/transport evidence');
            const optionBody=fields.get('body'),requestBodyAbsent=summary.kind==='object'&&!summary.unknownWrites&&(!optionBody||optionBody.kind==='literal'&&optionBody.value==null);
            const params=fields.get('params'),queryParametersAbsent=summary.kind==='object'&&!summary.unknownWrites&&(!params||params.kind==='literal'&&params.value===undefined||params.kind==='framework'&&params.queryEmpty===true);
            optionsEvidence={version:'SAJIMORA_HTTP_OPTIONS_EVIDENCE_V1',observe,responseType,decoderOptionsComplete:observe!==null&&responseType!==null,requestBodyAbsent,queryParametersAbsent,missingEvidence,sourceEvidence:summary.sourceEvidence};
            if (summary.kind !== 'object' || summary.unknownWrites) {
              blockers.push({code:'UNSUPPORTED_CLIENT_WRAPPER',file:sf.fileName,message:summary.kind === 'unknown' ? summary.reason : 'Angular unknown option writes require evidence for observe, responseType, headers and params'});
              // Later explicit writes can restore individual decoder facts.
              if (!fields.has('observe') || !fields.has('responseType')) {
                observeUnqualified = true;
                response = {kind:'UNKNOWN',reason:'Unknown Angular options may change response decoding or envelope'};
              }
            }
            for (const [key, value] of fields) {
              if (key==='observe' && !(value.kind==='literal' && (value.value==='body' || value.value==='response' || value.value===undefined))) {
                observeUnqualified = true;
                response = {kind:'UNKNOWN',reason:'Angular non-body observe mode requires response-envelope modeling'};
                blockers.push({code:'UNSUPPORTED_CLIENT_WRAPPER',file:sf.fileName,message:'Angular non-body observe mode is not qualified'});
              } else if (key==='responseType' && !(value.kind==='literal' && (value.value==='json' || value.value===undefined))) {
                response = value.kind==='literal'&&value.value==='text' ? mkPrimitiveWireType('string') : {kind:'UNKNOWN',reason:'Angular binary/dynamic responseType is not qualified'};
                if (response.kind==='UNKNOWN') blockers.push({code:'UNSUPPORTED_CLIENT_WRAPPER',file:sf.fileName,message:'Angular binary/dynamic responseType is not qualified'});
              } else if (key==='headers'||key==='params') blockers.push({code:'UNSUPPORTED_CLIENT_WRAPPER',file:sf.fileName,message:'Angular parameter/header obligations require independent qualification'});
            }
          }
          if (observeUnqualified) response = {kind:'UNKNOWN',reason:'Angular non-body observe mode requires response-envelope modeling'};
          if(!optionsEvidence.decoderOptionsComplete)response={kind:'UNKNOWN',reason:'Invalid or unresolved Angular decoding/envelope options require evidence'};
          requests.push({ clientKind: 'ANGULAR', method, rawUrl: url.url, route: normalizeRouteSegments(url.url),
            requestTransport:deriveTransportBody(['POST','PUT','PATCH'].includes(method)?node.arguments[1]:undefined),
            requestEffectsQualified:false,
            routeDomain:url.domain,
            httpOptionsEvidence:optionsEvidence,
            responseEffectsQualified: !observeUnqualified && response?.kind !== 'UNKNOWN',
            requestBodyType: ['POST', 'PUT', 'PATCH'].includes(method) && node.arguments[1] ? inferPayload(node.arguments[1], typeParser, sf.fileName) : null,
            expectedResponseType: response, responseTypeName: name, expectationKind: name ? 'INFERRED_TYPE' : 'UNKNOWN',
            provenance: { language: 'TYPESCRIPT', file: sf.fileName, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, column: sf.getLineAndCharacterOfPosition(node.getStart()).character + 1, astIdentity: node.expression.getText(), callIdentity: callIdentity(node, 'ANGULAR') } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { requests, blockers };
  }
}

export class MultiClientAdapter implements HttpClientAdapter {
  private readonly fetchAdapter = new FetchAdapter();
  private readonly axiosAdapter = new AxiosAdapter();
  private readonly angularAdapter = new AngularAdapter();

  extractRequests(
    sf: ts.SourceFile,
    urlResolver: UrlConstantResolver,
    typeParser: TypeScriptContractParser
  ): AdapterExtractionResult {
    const fRes = this.fetchAdapter.extractRequests(sf, urlResolver, typeParser);
    const aRes = this.axiosAdapter.extractRequests(sf, urlResolver, typeParser);
    const angular = this.angularAdapter.extractRequests(sf, urlResolver, typeParser);

    const requests: ClientRequestContract[] = [...fRes.requests, ...aRes.requests, ...angular.requests];
    const blockers: AnalysisBlocker[] = [...fRes.blockers, ...aRes.blockers, ...angular.blockers];

    // Scan for useQuery / useSWR calls
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fnName = node.expression.text;
        const binding = findBinding(fnName, node);
        const importedName = binding && ts.isImportSpecifier(binding) ? binding.propertyName?.text ?? binding.name.text : fnName;
        const queryHook = ['useQuery', 'useMutation'].includes(importedName) && (importedFrom(binding, '@tanstack/react-query') || importedFrom(binding, 'react-query'));
        const swrHook = importedFrom(binding, 'swr');
        if (queryHook || swrHook) {
          const firstArg = node.arguments[0];
          let functionExpr: ts.Node | undefined;
          if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
            const queryFn = firstArg.properties.find(p => ts.isPropertyAssignment(p) && ['queryFn', 'mutationFn'].includes(p.name.getText()));
            if (queryFn && ts.isPropertyAssignment(queryFn)) functionExpr = queryFn.initializer;
          } else functionExpr = node.arguments[1];
          let functionFile = sf.fileName;
          if (functionExpr && ts.isIdentifier(functionExpr)) {
            const declaration = urlResolver.resolveImportedDeclaration(functionExpr.text, sf.fileName);
            functionExpr = declaration?.node;
            functionFile = declaration?.file ?? functionFile;
            if (functionExpr && ts.isVariableDeclaration(functionExpr)) functionExpr = functionExpr.initializer;
          }
          if (!functionExpr || !(ts.isArrowFunction(functionExpr) || ts.isFunctionExpression(functionExpr) || ts.isFunctionDeclaration(functionExpr))) {
            blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: `${fnName} queryFn/fetcher is unresolved; query keys are not HTTP routes` });
          } else {
            const functionSource = urlResolver.getSourceFile(functionFile);
            if (functionSource) {
              const native = [...this.fetchAdapter.extractRequests(functionSource, urlResolver, typeParser).requests, ...this.axiosAdapter.extractRequests(functionSource, urlResolver, typeParser).requests];
              const calls = native.filter(request => {
                const offset = functionSource.getPositionOfLineAndCharacter(request.provenance.line - 1, (request.provenance.column ?? 1) - 1);
                return offset >= functionExpr!.getStart() && offset <= functionExpr!.getEnd();
              });
              if (!calls.length) blockers.push({ code: 'UNSUPPORTED_CLIENT_WRAPPER', file: sf.fileName, message: `${fnName} function has no resolved HTTP call` });
              const responseName = node.typeArguments?.[0]?.getText();
              const response = responseName ? typeParser.parseTypeByName(responseName, sf.fileName) : undefined;
              if (response) blockers.push(...response.blockers);
              // A hook generic applies to decoded JSON/data, never to a raw Fetch Response or AxiosResponse.
              let decodesBody = false;
              const decodedReturn = (expression: ts.Expression): boolean => {
                if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) return decodedReturn(expression.expression);
                let receiver: ts.Expression | undefined;
                if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'json') receiver = expression.expression.expression;
                if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'data') receiver = expression.expression;
                if (!receiver || !ts.isIdentifier(receiver)) return false;
                const declaration = findBinding(receiver.text, expression);
                if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
                let initializer = declaration.initializer;
                if (ts.isAwaitExpression(initializer)) initializer = initializer.expression;
                const loc = functionSource.getLineAndCharacterOfPosition(initializer.getStart());
                return ts.isCallExpression(initializer) && calls.some(call => call.provenance.line === loc.line + 1 && call.provenance.column === loc.character + 1);
              };
              const returns: boolean[] = [];
              const inspectReturn = (node: ts.Node) => {
                if (node !== functionExpr && ts.isFunctionLike(node)) return;
                if (ts.isReturnStatement(node)) returns.push(!!node.expression && decodedReturn(node.expression));
                ts.forEachChild(node, inspectReturn);
              };
              if (ts.isArrowFunction(functionExpr) && !ts.isBlock(functionExpr.body)) decodesBody = decodedReturn(functionExpr.body);
              else { inspectReturn(functionExpr); decodesBody = returns.length > 0 && returns.every(Boolean); }
              decodesBody &&= calls.length === 1;
              for (const call of calls) {
                const enriched = { ...call, clientKind: (queryHook ? 'TANSTACK_QUERY' : 'SWR') as 'TANSTACK_QUERY' | 'SWR',
                  expectedResponseType: decodesBody && response ? response.wireType : call.expectedResponseType,
                  responseTypeName: decodesBody && responseName ? responseName : call.responseTypeName };
                const existing = requests.findIndex(request => request.provenance.file === call.provenance.file && request.provenance.line === call.provenance.line && request.provenance.column === call.provenance.column && request.method === call.method && request.rawUrl === call.rawUrl);
                if (existing >= 0) requests[existing] = enriched; else requests.push(enriched);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
    return { requests, blockers };
  }
}
