/**
 * TypeScriptContractParser.ts
 *
 * Extracts universal WireType representations from TypeScript source files:
 *   - Interfaces (interface UserDto { id: number; displayName?: string | null; })
 *   - Type aliases (type UserDto = { ... })
 *   - Classes, inline object types, arrays (T[], Array<T>)
 *   - Unions, literal unions, enums
 *   - Optional properties (?), nullable properties (| null, | undefined)
 *   - Zod schemas: z.object, z.string, z.number, z.boolean, z.array, .optional(), .nullable(),
 *     .strict(), .passthrough(), .extend(), .merge(), .pick(), .omit()
 *
 * Uses TypeScript compiler AST (ts.createSourceFile) for bounded, high-speed parsing
 * without constructing a heavy whole-monorepo ts.Program.
 */

import * as ts from 'typescript';
import {
  WireType,
  WirePropertyContract,
  ObjectWireType,
  SourceProvenance,
  mkPrimitiveWireType,
  mkObjectWireType,
  mkArrayWireType,
  mkUnionWireType,
  mkEnumWireType,
  mkNullableWireType,
  mkOptionalWireType,
  mkLiteralWireType,
  mkUnknownWireType,
} from './CanonicalContractIR';
import { AnalysisBlocker } from './CrossLanguageContracts';
import { SnapshotModuleResolver } from './SnapshotModuleResolver';
import {snapshotSourceFile} from './SnapshotSourcePool';
import {SemanticTypeNormalizer} from './SemanticTypeNormalizer';
import { toInputWireType, toOutputWireType } from './DirectionalWireCompatibility';


export interface TsTypeParseResult {
  readonly wireType: WireType;
  readonly blockers: readonly AnalysisBlocker[];
}

export class TypeScriptContractParser {
  private readonly sourceFiles = new Map<string, ts.SourceFile>();
  private readonly moduleResolver: SnapshotModuleResolver;
  private typeBindings = new Map<string, WireType>();
  private typeRole:'CONSUMER'|'PRODUCER'='CONSUMER';
  private readonly rootResults=new Map<string,TsTypeParseResult>();
  private semantic?:SemanticTypeNormalizer;
  public parseProducerTypeByName(name:string,file:string):TsTypeParseResult{
    const previous=this.typeRole;this.typeRole='PRODUCER';
    try{return this.parseTypeByName(name,file);}finally{this.typeRole=previous;}
  }

  constructor(private readonly files: ReadonlyMap<string, string>) {
    this.moduleResolver = new SnapshotModuleResolver(files);
  }
  private getSourceFile(file:string):ts.SourceFile|undefined {
    if(!this.sourceFiles.has(file)&&/\.[cm]?tsx?$/.test(file)){const source=snapshotSourceFile(this.files,file);if(source)this.sourceFiles.set(file,source);}
    return this.sourceFiles.get(file);
  }

  /**
   * Find and parse a TypeScript type declaration by name across files.
   */
  public parseTypeByName(typeName:string,originFile?:string,visited=new Set<string>(),exportedOnly=false):TsTypeParseResult {
    if(visited.size||this.typeBindings.size)return this.parseTypeByNameUncached(typeName,originFile,visited,exportedOnly);
    const key=`${this.files.size}:${this.typeRole}:${originFile}:${typeName}:${exportedOnly}`;
    const cached=this.rootResults.get(key);if(cached)return cached;
    let result=this.parseTypeByNameUncached(typeName,originFile,visited,exportedOnly);
    if(originFile&&!exportedOnly&&result.blockers.some(b=>b.code==='UNRESOLVED_TS_TYPE')){
      const normalized=(this.semantic??=new SemanticTypeNormalizer(this.files)).normalize(typeName,originFile);
      if(normalized.status==='NORMALIZED'&&normalized.wireType)result={wireType:normalized.wireType,blockers:[]};
      else if(normalized.status==='SOURCE_CONTRACT_INVALID')result={wireType:{kind:'UNKNOWN',reason:'SOURCE_CONTRACT_INVALID: '+normalized.diagnostics.map(d=>'TS'+d.code+' '+d.message).join('; ')},blockers:[{code:'UNRESOLVED_TS_TYPE',file:originFile,message:'SOURCE_CONTRACT_INVALID: '+normalized.diagnostics.map(d=>'TS'+d.code+' '+d.message).join('; ')}]};
    }
    this.rootResults.set(`${this.files.size}:${this.typeRole}:${originFile}:${typeName}:${exportedOnly}`,result);
    return result;
  }
  private parseTypeByNameUncached(
    typeName: string,
    originFile?: string,
    visited = new Set<string>(),
    exportedOnly = false
  ): TsTypeParseResult {
    const blockers: AnalysisBlocker[] = [];
    typeName = typeName.trim();
    const bound = this.typeBindings.get(`${originFile}:${typeName}`);
    if (bound) return {wireType: bound, blockers};
    const key = `${originFile ?? ''}:${typeName}`;
    if (visited.has(key)) return { wireType: mkUnknownWireType(`Recursive TS contract: ${key}`), blockers: [{ code: 'UNRESOLVED_TS_TYPE', file: originFile, message: `Recursive contract ${typeName} is not finitely qualified` }] };
    visited = new Set([...visited, key]);
    if(originFile&&/^[\w$]+\.[\w$]+$/.test(typeName)){
      const [enumName,memberName]=typeName.split('.'),declaration=this.enumDeclaration(enumName,originFile);
      const value=declaration&&this.enumValues(declaration).get(memberName);
      if(value!==undefined)return {wireType:mkLiteralWireType(value),blockers};
    }
    if (originFile && /(?:\[|[<>{}|&]|^(?:keyof|typeof|readonly)\s)/.test(typeName)) {
      const probe = ts.createSourceFile('__contract.ts', `type Contract = ${typeName};`, ts.ScriptTarget.Latest, true);
      const declaration = probe.statements[0];
      if (ts.isTypeAliasDeclaration(declaration)) return this.parseTypeNode(declaration.type, originFile, visited);
    }

    // Check built-in primitives
    const lower = typeName.trim().toLowerCase();
    if (lower === 'string') return { wireType: mkPrimitiveWireType('string'), blockers };
    if (lower === 'number') return { wireType: mkPrimitiveWireType('number'), blockers };
    if (lower === 'boolean') return { wireType: mkPrimitiveWireType('boolean'), blockers };
    if (lower === 'bigint') return { wireType: mkPrimitiveWireType('bigint'), blockers };
    if (lower === 'void') return { wireType: mkPrimitiveWireType('void'), blockers };
    if (lower === 'any' || lower === 'unknown') return { wireType: mkPrimitiveWireType('any'), blockers };

    if (originFile && this.getSourceFile(originFile)) {
      const sf = this.getSourceFile(originFile)!;
      // 1. Check local declarations
      const localRes = this.searchStatementsForType(sf, typeName, visited, exportedOnly);
      if (localRes) return localRes;

      // 2. Check imports
      for (const statement of sf.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const clause = statement.importClause;
          let importedName: string | null = null;

          if (clause.name && clause.name.text === typeName) {
            importedName = 'default';
          } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              if (specifier.name.text === typeName) {
                importedName = specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
                break;
              }
            }
          }

          if (importedName && ts.isStringLiteral(statement.moduleSpecifier)) {
            const modulePath = statement.moduleSpecifier.text;
            const targetPath = this.resolveModulePath(modulePath, originFile);
            if (targetPath) {
              return this.parseTypeByName(importedName, targetPath, visited, true);
            }
          }
        }
      }
      for (const statement of sf.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const targetPath = this.resolveModulePath(statement.moduleSpecifier.text, originFile);
        if (!targetPath) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const specifier = statement.exportClause.elements.find(e => e.name.text === typeName);
          if (specifier) return this.parseTypeByName(specifier.propertyName?.text ?? specifier.name.text, targetPath, visited, true);
        } else if (!statement.exportClause) {
          const result = this.parseTypeByName(typeName, targetPath, visited, true);
          if (result.wireType.kind !== 'UNKNOWN') return result;
        }
      }
    }

    // 3. (Removed) Global fallback for ambient types or unresolved imports.
    // Following proper module resolution, if a type is not found locally or via explicit imports,
    // it should be treated as unresolved rather than blindly matching a string across the entire workspace.

    return {
      wireType: mkUnknownWireType(`Unresolved TS type: ${typeName}`),
      blockers: [{
        code: 'UNRESOLVED_TS_TYPE',
        message: `Cannot resolve TypeScript type, interface, or Zod schema '${typeName}'`,
        file: originFile,
      }]
    };
  }

  private searchStatementsForType(sf: ts.SourceFile, typeName: string, visited: Set<string>, exportedOnly = false): TsTypeParseResult | null {
    const blockers: AnalysisBlocker[] = [];
    for (const statement of sf.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (exportedOnly && !modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const defaultExport = typeName === 'default' && modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
      if(ts.isClassDeclaration(statement)&&(statement.name?.text===typeName||defaultExport)){
        if(statement.typeParameters?.length&&statement.typeParameters.every(p=>p.default)&&!statement.typeParameters.some(p=>this.typeBindings.has(`${sf.fileName}:${p.name.text}`)))return this.parseGeneric(typeName,[],sf.fileName,visited);
        if(statement.typeParameters?.some(p=>!this.typeBindings.has(`${sf.fileName}:${p.name.text}`)))return this.unresolvedGeneric(typeName,sf.fileName);
        return this.parseClassDeclaration(statement,sf.fileName,visited);
      }
      if (ts.isInterfaceDeclaration(statement) && (statement.name.text === typeName || defaultExport)) {
        if(statement.typeParameters?.length&&statement.typeParameters.every(p=>p.default)&&!statement.typeParameters.some(p=>this.typeBindings.has(`${sf.fileName}:${p.name.text}`)))return this.parseGeneric(typeName,[],sf.fileName,visited);
        if (statement.typeParameters?.some(p => !this.typeBindings.has(`${sf.fileName}:${p.name.text}`))) return this.unresolvedGeneric(typeName, sf.fileName);
        return this.parseInterfaceDeclaration(statement, sf.fileName, visited);
      }
      if (ts.isTypeAliasDeclaration(statement) && (statement.name.text === typeName || defaultExport)) {
        if(statement.typeParameters?.length&&statement.typeParameters.every(p=>p.default)&&!statement.typeParameters.some(p=>this.typeBindings.has(`${sf.fileName}:${p.name.text}`)))return this.parseGeneric(typeName,[],sf.fileName,visited);
        if (statement.typeParameters?.some(p => !this.typeBindings.has(`${sf.fileName}:${p.name.text}`))) return this.unresolvedGeneric(typeName, sf.fileName);
        return this.parseTypeNode(statement.type, sf.fileName, visited);
      }
      if (ts.isEnumDeclaration(statement) && statement.name.text === typeName) {
        const values=this.enumValues(statement);
        if(values.size!==statement.members.length)return {wireType:mkUnknownWireType(`Unqualified enum initializer ${typeName}`),blockers:[{code:'UNRESOLVED_TS_TYPE',file:sf.fileName,message:`Enum ${typeName} has an initializer requiring evaluation`}]};
        const enumValues = [...values.values()];
        return {
          wireType: mkEnumWireType(enumValues, typeName, {
            language: 'TYPESCRIPT',
            file: sf.fileName,
            line: sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1,
            astIdentity: typeName,
          }),
          blockers,
        };
      }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === typeName && decl.initializer) {
            const zodRes = this.tryParseZodSchema(decl.initializer, sf.fileName, visited);
            if (zodRes) return zodRes;
          }
        }
      }
    }
    return null;
  }

  private resolveModulePath(modulePath: string, originFile: string): string | null {
    return this.moduleResolver.resolve(modulePath, originFile) ?? null;
  }

  private enumValues(node:ts.EnumDeclaration,seen=new Set<ts.EnumDeclaration>()):Map<string,string|number>{
    if(seen.has(node))return new Map();seen=new Set([...seen,node]);
    const values=new Map<string,string|number>();let next:number|undefined=0;
    for(const member of node.members){let value:string|number|undefined;const init=member.initializer;if(!init)value=next;else if(ts.isStringLiteral(init))value=init.text;else if(ts.isNumericLiteral(init))value=Number(init.text);else if(ts.isPrefixUnaryExpression(init)&&ts.isNumericLiteral(init.operand)&&[ts.SyntaxKind.MinusToken,ts.SyntaxKind.PlusToken].includes(init.operator))value=Number(init.operand.text)*(init.operator===ts.SyntaxKind.MinusToken?-1:1);
      else if(ts.isIdentifier(init))value=values.get(init.text);
      else if(ts.isPropertyAccessExpression(init)&&ts.isIdentifier(init.expression)){
        const declaration=this.enumDeclaration(init.expression.text,node.getSourceFile().fileName);
        value=declaration===node?values.get(init.name.text):declaration?this.enumValues(declaration,seen).get(init.name.text):undefined;
      }
      if(value!==undefined)values.set(member.name.getText().replace(/^['"]|['"]$/g,''),value);next=typeof value==='number'?value+1:undefined;}return values;
  }
  private enumDeclaration(name:string,file:string,seen=new Set<string>(),exportedOnly=false):ts.EnumDeclaration|undefined {
    const key=`${file}:${name}`;if(seen.has(key))return;seen=new Set([...seen,key]);
    for(const statement of this.getSourceFile(file)?.statements??[]){
      if(ts.isEnumDeclaration(statement)&&statement.name.text===name&&(!exportedOnly||ts.getModifiers(statement)?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword)))return statement;
      if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)){
        const specifier=statement.importClause.namedBindings.elements.find(item=>item.name.text===name),target=this.resolveModulePath(statement.moduleSpecifier.text,file);if(specifier&&target)return this.enumDeclaration(specifier.propertyName?.text??specifier.name.text,target,seen,true);
      }
      if(ts.isExportDeclaration(statement)&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)){const target=this.resolveModulePath(statement.moduleSpecifier.text,file);if(!target)continue;if(statement.exportClause&&ts.isNamedExports(statement.exportClause)){const specifier=statement.exportClause.elements.find(item=>item.name.text===name);if(specifier)return this.enumDeclaration(specifier.propertyName?.text??specifier.name.text,target,seen);}else if(!statement.exportClause){const result=this.enumDeclaration(name,target,seen);if(result)return result;}}
    }
  }

  private parseClassDeclaration(node:ts.ClassDeclaration,file:string,visited:Set<string>):TsTypeParseResult {
    const blockers:AnalysisBlocker[]=[],properties:WirePropertyContract[]=[];
    const add=(member:ts.PropertyDeclaration|ts.ParameterDeclaration|ts.GetAccessorDeclaration)=>{
      const modifiers=ts.getModifiers(member);
      if(modifiers?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword||this.typeRole==='CONSUMER'&&[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword].includes(m.kind))||ts.isPrivateIdentifier(member.name)||this.typeRole==='PRODUCER'&&ts.isGetAccessorDeclaration(member))return;
      if(!ts.isIdentifier(member.name)&&!ts.isStringLiteral(member.name)&&!ts.isNumericLiteral(member.name)){blockers.push({code:'UNRESOLVED_TS_TYPE',file,message:'Computed class property requires evaluation'});return;}
      const initializer=ts.isGetAccessorDeclaration(member)?undefined:member.initializer;
      let parsed:TsTypeParseResult;
      if(member.type)parsed=this.parseTypeNode(member.type,file,visited);
      else if(initializer&&(ts.isStringLiteral(initializer)||ts.isNumericLiteral(initializer)||[ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword].includes(initializer.kind))){const value=ts.isStringLiteral(initializer)?initializer.text:ts.isNumericLiteral(initializer)?Number(initializer.text):initializer.kind===ts.SyntaxKind.TrueKeyword;parsed={wireType:modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ReadonlyKeyword)?mkLiteralWireType(value):mkPrimitiveWireType(typeof value as 'string'|'number'|'boolean'),blockers:[]};}
      else if(initializer&&ts.isPropertyAccessExpression(initializer)&&ts.isIdentifier(initializer.expression))parsed=this.parseTypeByName(initializer.expression.text,file,visited);
      else parsed={wireType:mkUnknownWireType(`Unresolved class member ${member.name.text}`),blockers:[{code:'UNRESOLVED_TS_TYPE',file,message:`Class member ${member.name.text} lacks a qualified declared or inferred type`}]};
      blockers.push(...parsed.blockers);
      const property:WirePropertyContract={wireName:member.name.text,type:parsed.wireType,optional:!!member.questionToken||!!member.type&&this.isUndefinedType(member.type),nullable:!!member.type&&this.isNullableType(member.type),validationConstraints:[],provenance:{language:'TYPESCRIPT',file,line:member.getSourceFile().getLineAndCharacterOfPosition(member.getStart()).line+1,astIdentity:`${node.name?.text??'default'}.${member.name.text}`}};
      const index=properties.findIndex(p=>p.wireName===property.wireName);if(index>=0)properties.splice(index,1);properties.push(property);
    };
    for(const clause of node.heritageClauses??[])if(clause.token===ts.SyntaxKind.ExtendsKeyword)for(const base of clause.types){const parsed=this.parseTypeByName(base.getText(),file,visited);blockers.push(...parsed.blockers);if(parsed.wireType.kind==='OBJECT')properties.push(...parsed.wireType.properties);else blockers.push({code:'UNRESOLVED_TS_TYPE',file,message:'Class inheritance requires a qualified object contract'});}
    for(const member of node.members){
      if(ts.isPropertyDeclaration(member)||ts.isGetAccessorDeclaration(member))add(member);
      if(ts.isConstructorDeclaration(member))for(const parameter of member.parameters)if(ts.getModifiers(parameter)?.some(m=>[ts.SyntaxKind.PublicKeyword,ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword,ts.SyntaxKind.ReadonlyKeyword].includes(m.kind)))add(parameter);
    }
    return {wireType:mkObjectWireType(properties,node.name?.text),blockers};
  }

  private parseInterfaceDeclaration(
    node: ts.InterfaceDeclaration,
    filePath: string,
    visited: Set<string>
  ): TsTypeParseResult {
    const blockers: AnalysisBlocker[] = [];
    const properties: WirePropertyContract[] = [];
    const sf = this.getSourceFile(filePath)!;
    for (const heritage of node.heritageClauses ?? []) {
      for (const base of heritage.types) {
        const inherited = this.parseTypeByName(base.getText(), filePath, visited);
        blockers.push(...inherited.blockers);
        if (inherited.wireType.kind === 'OBJECT') for (const property of inherited.wireType.properties) {
          const previous = properties.find(p=>p.wireName===property.wireName);
          if (!previous) properties.push(property);
          else {
            const signature = (p: WirePropertyContract) => JSON.stringify([p.type,p.optional,p.nullable],(key,value)=>key==='provenance'||key==='name'?undefined:value);
            if (signature(previous)!==signature(property)) {
              properties.splice(properties.indexOf(previous),1,{...previous,type:mkUnknownWireType(`Conflicting inherited property ${property.wireName}`)});
              blockers.push({code:'UNRESOLVED_TS_TYPE',file:filePath,message:`Conflicting inherited property ${property.wireName}`});
            }
          }
        }
        else blockers.push({ code: 'UNRESOLVED_TS_TYPE', file: filePath, message: 'Interface inheritance could not be qualified' });
      }
    }

    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const propName = member.name.getText(sf).replace(/['"]/g, '');
        const isOptional = !!member.questionToken || !!member.type && this.isUndefinedType(member.type);

        let propType: WireType = mkPrimitiveWireType('any');
        let isNullable = false;

        if (member.type) {
          const parsedType = this.parseTypeNode(member.type, filePath, visited);
          blockers.push(...parsedType.blockers);
          propType = parsedType.wireType;
          isNullable = this.isNullableType(member.type);
        }

        // A declared member specializes the inherited property rather than
        // creating a second wire key in the JSON object contract.
        for (let i=properties.length-1;i>=0;i--) if(properties[i].wireName===propName) properties.splice(i,1);
        properties.push({
          wireName: propName,
          type: propType,
          optional: isOptional,
          nullable: isNullable,
          validationConstraints: [],
          provenance: {
            language: 'TYPESCRIPT',
            file: filePath,
            line: sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
            astIdentity: `${node.name.text}.${propName}`,
          }
        });
      }
    }

    return {
      wireType: mkObjectWireType(properties, node.name.text, false, {
        language: 'TYPESCRIPT',
        file: filePath,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        astIdentity: node.name.text,
      }),
      blockers,
    };
  }

  private parseTypeNode(
    typeNode: ts.TypeNode,
    filePath: string,
    visited: Set<string>
  ): TsTypeParseResult {
    const blockers: AnalysisBlocker[] = [];
    const sf = this.getSourceFile(filePath);

    // Primitive keywords
    if (typeNode.kind === ts.SyntaxKind.StringKeyword) return { wireType: mkPrimitiveWireType('string'), blockers };
    if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return { wireType: mkPrimitiveWireType('number'), blockers };
    if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return { wireType: mkPrimitiveWireType('boolean'), blockers };
    if (typeNode.kind === ts.SyntaxKind.BigIntKeyword) return { wireType: mkPrimitiveWireType('bigint'), blockers };
    if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return { wireType: mkPrimitiveWireType('void'), blockers };
    if (typeNode.kind === ts.SyntaxKind.AnyKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword) {
      return { wireType: mkPrimitiveWireType('any'), blockers };
    }

    // Literal type: "admin" | 42 | true
    if (ts.isLiteralTypeNode(typeNode)) {
      const lit = typeNode.literal;
      if (ts.isStringLiteral(lit)) return { wireType: mkLiteralWireType(lit.text), blockers };
      if (ts.isNumericLiteral(lit)) return { wireType: mkLiteralWireType(Number(lit.text)), blockers };
      if (lit.kind === ts.SyntaxKind.TrueKeyword) return { wireType: mkLiteralWireType(true), blockers };
      if (lit.kind === ts.SyntaxKind.FalseKeyword) return { wireType: mkLiteralWireType(false), blockers };
    }

    // Array: T[] or Array<T>
    if (ts.isArrayTypeNode(typeNode)) {
      const inner = this.parseTypeNode(typeNode.elementType, filePath, visited);
      blockers.push(...inner.blockers);
      return { wireType: mkArrayWireType(inner.wireType), blockers };
    }

    if (ts.isTupleTypeNode(typeNode)) {
      const tupleElements: WireType[] = [];
      for (const elem of typeNode.elements) {
        let targetNode: ts.TypeNode = elem;
        if (ts.isNamedTupleMember(targetNode)) {
          targetNode = targetNode.type;
        }
        if (ts.isOptionalTypeNode(targetNode)) {
          const parsed = this.parseTypeNode(targetNode.type, filePath, visited);
          blockers.push(...parsed.blockers);
          tupleElements.push(mkOptionalWireType(parsed.wireType));
        } else if (ts.isRestTypeNode(targetNode)) {
          const parsed = this.parseTypeNode(targetNode.type, filePath, visited);
          blockers.push(...parsed.blockers);
          tupleElements.push(parsed.wireType);
        } else {
          const parsed = this.parseTypeNode(targetNode, filePath, visited);
          blockers.push(...parsed.blockers);
          tupleElements.push(parsed.wireType);
        }
      }
      const union = tupleElements.length === 0
        ? mkPrimitiveWireType('any')
        : tupleElements.length === 1
        ? tupleElements[0]
        : mkUnionWireType(tupleElements);
      return { wireType: mkArrayWireType(union, false, undefined, tupleElements), blockers };
    }

    if(ts.isParenthesizedTypeNode(typeNode))return this.parseTypeNode(typeNode.type,filePath,visited);
    if (ts.isTypeOperatorNode(typeNode)) {
      if (typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) return this.parseTypeNode(typeNode.type,filePath,visited);
      if (typeNode.operator === ts.SyntaxKind.KeyOfKeyword) {
        const parsed=this.parseTypeNode(typeNode.type,filePath,visited);
        const keys=this.objectKeys(parsed.wireType);
        if(keys?.length) return {wireType:this.keyUnion(keys),blockers:parsed.blockers};
        return this.unsupportedType('keyof requires a nonempty finite object key set',filePath,parsed.blockers);
      }
    }
    if (ts.isMappedTypeNode(typeNode)) return this.parseMappedType(typeNode,filePath,visited);
    if(ts.isIntersectionTypeNode(typeNode)){
      let result:WireType|undefined;
      for(const part of typeNode.types){
        const parsed=this.parseTypeNode(part,filePath,visited);blockers.push(...parsed.blockers);
        result=result?this.intersectWireTypes(result,parsed.wireType):parsed.wireType;
        if(!result)return this.unsupportedType('Intersection has incompatible or unsupported members',filePath,blockers);
      }
      return {wireType:result!,blockers};
    }

    // Type reference: UserDto or Array<UserDto>
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName.getText();
      if ((typeName === 'Array' || typeName === 'ReadonlyArray') && typeNode.typeArguments && typeNode.typeArguments.length > 0 && !this.genericDeclaration(typeName,filePath)) {
        const inner = this.parseTypeNode(typeNode.typeArguments[0], filePath, visited);
        blockers.push(...inner.blockers);
        return { wireType: mkArrayWireType(inner.wireType), blockers };
      }
      if (typeNode.typeArguments?.length) return this.parseGeneric(typeName, typeNode.typeArguments, filePath, visited);
      return this.parseTypeByName(typeName, filePath, visited);
    }

    // Union type: string | null | undefined
    if (ts.isUnionTypeNode(typeNode)) {
      const isNull = (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
      const isUndefined = (t: ts.TypeNode) => t.kind === ts.SyntaxKind.UndefinedKeyword || ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'undefined';
      const nonNullTypes = typeNode.types.filter(t => !isNull(t) && !isUndefined(t));
      const isNullable = typeNode.types.some(isNull);

      if (nonNullTypes.length === 1) {
        const inner = this.parseTypeNode(nonNullTypes[0], filePath, visited);
        blockers.push(...inner.blockers);
        return {
          wireType: isNullable ? mkNullableWireType(inner.wireType) : inner.wireType,
          blockers,
        };
      }

      const unionMembers: WireType[] = [];
      for (const t of nonNullTypes) {
        const member = this.parseTypeNode(t, filePath, visited);
        blockers.push(...member.blockers);
        unionMembers.push(member.wireType);
      }
      const union = mkUnionWireType(unionMembers);
      return {
        wireType: isNullable ? mkNullableWireType(union) : union,
        blockers,
      };
    }

    // Inline Type Literal: { id: number; name: string }
    if (ts.isTypeLiteralNode(typeNode)) {
      const properties: WirePropertyContract[] = [];
      for (const member of typeNode.members) {
        if (ts.isPropertySignature(member) && member.name) {
          const propName = member.name.getText().replace(/['"]/g, '');
          const isOptional = !!member.questionToken || !!member.type && this.isUndefinedType(member.type);
          let propType: WireType = mkPrimitiveWireType('any');
          let isNullable = false;
          if (member.type) {
            const parsed = this.parseTypeNode(member.type, filePath, visited);
            blockers.push(...parsed.blockers);
            propType = parsed.wireType;
            isNullable = this.isNullableType(member.type);
          }
          properties.push({
            wireName: propName,
            type: propType,
            optional: isOptional,
            nullable: isNullable,
            validationConstraints: [],
          });
        }
      }
      return { wireType: mkObjectWireType(properties), blockers };
    }

    if (ts.isTypeQueryNode(typeNode)) {
      const declaration=this.enumDeclaration(typeNode.exprName.getText(),filePath);
      if(declaration){
        const values=this.enumValues(declaration);
        if(values.size!==declaration.members.length)return this.unsupportedType('typeof enum requires qualified initializers',filePath);
        return {wireType:mkObjectWireType([...values].map(([wireName,value])=>({wireName,type:mkLiteralWireType(value),optional:false,nullable:false,validationConstraints:[]}))),blockers};
      }
      return this.parseVariableTypeByName(typeNode.exprName.getText(), filePath, visited);
    }

    if (ts.isIndexedAccessTypeNode(typeNode)) {
      const objResult = this.parseTypeNode(typeNode.objectType, filePath, visited);
      blockers.push(...objResult.blockers);
      const indexNode = typeNode.indexType;

      if (indexNode.kind === ts.SyntaxKind.NumberKeyword) {
        if (objResult.wireType.kind === 'ARRAY') {
          return { wireType: objResult.wireType.elementType, blockers };
        }
      }
      if (ts.isLiteralTypeNode(indexNode)) {
        if (ts.isStringLiteral(indexNode.literal)) {
          const propName = indexNode.literal.text;
          if (objResult.wireType.kind === 'OBJECT') {
            const found = objResult.wireType.properties.find(p => p.wireName === propName);
            if (found) {
              const innerType = found.nullable && found.type.kind !== 'NULLABLE' ? mkNullableWireType(found.type) : found.type;
              const propType = found.optional && innerType.kind !== 'OPTIONAL' ? mkOptionalWireType(innerType) : innerType;
              return { wireType: propType, blockers };
            }
          }
        } else if (ts.isNumericLiteral(indexNode.literal)) {
          const idx = Number(indexNode.literal.text);
          if (objResult.wireType.kind === 'ARRAY') {
            if (objResult.wireType.tupleElements) {
              if (Number.isInteger(idx) && idx >= 0 && idx < objResult.wireType.tupleElements.length) {
                return { wireType: objResult.wireType.tupleElements[idx], blockers };
              }
              const message = `Tuple index ${idx} is outside the known positions`;
              return {wireType:mkUnknownWireType(message),blockers:[...blockers,{code:'UNRESOLVED_TS_TYPE',file:filePath,message}]};
            }
            return { wireType: objResult.wireType.elementType, blockers };
          }
        }
      }
      if (ts.isUnionTypeNode(indexNode) && objResult.wireType.kind === 'OBJECT') {
        const propTypes: WireType[] = [];
        let allResolved = true;
        for (const t of indexNode.types) {
          if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) {
            const found = objResult.wireType.properties.find(p => p.wireName === (t.literal as ts.StringLiteral).text);
            if (found) {
              const innerType = found.nullable && found.type.kind !== 'NULLABLE' ? mkNullableWireType(found.type) : found.type;
              const propType = found.optional && innerType.kind !== 'OPTIONAL' ? mkOptionalWireType(innerType) : innerType;
              propTypes.push(propType);
            } else {
              allResolved = false;
              break;
            }
          } else {
            allResolved = false;
            break;
          }
        }
        if (allResolved && propTypes.length > 0) {
          return { wireType: propTypes.length === 1 ? propTypes[0] : mkUnionWireType(propTypes), blockers };
        }
      }
      if (objResult.wireType.kind === 'MAP') {
        if (
          (indexNode.kind === ts.SyntaxKind.StringKeyword && objResult.wireType.keyType.kind === 'PRIMITIVE' && objResult.wireType.keyType.scalar === 'string') ||
          (indexNode.kind === ts.SyntaxKind.NumberKeyword && objResult.wireType.keyType.kind === 'PRIMITIVE' && objResult.wireType.keyType.scalar === 'number')
        ) {
          return { wireType: objResult.wireType.valueType, blockers };
        }
      }
      const selection=this.parseTypeNode(indexNode,filePath,visited);
      const keys=this.finiteKeys(selection.wireType);
      if(keys&&objResult.wireType.kind==='OBJECT'){
        const types:WireType[]=[];
        for(const key of keys){
          const property=objResult.wireType.properties.find(p=>p.wireName===key);
          if(!property)return this.unsupportedType(`Indexed property ${key} is absent`,filePath,[...blockers,...selection.blockers]);
          const nullable=property.nullable&&property.type.kind!=='NULLABLE'?mkNullableWireType(property.type):property.type;
          types.push(property.optional&&nullable.kind!=='OPTIONAL'?mkOptionalWireType(nullable):nullable);
        }
        if(types.length)return {wireType:types.length===1?types[0]:mkUnionWireType(types),blockers:[...blockers,...selection.blockers]};
      }
      return {
        wireType: mkUnknownWireType(`Unsupported indexed access ${typeNode.getText()}`),
        blockers: [...blockers, { code: 'UNRESOLVED_TS_TYPE', file: filePath, message: `Unsupported indexed access ${typeNode.getText()}` }]
      };
    }

    return { wireType: mkUnknownWireType(`Unsupported TypeScript type ${typeNode.getText()}`), blockers: [{ code: 'UNRESOLVED_TS_TYPE', file: filePath, message: `Unsupported TypeScript type ${typeNode.getText()}` }] };
  }

  private parseVariableTypeByName(
    varName: string,
    originFile: string,
    visited = new Set<string>()
  ): TsTypeParseResult {
    const key = `var:${originFile}:${varName}`;
    if (visited.has(key)) return { wireType: mkUnknownWireType(`Recursive variable: ${key}`), blockers: [] };
    visited = new Set([...visited, key]);

    const sf = this.getSourceFile(originFile);
    if (!sf) return { wireType: mkUnknownWireType(`Unknown file for variable: ${originFile}`), blockers: [] };

    for (const statement of sf.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === varName) {
            if (decl.type) {
              return this.parseTypeNode(decl.type, originFile, visited);
            }
            let init: ts.Expression | undefined = decl.initializer;
            let isAsConst = false;
            if (init && (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init))) {
              if (ts.isTypeReferenceNode(init.type) && ts.isIdentifier(init.type.typeName) && init.type.typeName.text === 'const') {
                isAsConst = true;
              } else {
                return this.parseTypeNode(init.type,originFile,visited);
              }
              init = init.expression;
            }
            if (init && ts.isArrayLiteralExpression(init)) {
              if (isAsConst) {
                const literals: WireType[] = [];
                let allLiterals = true;
                for (let elem of init.elements) {
                  if (ts.isAsExpression(elem) || ts.isTypeAssertionExpression(elem)) {
                    allLiterals=false;break;
                  }
                  if (ts.isStringLiteral(elem)) {
                    literals.push(mkLiteralWireType(elem.text));
                  } else if (ts.isNumericLiteral(elem)) {
                    literals.push(mkLiteralWireType(Number(elem.text)));
                  } else if (elem.kind === ts.SyntaxKind.TrueKeyword) {
                    literals.push(mkLiteralWireType(true));
                  } else if (elem.kind === ts.SyntaxKind.FalseKeyword) {
                    literals.push(mkLiteralWireType(false));
                  } else {
                    allLiterals = false;
                    break;
                  }
                }
                if (allLiterals && literals.length > 0) {
                  const union = literals.length === 1 ? literals[0] : mkUnionWireType(literals);
                  return { wireType: mkArrayWireType(union, false, undefined, literals), blockers: [] };
                }
              } else {
                // Mutable array without `as const`: standard TypeScript infers string[], number[], or boolean[]
                let hasString = false;
                let hasNumber = false;
                let hasBoolean = false;
                let hasOther = false;
                for (let elem of init.elements) {
                  if (ts.isAsExpression(elem) || ts.isTypeAssertionExpression(elem)) {
                    hasOther=true;break;
                  }
                  if (ts.isStringLiteral(elem)) hasString = true;
                  else if (ts.isNumericLiteral(elem)) hasNumber = true;
                  else if (elem.kind === ts.SyntaxKind.TrueKeyword || elem.kind === ts.SyntaxKind.FalseKeyword) hasBoolean = true;
                  else hasOther = true;
                }
                const types: WireType[] = [];
                if (hasString) types.push(mkPrimitiveWireType('string'));
                if (hasNumber) types.push(mkPrimitiveWireType('number'));
                if (hasBoolean) types.push(mkPrimitiveWireType('boolean'));
                if (hasOther||!types.length)return this.unsupportedType(`Array initializer for ${varName} requires element inference`,originFile);
                const elemType = types.length === 1 ? types[0] : types.length > 1 ? mkUnionWireType(types) : mkPrimitiveWireType('any');
                return { wireType: mkArrayWireType(elemType), blockers: [] };
              }
            }
            if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init))) {
              if (isAsConst || !!(statement.declarationList.flags & ts.NodeFlags.Const)) {
                const val = ts.isStringLiteral(init) ? init.text : Number(init.text);
                return { wireType: mkLiteralWireType(val), blockers: [] };
              }
              const prim = ts.isStringLiteral(init) ? mkPrimitiveWireType('string') : mkPrimitiveWireType('number');
              return { wireType: prim, blockers: [] };
            }
          }
        }
      }
    }

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        let importedName: string | null = null;
        if (clause.name && clause.name.text === varName) {
          importedName = 'default';
        } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            if (specifier.name.text === varName) {
              importedName = specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
              break;
            }
          }
        }
        if (importedName) {
          const target = this.resolveModulePath(statement.moduleSpecifier.text, originFile);
          if (target) {
            return this.parseVariableTypeByName(importedName, target, visited);
          }
        }
      }
    }

    for (const statement of sf.statements) {
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = this.resolveModulePath(statement.moduleSpecifier.text, originFile);
        if (!target) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const specifier = statement.exportClause.elements.find(e => e.name.text === varName);
          if (specifier) {
            return this.parseVariableTypeByName(specifier.propertyName?.text ?? specifier.name.text, target, visited);
          }
        } else if (!statement.exportClause) {
          const result = this.parseVariableTypeByName(varName, target, visited);
          if (result.wireType.kind !== 'UNKNOWN') return result;
        }
      }
    }

    return {
      wireType: mkUnknownWireType(`Unresolved variable type: ${varName}`),
      blockers: [{
        code: 'UNRESOLVED_TS_TYPE',
        file: originFile,
        message: `Cannot resolve variable '${varName}' for typeof query`
      }]
    };
  }

  private unresolvedGeneric(name: string, file: string): TsTypeParseResult {
    return {wireType: mkUnknownWireType(`Unresolved generic ${name}`), blockers: [{code:'UNRESOLVED_TS_TYPE',file,message:`Generic ${name} requires qualified type arguments`}]};
  }

  private unsupportedType(message:string,file:string,blockers:readonly AnalysisBlocker[]=[]):TsTypeParseResult {
    return {wireType:mkUnknownWireType(message),blockers:[...blockers,{code:'UNRESOLVED_TS_TYPE',file,message}]};
  }

  private intersectWireTypes(left:WireType,right:WireType,budget=64):WireType|undefined {
    const signature=(type:WireType)=>JSON.stringify(type,(key,value)=>key==='provenance'||key==='name'?undefined:value);
    if(signature(left)===signature(right))return left;
    if(budget<=0||left.kind==='UNKNOWN'||right.kind==='UNKNOWN')return;
    if(left.kind==='UNION'||right.kind==='UNION'){
      const a=left.kind==='UNION'?left.types:[left],b=right.kind==='UNION'?right.types:[right];
      if(a.length*b.length>budget)return;
      const types:WireType[]=[];
      for(const x of a)for(const y of b){const member=this.intersectWireTypes(x,y,budget-a.length*b.length);if(!member)return;types.push(member);}
      return types.length===1?types[0]:mkUnionWireType(types);
    }
    if(left.kind==='LITERAL'&&right.kind==='PRIMITIVE'&&typeof left.value===right.scalar)return left;
    if(right.kind==='LITERAL'&&left.kind==='PRIMITIVE'&&typeof right.value===left.scalar)return right;
    if(left.kind==='OBJECT'&&right.kind==='OBJECT'){
      const properties=[...left.properties];
      for(const property of right.properties){
        const index=properties.findIndex(p=>p.wireName===property.wireName);
        if(index<0){properties.push(property);continue;}
        const prior=properties[index],type=this.intersectWireTypes(prior.type,property.type,budget-1);
        if(!type)return;
        properties[index]={...prior,type,optional:prior.optional&&property.optional,nullable:prior.nullable&&property.nullable};
      }
      return mkObjectWireType(properties);
    }
    return undefined;
  }

  private finiteKeys(type:WireType):string[]|undefined {
    if(type.kind==='LITERAL'&&(typeof type.value==='string'||typeof type.value==='number'))return [String(type.value)];
    if(type.kind==='ENUM')return type.values.map(String);
    if(type.kind==='UNION'){
      const keys:string[]=[];
      for(const member of type.types){const part=this.finiteKeys(member);if(!part)return;keys.push(...part);}
      return [...new Set(keys)];
    }
    return undefined;
  }

  private objectKeys(type:WireType):string[]|undefined {
    if(type.kind==='OBJECT')return type.properties.map(p=>p.wireName);
    if(type.kind==='UNION'){
      const sets=type.types.map(t=>this.objectKeys(t));
      if(sets.some(s=>!s))return;
      return sets[0]?.filter(key=>sets.every(s=>s!.includes(key)));
    }
    return undefined;
  }

  private keyUnion(keys:readonly string[]):WireType {
    const types=[...new Set(keys)].map(key=>mkLiteralWireType(key));
    return types.length===1?types[0]:mkUnionWireType(types);
  }

  private parseMappedType(node:ts.MappedTypeNode,file:string,visited:Set<string>):TsTypeParseResult {
    if(!node.type||!node.typeParameter.constraint||node.nameType)return this.unsupportedType('Mapped type requires a value and qualified keys without key remapping',file);
    const constraint=this.parseTypeNode(node.typeParameter.constraint,file,visited);
    const keys=this.finiteKeys(constraint.wireType);
    if(!keys&&constraint.wireType.kind==='PRIMITIVE'&&['string','number'].includes(constraint.wireType.scalar)&&!node.questionToken){
      const previous=this.typeBindings;this.typeBindings=new Map(previous);
      this.typeBindings.set(`${file}:${node.typeParameter.name.text}`,constraint.wireType);
      try{const value=this.parseTypeNode(node.type,file,visited);return {wireType:{kind:'MAP',keyType:constraint.wireType,valueType:value.wireType},blockers:[...constraint.blockers,...value.blockers]};}
      finally{this.typeBindings=previous;}
    }
    if(!keys||keys.length>512)return this.unsupportedType('Mapped type requires at most 512 finite keys',file,constraint.blockers);
    let original:WireType|undefined;
    const keyNode=node.typeParameter.constraint;
    if(ts.isTypeOperatorNode(keyNode)&&keyNode.operator===ts.SyntaxKind.KeyOfKeyword)original=this.parseTypeNode(keyNode.type,file,visited).wireType;
    const previous=this.typeBindings;
    const properties:WirePropertyContract[]=[],blockers:AnalysisBlocker[]=[...constraint.blockers];
    try{
      for(const key of keys){
        this.typeBindings=new Map(previous);
        this.typeBindings.set(`${file}:${node.typeParameter.name.text}`,mkLiteralWireType(key));
        const value=this.parseTypeNode(node.type,file,visited);blockers.push(...value.blockers);
        const inherited=original?.kind==='OBJECT'?original.properties.find(p=>p.wireName===key):undefined;
        const optional=node.questionToken?node.questionToken.kind!==ts.SyntaxKind.MinusToken:inherited?.optional??false;
        const type=node.questionToken?.kind===ts.SyntaxKind.MinusToken&&value.wireType.kind==='OPTIONAL'?value.wireType.innerType:value.wireType;
        properties.push({wireName:key,type,optional,nullable:type.kind==='NULLABLE',validationConstraints:[]});
      }
    }finally{this.typeBindings=previous;}
    return {wireType:mkObjectWireType(properties),blockers};
  }

  private genericDeclaration(name: string, file: string, visited = new Set<string>()): {node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration; file: string} | undefined {
    const key = `${file}:${name}`;
    if (visited.has(key)) return undefined;
    visited = new Set([...visited,key]);
    const sf = this.getSourceFile(file);
    if (!sf) return undefined;
    for (const statement of sf.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)||ts.isClassDeclaration(statement)) && statement.name?.text === name) return {node:statement,file};
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        const imported = statement.importClause.namedBindings.elements.find(e=>e.name.text===name);
        const target = this.resolveModulePath(statement.moduleSpecifier.text,file);
        if (imported && target) return this.exportedGeneric(imported.propertyName?.text ?? imported.name.text,target,visited);
      }
    }
    return undefined;
  }

  private exportedGeneric(name: string, file: string, visited: Set<string>): {node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration; file: string} | undefined {
    const sf = this.getSourceFile(file);
    if (!sf || visited.has(`${file}:${name}`)) return undefined;
    const next = new Set([...visited,`${file}:${name}`]);
    for (const statement of sf.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)||ts.isClassDeclaration(statement)) && statement.name?.text===name && ts.getModifiers(statement)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) return {node:statement,file};
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = this.resolveModulePath(statement.moduleSpecifier.text,file);
        if (!target) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const exported = statement.exportClause.elements.find(e=>e.name.text===name);
          if (exported) return this.exportedGeneric(exported.propertyName?.text ?? exported.name.text,target,next);
        } else if (!statement.exportClause) {
          const result = this.exportedGeneric(name,target,next);
          if (result) return result;
        }
      }
    }
    return undefined;
  }

  private parseGeneric(name: string, args: readonly ts.TypeNode[], origin: string, visited: Set<string>): TsTypeParseResult {
    if (['z.input', 'z.output', 'z.infer', 'z.TypeOf', 'input', 'output', 'infer', 'TypeOf'].includes(name) || name.endsWith('.input') || name.endsWith('.output') || name.endsWith('.infer') || name.endsWith('.TypeOf')) {
      if (args.length >= 1) {
        let targetType: WireType | undefined;
        let blockers: AnalysisBlocker[] = [];
        if (ts.isTypeQueryNode(args[0])) {
          const varName = args[0].exprName.getText();
          const parsed = this.parseTypeByName(varName, origin, visited);
          targetType = parsed.wireType;
          blockers = [...parsed.blockers];
        } else {
          const parsed = this.parseTypeNode(args[0], origin, visited);
          targetType = parsed.wireType;
          blockers = [...parsed.blockers];
        }
        if (targetType) {
          const isInput = name === 'z.input' || name === 'input' || name.endsWith('.input');
          const transformed = isInput ? toInputWireType(targetType) : toOutputWireType(targetType);
          return { wireType: transformed, blockers };
        }
      }
    }
    if(['Partial','Required','Readonly','Pick','Omit','Record','NonNullable','Exclude','Extract'].includes(name)&&!this.genericDeclaration(name,origin)){
      if(['NonNullable','Exclude','Extract'].includes(name)){
        if(args.length!==(name==='NonNullable'?1:2))return this.unresolvedGeneric(name,origin);
        const first=this.parseTypeNode(args[0],origin,visited);
        if(name==='NonNullable')return {wireType:this.nonNullable(first.wireType),blockers:first.blockers};
        const second=this.parseTypeNode(args[1],origin,visited);
        const literals=(type:WireType):WireType[]|undefined=>type.kind==='LITERAL'?[type]:type.kind==='ENUM'?type.values.map(value=>mkLiteralWireType(value)):type.kind==='UNION'?type.types.reduce<WireType[]|undefined>((all,t)=>{const next=literals(t);return all&&next?[...all,...next]:undefined;},[]):undefined;
        const values=literals(first.wireType),selection=literals(second.wireType);
        if(!values||!selection)return this.unsupportedType(`${name} requires finite literal sets`,origin,[...first.blockers,...second.blockers]);
        const members=values.filter(t=>selection.some(s=>s.kind==='LITERAL'&&t.kind==='LITERAL'&&s.value===t.value)===(name==='Extract'));
        if(!members.length)return this.unsupportedType(`${name} produces an empty type`,origin,[...first.blockers,...second.blockers]);
        return {wireType:members.length===1?members[0]:mkUnionWireType(members),blockers:[...first.blockers,...second.blockers]};
      }
      const expected=['Pick','Omit','Record'].includes(name)?2:1;if(args.length!==expected)return this.unresolvedGeneric(name,origin);
      const first=this.parseTypeNode(args[0],origin,visited);
      const keys=(type:WireType):string[]|undefined=>type.kind==='LITERAL'&&(typeof type.value==='string'||typeof type.value==='number')?[String(type.value)]:type.kind==='ENUM'?type.values.map(String):type.kind==='UNION'?type.types.reduce<string[]|undefined>((all,item)=>{const next=keys(item);return all&&next?[...all,...next]:undefined;},[]):undefined;
      if(name==='Record'){
        const value=this.parseTypeNode(args[1],origin,visited),finite=keys(first.wireType),blockers=[...first.blockers,...value.blockers];
        if(finite)return {wireType:mkObjectWireType(finite.map(wireName=>({wireName,type:value.wireType,optional:false,nullable:value.wireType.kind==='NULLABLE',validationConstraints:[]}))),blockers};
        if(first.wireType.kind==='PRIMITIVE'&&['string','number'].includes(first.wireType.scalar))return {wireType:{kind:'MAP',keyType:first.wireType,valueType:value.wireType},blockers};
        return this.unresolvedGeneric(name,origin);
      }
      if(first.wireType.kind!=='OBJECT')return this.unresolvedGeneric(name,origin);
      let properties=[...first.wireType.properties],blockers=[...first.blockers];
      if(name==='Partial')properties=properties.map(p=>({...p,optional:true}));
      if(name==='Required')properties=properties.map(p=>({...p,optional:false,type:p.type.kind==='OPTIONAL'?p.type.innerType:p.type}));
      if(name==='Pick'||name==='Omit'){const selection=this.parseTypeNode(args[1],origin,visited),selected=keys(selection.wireType);if(!selected)return this.unresolvedGeneric(name,origin);blockers.push(...selection.blockers);if(name==='Pick'&&selected.some(key=>!properties.some(p=>p.wireName===key)))return this.unresolvedGeneric(name,origin);properties=properties.filter(p=>name==='Pick'?selected.includes(p.wireName):!selected.includes(p.wireName));}
      return {wireType:{...first.wireType,properties},blockers};
    }
    const key = `generic:${origin}:${name}<${args.map(arg=>arg.getText()).join(',')}>`;
    if (visited.has(key)) return this.unresolvedGeneric(name,origin);
    visited = new Set([...visited,key]);
    const declaration = this.genericDeclaration(name,origin);
    const parameters=declaration?.node.typeParameters;
    if (!declaration || !parameters || args.length>parameters.length || parameters.slice(args.length).some(p=>!p.default)) return this.unresolvedGeneric(name,origin);
    const blockers: AnalysisBlocker[] = [];
    const bindings = new Map(this.typeBindings);
    const previous = this.typeBindings;
    this.typeBindings = bindings;
    try {
      for(let i=0;i<parameters.length;i++){
        const parsed=this.parseTypeNode(args[i]??parameters[i].default!,args[i]?origin:declaration.file,visited);
        blockers.push(...parsed.blockers);bindings.set(`${declaration.file}:${parameters[i].name.text}`,parsed.wireType);
      }
      const parsed = ts.isInterfaceDeclaration(declaration.node)
        ? this.parseInterfaceDeclaration(declaration.node,declaration.file,visited)
        : ts.isClassDeclaration(declaration.node)?this.parseClassDeclaration(declaration.node,declaration.file,visited):this.parseTypeNode(declaration.node.type,declaration.file,visited);
      return {wireType:parsed.wireType,blockers:[...blockers,...parsed.blockers]};
    } finally { this.typeBindings = previous; }
  }

  private nonNullable(type:WireType):WireType {
    if(type.kind==='NULLABLE'||type.kind==='OPTIONAL')return this.nonNullable(type.innerType);
    return type;
  }

  private isNullableType(typeNode: ts.TypeNode): boolean {
    if (ts.isUnionTypeNode(typeNode)) {
      return typeNode.types.some(t => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword);
    }
    return false;
  }

  private isUndefinedType(typeNode: ts.TypeNode): boolean {
    return ts.isUnionTypeNode(typeNode) && typeNode.types.some(t => t.kind === ts.SyntaxKind.UndefinedKeyword || ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === 'undefined');
  }

  /**
   * Parse a Zod schema AST expression: z.object({ ... }).strict()
   */
  public tryParseZodSchema(
    expr: ts.Expression,
    filePath: string,
    visited: Set<string>
  ): TsTypeParseResult | null {
    const blockers: AnalysisBlocker[] = [];
    const sf = this.getSourceFile(filePath);
    let isStrict = false;
    let isOptional = false;
    let isNullable = false;
    let currentExpr = expr;

    interface DeferredZodOp {
      readonly op: 'extend' | 'merge' | 'pick' | 'omit';
      readonly callExpr: ts.CallExpression;
    }
    const deferredOps: DeferredZodOp[] = [];

    // Unwrap chained calls like .strict(), .passthrough(), .optional(), .extend(), .merge(), .pick(), .omit()
    while (ts.isCallExpression(currentExpr)) {
      const callee = currentExpr.expression;
      let methodName = '';
      if (ts.isPropertyAccessExpression(callee)) {
        methodName = callee.name.text;
      } else if (ts.isIdentifier(callee)) {
        methodName = callee.text;
      }

      if (methodName) {
        if (['object', 'enum', 'union', 'literal', 'string', 'number', 'boolean', 'array', 'record', 'intersection', 'any', 'unknown'].includes(methodName)) {
          break;
        }
        if (methodName === 'strict') isStrict = true;
        else if (methodName === 'optional') isOptional = true;
        else if (methodName === 'nullable') isNullable = true;
        else if (methodName === 'default') isOptional = true;
        else if (methodName === 'passthrough' || methodName === 'strip') {
          // passthrough/strip: keep isStrict as default false
        } else if (methodName === 'extend' || methodName === 'merge' || methodName === 'pick' || methodName === 'omit') {
          deferredOps.push({ op: methodName, callExpr: currentExpr });
        } else {
          return {
            wireType: mkUnknownWireType(`Unsupported Zod object modifier .${methodName}()`),
            blockers: [{ code: methodName === 'transform' ? 'DYNAMIC_ZOD_TRANSFORM' : 'UNSUPPORTED_ZOD_TYPE', file: filePath, message: `Zod object modifier .${methodName}() cannot be established statically` }],
          };
        }
        currentExpr = ts.isPropertyAccessExpression(callee) ? callee.expression : currentExpr;
        if (!ts.isPropertyAccessExpression(callee)) break;
      } else {
        break;
      }
    }

    let baseObj: ObjectWireType | null = null;

    if (ts.isCallExpression(currentExpr)) {
      const callee = currentExpr.expression;
      let isObject = false;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'object') isObject = true;
      if (ts.isIdentifier(callee) && callee.text === 'object') isObject = true;

      if (isObject) {
        const args = currentExpr.arguments;
        if (args.length > 0 && ts.isObjectLiteralExpression(args[0])) {
          const properties: WirePropertyContract[] = [];
          for (const prop of args[0].properties) {
            if (ts.isPropertyAssignment(prop) && prop.name) {
              const propName = prop.name.getText(sf).replace(/['"]/g, '');
              const propZod = this.parseZodField(prop.initializer, filePath);
              blockers.push(...propZod.blockers);
              properties.push({
                wireName: propName,
                type: propZod.wireType,
                optional: propZod.isOptional,
                nullable: propZod.isNullable,
                ...(propZod.hasDefault ? { hasDefault: true, defaultValue: propZod.defaultValue, outputOptional: propZod.outputOptional } : {}),
                validationConstraints: [],
              });

            }
          }

          baseObj = mkObjectWireType(properties, undefined, isStrict, {
            language: 'TYPESCRIPT',
            file: filePath,
            line: sf ? sf.getLineAndCharacterOfPosition(currentExpr.getStart(sf)).line + 1 : 1,
            annotationOrSchema: 'ZodSchema',
          });
        }
      }
    }

    if (!baseObj && ts.isIdentifier(currentExpr) && sf) {
      const varName = currentExpr.text;
      const key = `${filePath}:${varName}`;
      if (!visited.has(key)) {
        const nextVisited = new Set(visited).add(key);
        for (const stmt of sf.statements) {
          if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name) && decl.name.text === varName && decl.initializer) {
                const parsed = this.tryParseZodSchema(decl.initializer, filePath, nextVisited);
                if (parsed) {
                  blockers.push(...parsed.blockers);
                  if (parsed.wireType.kind === 'OBJECT') {
                    baseObj = parsed.wireType;
                  }
                }
                break;
              }
            }
          }
        }
      }
    }

    if (!baseObj && currentExpr !== expr) {
      const parsed = this.tryParseZodSchema(currentExpr, filePath, visited);
      if (parsed) {
        blockers.push(...parsed.blockers);
        if (parsed.wireType.kind === 'OBJECT') {
          baseObj = parsed.wireType;
        }
      }
    }

    if (!baseObj) {
      if (deferredOps.length > 0) {
        blockers.push({
          code: 'DYNAMIC_ZOD_SCHEMA',
          message: 'Base schema for Zod modifier must resolve to an OBJECT wireType',
          file: filePath,
        });
        return {
          wireType: mkUnknownWireType('Base schema is not an OBJECT wireType'),
          blockers,
        };
      }
      const fieldRes = this.parseZodField(currentExpr, filePath);
      if (fieldRes.wireType.kind !== 'UNKNOWN' || fieldRes.blockers.length > 0) {
        let wireType = fieldRes.wireType;
        if ((isNullable || fieldRes.isNullable) && wireType.kind !== 'NULLABLE') {
          wireType = mkNullableWireType(wireType);
        }
        if ((isOptional || fieldRes.isOptional) && wireType.kind !== 'OPTIONAL') {
          wireType = mkOptionalWireType(wireType);
        }
        return { wireType, blockers: [...blockers, ...fieldRes.blockers] };
      }
      return null;
    }

    let currentObj: ObjectWireType = baseObj;

    for (let i = deferredOps.length - 1; i >= 0; i--) {
      const { op, callExpr } = deferredOps[i];
      const args = callExpr.arguments;

      if (op === 'extend') {
        if (args.length === 0 || !ts.isObjectLiteralExpression(args[0])) {
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: '.extend() requires an object literal argument',
            file: filePath,
          });
          return {
            wireType: mkUnknownWireType('.extend() requires an object literal argument'),
            blockers,
          };
        }
        const extProps: WirePropertyContract[] = [];
        for (const prop of args[0].properties) {
          if (ts.isPropertyAssignment(prop) && prop.name) {
            const propName = prop.name.getText(sf).replace(/['"]/g, '');
            const propZod = this.parseZodField(prop.initializer, filePath);
            blockers.push(...propZod.blockers);
            extProps.push({
              wireName: propName,
              type: propZod.wireType,
              optional: propZod.isOptional,
              nullable: propZod.isNullable,
              ...(propZod.hasDefault ? { hasDefault: true, defaultValue: propZod.defaultValue, outputOptional: propZod.outputOptional } : {}),
              validationConstraints: [],
            });
          } else {
            blockers.push({
              code: 'DYNAMIC_ZOD_SCHEMA',
              message: 'Unsupported property in .extend() object literal',
              file: filePath,
            });
            return {
              wireType: mkUnknownWireType('Unsupported property in .extend() object literal'),
              blockers,
            };
          }
        }
        const mergedProperties = [...currentObj.properties];
        for (const newProp of extProps) {
          const idx = mergedProperties.findIndex(p => p.wireName === newProp.wireName);
          if (idx >= 0) {
            mergedProperties[idx] = newProp;
          } else {
            mergedProperties.push(newProp);
          }
        }
        currentObj = mkObjectWireType(mergedProperties, currentObj.name, currentObj.strict, currentObj.provenance);
      } else if (op === 'merge') {
        if (args.length === 0) {
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: '.merge() requires an argument',
            file: filePath,
          });
          return {
            wireType: mkUnknownWireType('.merge() requires an argument'),
            blockers,
          };
        }
        const arg = args[0];
        let argProps: WirePropertyContract[] = [];
        let argStrict = currentObj.strict;

        if (ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name) {
              const propName = prop.name.getText(sf).replace(/['"]/g, '');
              const propZod = this.parseZodField(prop.initializer, filePath);
              blockers.push(...propZod.blockers);
              argProps.push({
                wireName: propName,
                type: propZod.wireType,
                optional: propZod.isOptional,
                nullable: propZod.isNullable,
                ...(propZod.hasDefault ? { hasDefault: true, defaultValue: propZod.defaultValue, outputOptional: propZod.outputOptional } : {}),
                validationConstraints: [],
              });
            } else {


              blockers.push({
                code: 'DYNAMIC_ZOD_SCHEMA',
                message: 'Unsupported property in .merge() object literal',
                file: filePath,
              });
              return {
                wireType: mkUnknownWireType('Unsupported property in .merge() object literal'),
                blockers,
              };
            }
          }
        } else {
          const parsedArg = this.tryParseZodSchema(arg, filePath, visited);
          if (parsedArg && parsedArg.wireType.kind === 'OBJECT') {
            blockers.push(...parsedArg.blockers);
            argProps = [...parsedArg.wireType.properties];
            argStrict = parsedArg.wireType.strict;
          } else {
            blockers.push({
              code: 'DYNAMIC_ZOD_SCHEMA',
              message: '.merge() argument must be an object literal or Zod object schema',
              file: filePath,
            });
            return {
              wireType: mkUnknownWireType('.merge() argument must be an object literal or Zod object schema'),
              blockers,
            };
          }
        }

        const mergedProperties = [...currentObj.properties];
        for (const newProp of argProps) {
          const idx = mergedProperties.findIndex(p => p.wireName === newProp.wireName);
          if (idx >= 0) {
            mergedProperties[idx] = newProp;
          } else {
            mergedProperties.push(newProp);
          }
        }
        currentObj = mkObjectWireType(mergedProperties, currentObj.name, argStrict, currentObj.provenance);
      } else if (op === 'pick' || op === 'omit') {
        if (args.length === 0 || !ts.isObjectLiteralExpression(args[0])) {
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: `.${op}() requires an object literal argument with keys mapping to true`,
            file: filePath,
          });
          return {
            wireType: mkUnknownWireType(`.${op}() requires an object literal argument`),
            blockers,
          };
        }
        const keySet = new Set<string>();
        let valid = true;
        for (const prop of args[0].properties) {
          if (ts.isPropertyAssignment(prop) && prop.name) {
            const keyName = prop.name.getText(sf).replace(/['"]/g, '');
            if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
              keySet.add(keyName);
            } else {
              valid = false;
              break;
            }
          } else {
            valid = false;
            break;
          }
        }
        if (!valid) {
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: `.${op}() keys must map to true literals`,
            file: filePath,
          });
          return {
            wireType: mkUnknownWireType(`.${op}() keys must map to true literals`),
            blockers,
          };
        }
        const filteredProperties = currentObj.properties.filter(p =>
          op === 'pick' ? keySet.has(p.wireName) : !keySet.has(p.wireName)
        );
        currentObj = mkObjectWireType(filteredProperties, currentObj.name, currentObj.strict, currentObj.provenance);
      }
    }

    if (isStrict) {
      currentObj = mkObjectWireType(currentObj.properties, currentObj.name, true, currentObj.provenance);
    }
    let wireType: WireType = currentObj;
    if (isNullable) wireType = mkNullableWireType(wireType);
    if (isOptional) wireType = mkOptionalWireType(wireType);
    return { wireType, blockers };
  }

  private parseZodField(
    expr: ts.Expression,
    filePath: string
  ): {
    wireType: WireType;
    isOptional: boolean;
    isNullable: boolean;
    hasDefault?: boolean;
    defaultValue?: unknown;
    outputOptional?: boolean;
    blockers: AnalysisBlocker[];
  } {
    const blockers: AnalysisBlocker[] = [];
    const sf = this.getSourceFile(filePath);
    let current = expr;

    interface ModifierCall {
      method: string;
      callExpr: ts.CallExpression;
    }
    const modifierCalls: ModifierCall[] = [];

    // Unwrap modifiers like .optional(), .nullable(), .default(), .min(), .max(), etc.
    while (ts.isCallExpression(current)) {
      const callee = current.expression;
      let method = '';
      if (ts.isPropertyAccessExpression(callee)) {
        method = callee.name.text;
      } else if (ts.isIdentifier(callee)) {
        method = callee.text;
      }

      if (method) {
        // Stop unwrapping if we hit the base type creation methods
        if (['string', 'number', 'boolean', 'array', 'enum', 'union', 'literal', 'record', 'intersection', 'any', 'unknown', 'object', 'extend', 'merge', 'pick', 'omit'].includes(method)) {
          break;
        }
        
        if (method === 'optional' || method === 'nullish' || method === 'nullable' || method === 'default') {
          modifierCalls.push({ method, callExpr: current });
        } else {
          // Unsupported validation constraints (min, max, email, etc.)
          blockers.push({
            code: 'UNSUPPORTED_VALIDATION_RULE',
            message: `Zod validation modifier .${method}() is not fully supported and may be lost`,
            file: filePath,
          });
          return { wireType: mkUnknownWireType(`Unsupported Zod validation .${method}()`), isOptional: false, isNullable: false, blockers };
        }
        
        // Move to the next inner expression
        current = ts.isPropertyAccessExpression(callee) ? callee.expression : current;
        if (!ts.isPropertyAccessExpression(callee)) break; // Cannot unwrap identifier further
      } else {
        break;
      }
    }

    const hasDefault = modifierCalls.some(m => m.method === 'default');
    const defaultIndex = modifierCalls.findIndex(m => m.method === 'default');
    const defaultCall = defaultIndex >= 0 ? modifierCalls[defaultIndex] : undefined;

    let defaultValue: unknown;
    if (defaultCall && defaultCall.callExpr.arguments.length > 0) {
      const arg = defaultCall.callExpr.arguments[0];
      if (ts.isStringLiteral(arg)) defaultValue = arg.text;
      else if (ts.isNumericLiteral(arg)) defaultValue = Number(arg.text);
      else if (arg.kind === ts.SyntaxKind.TrueKeyword) defaultValue = true;
      else if (arg.kind === ts.SyntaxKind.FalseKeyword) defaultValue = false;
      else if (arg.kind === ts.SyntaxKind.NullKeyword) defaultValue = null;
      else defaultValue = arg.getText(sf);
    }

    const isNullable = modifierCalls.some(m => m.method === 'nullable' || m.method === 'nullish');
    
    // On input: defaulted fields, optional fields, and nullish fields are all optional
    const isOptional = hasDefault || modifierCalls.some(m => m.method === 'optional' || m.method === 'nullish');

    // On output: if defaulted, it is guaranteed present UNLESS an outer modifier was optional or nullish
    // In modifierCalls, index 0 is outermost call. An outer call has index < defaultIndex.
    let outputOptional = false;
    if (hasDefault) {
      outputOptional = modifierCalls.some((m, idx) => idx < defaultIndex && (m.method === 'optional' || m.method === 'nullish'));
    } else {
      outputOptional = isOptional;
    }

    const ret = (wireType: WireType, extraBlockers: readonly AnalysisBlocker[] = []) => ({
      wireType,
      isOptional,
      isNullable,
      ...(hasDefault ? { hasDefault: true, defaultValue } : {}),
      outputOptional,
      blockers: [...blockers, ...extraBlockers],
    });


    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      let typeKind = '';
      if (ts.isPropertyAccessExpression(callee)) {
        typeKind = callee.name.text;
      } else if (ts.isIdentifier(callee)) {
        typeKind = callee.text;
      }

      if (typeKind) {
        if (typeKind === 'string') return ret(mkPrimitiveWireType('string'));
        if (typeKind === 'number') return ret(mkPrimitiveWireType('number'));
        if (typeKind === 'boolean') return ret(mkPrimitiveWireType('boolean'));
        if (typeKind === 'any' || typeKind === 'unknown') return ret(mkPrimitiveWireType('any'));
        if (['object', 'extend', 'merge', 'pick', 'omit'].includes(typeKind)) {
          const nested = this.tryParseZodSchema(current, filePath, new Set());
          if (nested) return ret(nested.wireType, nested.blockers);
        }
        
        if (typeKind === 'array') {
          const inner = current.arguments.length > 0
            ? this.parseZodField(current.arguments[0], filePath)
            : { wireType: mkPrimitiveWireType('any'), isOptional: false, isNullable: false, blockers: [] };
          return ret(mkArrayWireType(inner.wireType), inner.blockers);
        }
        
        if (typeKind === 'enum') {
          if (current.arguments.length > 0 && ts.isArrayLiteralExpression(current.arguments[0])) {
            const arr = current.arguments[0];
            const values: string[] = [];
            let allStrings = true;
            for (const elem of arr.elements) {
              if (ts.isStringLiteral(elem)) {
                values.push(elem.text);
              } else {
                allStrings = false;
                break;
              }
            }
            if (allStrings && arr.elements.length > 0) {
              const line = sf ? sf.getLineAndCharacterOfPosition(current.getStart(sf)).line + 1 : 1;
              const provenance: SourceProvenance = {
                language: 'TYPESCRIPT',
                file: filePath,
                line,
                annotationOrSchema: 'ZodSchema',
              };
              return ret(mkEnumWireType(values, undefined, provenance));
            }
          }
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: 'z.enum requires a static non-empty array literal of string literals',
            file: filePath,
          });
          return ret(mkUnknownWireType('Dynamic or non-string z.enum schema'));
        }

        if (typeKind === 'union') {
          if (current.arguments.length > 0 && ts.isArrayLiteralExpression(current.arguments[0])) {
            const arr = current.arguments[0];
            if (arr.elements.length === 0) {
              blockers.push({
                code: 'DYNAMIC_ZOD_SCHEMA',
                message: 'z.union requires at least 1 member schema',
                file: filePath,
              });
              return ret(mkUnknownWireType('Empty z.union schema'));
            }
            const memberWireTypes: WireType[] = [];
            const unionBlockers: AnalysisBlocker[] = [];
            for (const elem of arr.elements) {
              const memberRes = this.parseZodField(elem, filePath);
              unionBlockers.push(...memberRes.blockers);
              let memberType = memberRes.wireType;
              if (memberRes.isNullable && memberType.kind !== 'NULLABLE') {
                memberType = mkNullableWireType(memberType);
              }
              if (memberRes.isOptional && memberType.kind !== 'OPTIONAL') {
                memberType = mkOptionalWireType(memberType);
              }
              memberWireTypes.push(memberType);
            }
            const line = sf ? sf.getLineAndCharacterOfPosition(current.getStart(sf)).line + 1 : 1;
            const provenance: SourceProvenance = {
              language: 'TYPESCRIPT',
              file: filePath,
              line,
              annotationOrSchema: 'ZodSchema',
            };
            return ret(mkUnionWireType(memberWireTypes, provenance), unionBlockers);
          }
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: 'z.union requires an array literal of member schemas',
            file: filePath,
          });
          return ret(mkUnknownWireType('Dynamic or non-array z.union schema'));
        }

        if (typeKind === 'literal') {
          if (current.arguments.length > 0) {
            const arg = current.arguments[0];
            let val: string | number | boolean | undefined;
            if (ts.isStringLiteral(arg)) {
              val = arg.text;
            } else if (ts.isNumericLiteral(arg)) {
              val = Number(arg.text);
            } else if (arg.kind === ts.SyntaxKind.TrueKeyword) {
              val = true;
            } else if (arg.kind === ts.SyntaxKind.FalseKeyword) {
              val = false;
            } else if (ts.isPrefixUnaryExpression(arg) && ts.isNumericLiteral(arg.operand) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(arg.operator)) {
              val = Number(arg.operand.text) * (arg.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
            }
            if (val !== undefined) {
              const line = sf ? sf.getLineAndCharacterOfPosition(current.getStart(sf)).line + 1 : 1;
              const provenance: SourceProvenance = {
                language: 'TYPESCRIPT',
                file: filePath,
                line,
                annotationOrSchema: 'ZodSchema',
              };
              return ret(mkLiteralWireType(val, provenance));
            }
          }
          blockers.push({
            code: 'DYNAMIC_ZOD_SCHEMA',
            message: 'z.literal requires a static string, number, or boolean literal',
            file: filePath,
          });
          return ret(mkUnknownWireType('Dynamic or non-literal z.literal schema'));
        }

        if (typeKind === 'record' || typeKind === 'intersection') {
           blockers.push({
             code: 'UNSUPPORTED_ZOD_TYPE',
             message: `Zod type ${typeKind} is not fully supported yet and will be treated as UNKNOWN`,
             file: filePath,
           });
           return ret({ kind: 'UNKNOWN', reason: `Unsupported Zod field: ${typeKind}` });
        }
      }
    }

    return ret({ kind: 'UNKNOWN', reason: 'Unsupported Zod field' });
  }
}

