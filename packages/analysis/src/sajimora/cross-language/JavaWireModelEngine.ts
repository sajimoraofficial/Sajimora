import { parseSpringMapping } from './SpringMapping';
import {indexJavaDeclarations} from './JavaStructuralSource';
/**
 * JavaWireModelEngine.ts
 *
 * Generic Java Wire Model & Endpoint Contract extractor.
 * Converts Java classes, records, and Spring controllers into universal
 * CanonicalContractIR representations:
 *   - Universal WireType (Primitives, Objects, Arrays, Enums, Unions, Nullables)
 *   - Lombok synthesis for @Data, @Getter, @Value, @Builder, @Accessors
 *   - Jackson annotations: @JsonProperty, @JsonAlias, @JsonNaming, @JsonUnwrapped, @JsonValue, @JsonIgnore
 *   - Container unwrapping: ResponseEntity, Optional, List, Mono, Flux
 *   - Request parameter & body extraction: @RequestBody, @RequestParam, @PathVariable, @RequestHeader
 *   - Spring validation annotations: @NotNull, @NotBlank, @NotEmpty, @Size, @Min, @Max
 */

import { JavaClassDeclIR, JavaFieldIR, JavaMethodSignatureIR } from '../languages/java/ir/JavaTypeIR';
import { JavaSealedCompilerHost } from '../languages/java/programs/JavaSealedCompilerHost';
import {
  WireType,
  WirePropertyContract,
  EndpointContract,
  ParamContract,
  ValidationConstraint,
  SourceProvenance,
  mkPrimitiveWireType,
  mkObjectWireType,
  mkArrayWireType,
  mkNullableWireType,
  mkOptionalWireType,
  mkUnknownWireType,
  mkEnumWireType,
  mkLiteralWireType,
  mkUnionWireType
} from './CanonicalContractIR';
import { normalizeRouteSegments, combineSpringRoutes } from './EndpointIdentity';
import { synthesizeLombokMethods } from './LombokSynthesizer';
import { unwrapSpringContainer } from './SpringContainerUnwrapper';
import { AnalysisBlocker } from './CrossLanguageContracts';

export type JacksonNamingStrategy =
  | 'CAMEL_CASE'
  | 'SNAKE_CASE'
  | 'KEBAB_CASE'
  | 'UPPER_CAMEL_CASE'
  | 'LOWER_DOT_CASE';

export function applyNamingStrategy(name: string, strategy: JacksonNamingStrategy): string {
  switch (strategy) {
    case 'SNAKE_CASE':
      return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    case 'KEBAB_CASE':
      return name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    case 'UPPER_CAMEL_CASE':
      return name.charAt(0).toUpperCase() + name.slice(1);
    case 'LOWER_DOT_CASE':
      return name.replace(/([A-Z])/g, '.$1').toLowerCase().replace(/^\./, '');
    case 'CAMEL_CASE':
    default:
      return name;
  }
}

function decapitalize(name: string): string {
  if (!name) return name;
  if (name.length === 1) return name.toLowerCase();

  const isUpper = (c: string) => c >= 'A' && c <= 'Z';
  if (isUpper(name.charAt(0)) && isUpper(name.charAt(1))) {
    let i = 0;
    while (i < name.length && isUpper(name.charAt(i))) {
      i++;
    }
    if (i === name.length) {
      return name.toLowerCase();
    }
    return name.slice(0, i - 1).toLowerCase() + name.slice(i - 1);
  }

  return name.charAt(0).toLowerCase() + name.slice(1);
}

function getterToPropName(methodName: string): string | null {
  if (methodName.startsWith('get') && methodName.length > 3) {
    return decapitalize(methodName.slice(3));
  }
  if (methodName.startsWith('is') && methodName.length > 2) {
    return decapitalize(methodName.slice(2));
  }
  return null;
}

export function javaScalarToWireType(javaTypeDisplay: string, provenance?: SourceProvenance): WireType {
  const t = javaTypeDisplay.trim().toLowerCase();
  if (t === 'string' || t === 'char' || t === 'character' || t === 'uuid') {
    return mkPrimitiveWireType('string', provenance);
  }
  if (t === 'int' || t === 'integer' || t === 'long' || t === 'short' || t === 'byte' || t === 'float' || t === 'double' || t === 'bigdecimal' || t === 'bignumber') {
    return mkPrimitiveWireType('number', provenance);
  }
  if (t === 'boolean' || t === 'bool') {
    return mkPrimitiveWireType('boolean', provenance);
  }
  if (t === 'biginteger') {
    return mkPrimitiveWireType('bigint', provenance);
  }
  if (t === 'void') {
    return mkPrimitiveWireType('void', provenance);
  }
  return mkUnknownWireType(javaTypeDisplay, provenance);
}

export class JavaWireModelEngine {
  private genericBindings = new Map<string,WireType>();
  private readonly structures=new Map<string,ReturnType<typeof indexJavaDeclarations>>();
  private structure(file:string){
    if(!this.structures.has(file))this.structures.set(file,indexJavaDeclarations(this.host.getFileContent(file)??''));
    return this.structures.get(file)!;
  }
  constructor(
    private readonly host: JavaSealedCompilerHost,
    private readonly defaultNamingStrategy: JacksonNamingStrategy = 'CAMEL_CASE'
  ) {}

  /**
   * Extract universal WireType for a given DTO class.
   */
  public extractWireType(
    classFqcnOrSimple: string,
    enclosingFile?: string,
    visitedClasses = new Set<string>()
  ): {
    readonly wireType: WireType;
    readonly blockers: readonly AnalysisBlocker[];
  } {
    const blockers: AnalysisBlocker[] = [];
    const bound=this.genericBindings.get(`${enclosingFile}:${classFqcnOrSimple.trim()}`);
    if(bound)return {wireType:bound,blockers};
    const generic=/^([\w.$]+)<([\s\S]+)>$/.exec(classFqcnOrSimple.trim());
    if(generic) {
      const args:string[]=[];let depth=0,start=0;
      for(let i=0;i<generic[2].length;i++){
        if(generic[2][i]==='<')depth++;if(generic[2][i]==='>')depth--;
        if(generic[2][i]===','&&depth===0){args.push(generic[2].slice(start,i).trim());start=i+1;}
      }
      args.push(generic[2].slice(start).trim());
      const container=generic[1].replace(/^java\.util\./,'');
      if(['Map','HashMap','LinkedHashMap','TreeMap','SortedMap','ConcurrentMap'].includes(container)&&args.length===2){
        const key=javaScalarToWireType(args[0]);
        if(key.kind==='PRIMITIVE'&&key.scalar==='string'){
          const value=this.extractWireType(args[1],enclosingFile,visitedClasses);
          return {wireType:{kind:'MAP',keyType:key,valueType:value.wireType},blockers:value.blockers};
        }
      }
      const resolved=enclosingFile?this.host.resolveClass(generic[1],enclosingFile):undefined;
      const declaration=this.host.getClassByFQCN(generic[1])??(resolved?.status==='RESOLVED'?resolved.declaration??this.host.getClassByFQCN(resolved.fqcn):undefined);
      const header=declaration?this.host.getFileContent(declaration.filePath)??'':'';
      const parameters=declaration?new RegExp(`\\b(?:class|interface|record)\\s+${declaration.name}\\s*<([^>{}]+)>`).exec(header)?.[1].split(',').map(p=>p.trim().split(/\s+/)[0]):undefined;
      if(declaration&&parameters?.length===args.length&&args.every(arg=>!arg.includes('?'))) {
        const previous=this.genericBindings,next=new Map(previous);
        for(let i=0;i<args.length;i++){
          const result=this.extractWireType(args[i],enclosingFile,visitedClasses);
          blockers.push(...result.blockers);next.set(`${declaration.filePath}:${parameters[i]}`,result.wireType);
        }
        this.genericBindings=next;
        try {const result=this.extractWireType(declaration.fqcn,declaration.filePath,visitedClasses);return {wireType:result.wireType,blockers:[...blockers,...result.blockers]};}
        finally {this.genericBindings=previous;}
      }
    }
    let cls = this.host.getClassByFQCN(classFqcnOrSimple);
    if (!cls && enclosingFile) {
      const res = this.host.resolveClass(classFqcnOrSimple, enclosingFile);
      if (res.status === 'RESOLVED') {
        cls = res.declaration ?? this.host.getClassByFQCN(res.fqcn);
      }
    }

    if (!cls) {
      // Check if scalar
      const scalar = javaScalarToWireType(classFqcnOrSimple);
      if (scalar.kind !== 'UNKNOWN') {
        return { wireType: scalar, blockers };
      }
      return {
        wireType: mkUnknownWireType(`Unresolved Java class: ${classFqcnOrSimple}`),
        blockers: [{
          code: 'UNRESOLVED_JAVA_GENERIC',
          message: `Cannot resolve Java class or DTO: ${classFqcnOrSimple}`,
          file: enclosingFile,
        }]
      };
    }

    if (visitedClasses.has(cls.fqcn)) {
      // Recursive reference
      return {
        wireType: mkUnknownWireType(`Recursive Java DTO ${cls.fqcn}`, {
          language: 'JAVA',
          file: cls.filePath,
          line: cls.lineStart,
          astIdentity: cls.fqcn,
        }),
        blockers: [{ code: 'UNRESOLVED_JAVA_GENERIC', file: cls.filePath, message: `Recursive DTO ${cls.fqcn} needs a recursive contract profile` }],
      };
    }
    visitedClasses = new Set([...visitedClasses, cls.fqcn]);

    const sourceText = (this.host.getFileContent(cls.filePath) ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.replace(/[^\n]/g, ' '));
    const fileLines = sourceText.split('\n');
    const declarationOffset = sourceText.search(new RegExp(`\\b(?:class|record|enum|interface)\\s+${cls.name}\\b`));
    const beforeClass = sourceText.slice(0, Math.max(0, declarationOffset));
    const structuralClass=this.structure(cls.filePath).classes.find(candidate=>candidate.name===cls.name&&candidate.lineStart<=cls.lineStart&&candidate.lineEnd>=cls.lineStart);
    const classHeader = structuralClass?.modifiers??beforeClass.slice(Math.max(beforeClass.lastIndexOf('}'), beforeClass.lastIndexOf(';')) + 1);
    const hasAnnotation = (name: string) => cls.annotations.includes(name) || cls.fields.some(f => f.annotations.includes(name)) || cls.methods.some(m => m.annotations.includes(name));

    // Check for custom serializer blocker
    if (hasAnnotation('JsonSerialize')) {
      blockers.push({
        code: 'CUSTOM_JACKSON_SERIALIZER',
        message: `DTO ${cls.fqcn} uses custom @JsonSerialize — cannot statically guarantee wire behavior`,
        file: cls.filePath,
      });
    }

    // Check for custom deserializer blocker
    if (hasAnnotation('JsonDeserialize')) {
      blockers.push({
        code: 'CUSTOM_JACKSON_DESERIALIZER',
        message: `DTO ${cls.fqcn} uses custom @JsonDeserialize — cannot statically guarantee wire behavior`,
        file: cls.filePath,
      });
    }

    // Determine Jackson naming strategy
    let namingStrategy: JacksonNamingStrategy = this.defaultNamingStrategy;
    const jsonNamingMatch = classHeader.match(/@JsonNaming\s*\(\s*(?:[\w.]+\.)?PropertyNamingStrateg(?:ies|y)\.([A-Za-z0-9_]+)\.class\s*\)/);
    if (jsonNamingMatch) {
      const stratName = jsonNamingMatch[1].toUpperCase();
      if (stratName.includes('SNAKE')) namingStrategy = 'SNAKE_CASE';
      else if (stratName.includes('KEBAB')) namingStrategy = 'KEBAB_CASE';
      else if (stratName.includes('UPPER_CAMEL') || stratName.includes('UPPERCAMEL') || stratName.includes('PASCAL')) namingStrategy = 'UPPER_CAMEL_CASE';
      else if (stratName.includes('LOWER_DOT') || stratName.includes('LOWERDOT')) namingStrategy = 'LOWER_DOT_CASE';
      else if (!stratName.includes('LOWERCAMEL')) blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', file: cls.filePath, message: `Unsupported @JsonNaming strategy ${jsonNamingMatch[1]}` });
    }
    if (cls.annotations.includes('JsonNaming') && !jsonNamingMatch) blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', file: cls.filePath, message: 'Unresolved @JsonNaming declaration' });
    const directTypeInfo = this.extractJsonTypeInfo(cls);
    if (directTypeInfo) {
      if (directTypeInfo.use === 'DEDUCTION') {
        blockers.push({
          code: 'UNRESOLVED_JACKSON_DEDUCTION',
          message: 'Jackson deduction cannot be verified statically',
          file: cls.filePath,
        });
        return {
          wireType: mkUnknownWireType('Jackson deduction cannot be verified statically', {
            language: 'JAVA',
            file: cls.filePath,
            line: cls.lineStart,
            astIdentity: cls.fqcn,
          }),
          blockers,
        };
      }
      if (directTypeInfo.use !== 'NAME') {
        blockers.push({
          code: 'UNSUPPORTED_JACKSON_FEATURE',
          file: cls.filePath,
          message: `Unsupported @JsonTypeInfo use ${directTypeInfo.use}`,
        });
      }
      if (directTypeInfo.include && directTypeInfo.include !== 'PROPERTY' && directTypeInfo.include !== 'EXISTING_PROPERTY') {
        blockers.push({
          code: 'UNSUPPORTED_JACKSON_FEATURE',
          file: cls.filePath,
          message: `Unsupported @JsonTypeInfo include ${directTypeInfo.include}`,
        });
      }
      if ((cls.kind === 'interface' || cls.isAbstract) && directTypeInfo.subtypes.length > 0) {
        const subtypeTypes: WireType[] = [];
        for (const st of directTypeInfo.subtypes) {
          const subRes = this.extractWireType(st.className, cls.filePath, visitedClasses);
          blockers.push(...subRes.blockers);
          subtypeTypes.push(subRes.wireType);
        }
        return {
          wireType: mkUnionWireType(subtypeTypes, {
            language: 'JAVA',
            file: cls.filePath,
            line: cls.lineStart,
            astIdentity: cls.fqcn,
          }),
          blockers,
        };
      }
    }
    const qualifiedChainOnly=cls.annotations.includes('Accessors')&&/@Accessors\s*\(\s*chain\s*=\s*(?:true|false)\s*\)/.test(classHeader)&&!cls.fields.some(f=>f.annotations.includes('Accessors'))&&!cls.methods.some(m=>m.annotations.includes('Accessors'));
    if (hasAnnotation('Accessors')&&!qualifiedChainOnly || /@(?:Getter|Setter)\s*\(/.test(classHeader) || cls.fields.some(f => /@(?:Getter|Setter)\s*\(/.test(this.memberAnnotationText(fileLines,f.line)))) blockers.push({ code: 'UNSUPPORTED_LOMBOK_ACCESSOR', file: cls.filePath, message: 'Only default getter profiles and explicit chain-only class-level Lombok accessors are qualified' });
    const inclusion=(member:string):'ALWAYS'|'NON_NULL'|'NON_EMPTY'|'UNKNOWN'=>{
      const annotation=(/@JsonInclude\s*\([^)]*\)/.exec(member)??/@JsonInclude\s*\([^)]*\)/.exec(classHeader))?.[0];
      if(!annotation)return 'ALWAYS';
      const mode=/@JsonInclude\s*\(\s*(?:value\s*=\s*)?(?:[\w.]+\.)?(ALWAYS|NON_NULL|NON_EMPTY)\s*\)/.exec(annotation)?.[1];
      if(mode)return mode as 'ALWAYS'|'NON_NULL'|'NON_EMPTY';
      blockers.push({code:'UNSUPPORTED_JACKSON_FEATURE',file:cls.filePath,message:'Unqualified JsonInclude value/content inclusion'});return 'UNKNOWN';
    };
    const inclusionFacts=(member:string,_type:WireType,primitive:boolean,optional:boolean)=>{
      const mode=inclusion(member);
      return {nullable:!primitive&&(mode==='ALWAYS'||mode==='UNKNOWN'),optional:optional||!primitive&&(mode==='NON_NULL'||mode==='NON_EMPTY')};
    };

    // Synthesize Lombok methods
    const { synthesizedMethods } = synthesizeLombokMethods(cls, sourceText);

    // If enum
    if (cls.kind === 'enum') {
      const enumValues = cls.fields.filter(f => f.isEnumConstant === true).map(f => f.name);
      if(!enumValues.length)blockers.push({code:'UNSUPPORTED_JACKSON_FEATURE',file:cls.filePath,message:'Enum constants require structural declaration evidence'});
      if(hasAnnotation('JsonValue')||hasAnnotation('JsonFormat')||hasAnnotation('JsonProperty'))blockers.push({code:'UNSUPPORTED_JACKSON_FEATURE',file:cls.filePath,message:'Custom enum JSON values require encoder evidence'});
      return {
        wireType: mkEnumWireType(enumValues, cls.name, {
          language: 'JAVA',
          file: cls.filePath,
          line: cls.lineStart,
          astIdentity: cls.fqcn,
        }),
        blockers,
      };
    }

    // Check for @JsonValue on method or field
    for (const m of synthesizedMethods) {
      const line = fileLines[m.lineStart - 1] ?? '';
      if (line.includes('@JsonValue') || m.annotations.includes('JsonValue')) {
        const unwrapped = unwrapSpringContainer(m.returnType.display);
        const unwrappedResult = this.extractWireType(unwrapped.payloadTypeName, cls.filePath, visitedClasses);
        blockers.push(...unwrappedResult.blockers);
        return {
          wireType: unwrapped.isArray ? mkArrayWireType(unwrappedResult.wireType) : unwrappedResult.wireType,
          blockers,
        };
      }
    }

    // Check for @JsonCreator constructor or static method
    const creatorMethod = cls.methods.find(m =>
      (m.isConstructor || m.isStatic) &&
      (m.annotations.includes('JsonCreator') || this.memberAnnotationText(fileLines, m.lineStart).includes('@JsonCreator'))
    );

    const creatorAnnotationText = creatorMethod ? this.memberAnnotationText(fileLines, creatorMethod.lineStart) : '';
    const creatorParen = creatorMethod ? this.extractAnnotationParenBody(creatorAnnotationText, 'JsonCreator') : null;
    let explicitCreatorMode: 'DELEGATING' | 'PROPERTIES' | undefined = undefined;
    if (creatorParen) {
      const modeMatch = creatorParen.match(/(?:mode\s*=\s*)?(?:[\w.]+\.)?(DELEGATING|PROPERTIES)/i);
      if (modeMatch) explicitCreatorMode = modeMatch[1].toUpperCase() as 'DELEGATING' | 'PROPERTIES';
    }

    const structCls = this.structure(cls.filePath).classes.find(c => c.name === cls.name && c.lineStart <= cls.lineStart && c.lineEnd >= cls.lineStart);
    const structMethod = creatorMethod ? structCls?.methods.find(candidate => candidate.name === creatorMethod.name && candidate.lineStart <= creatorMethod.lineStart && candidate.lineEnd >= creatorMethod.lineStart) : undefined;
    const creatorRawText = creatorMethod ? fileLines.slice(creatorMethod.lineStart - 1, creatorMethod.lineEnd).join('\n') : '';

    const getParamPropInfo = (pName: string, pAnnotations: readonly string[]): { hasJsonProperty: boolean; jsonPropertyName?: string } => {
      const paramSource = structMethod?.parameters.find(candidate => candidate.name === pName)?.text ?? '';
      const hasAnnotation = pAnnotations.includes('JsonProperty') || paramSource.includes('@JsonProperty') || creatorRawText.includes('@JsonProperty');
      const paramRegex = new RegExp(`@(?:[\\w.]+\\.)?JsonProperty(?:\\s*\\(([^)]*)\\))?\\s*(?:final\\s+)?[A-Za-z0-9_<>\\[\\],\\s]+\\s+${pName}\\b`);
      const regexMatch = paramRegex.exec(creatorRawText);
      const body = (regexMatch ? regexMatch[1] : undefined) ?? this.extractAnnotationParenBody(paramSource, 'JsonProperty') ?? this.extractAnnotationParenBody(creatorRawText, 'JsonProperty');
      if (regexMatch || hasAnnotation) {
        if (body !== undefined && body !== null) {
          const valMatch = body.match(/(?:value\s*=\s*)?"([^"]*)"/);
          return { hasJsonProperty: true, jsonPropertyName: valMatch ? valMatch[1] : undefined };
        }
        return { hasJsonProperty: true, jsonPropertyName: undefined };
      }
      return { hasJsonProperty: false };
    };

    if (creatorMethod) {
      const isDelegating = explicitCreatorMode === 'DELEGATING' ||
        (explicitCreatorMode === undefined && creatorMethod.parameters.length === 1 && !getParamPropInfo(creatorMethod.parameters[0].name, creatorMethod.parameters[0].annotations).hasJsonProperty);

      if (isDelegating) {
        if (creatorMethod.parameters.length === 1) {
          const p = creatorMethod.parameters[0];
          const unwrappedInfo = unwrapSpringContainer(p.type.display);
          const typeRes = this.extractWireType(unwrappedInfo.payloadTypeName, cls.filePath, visitedClasses);
          blockers.push(...typeRes.blockers);
          let wireType = typeRes.wireType;
          if (unwrappedInfo.isArray) {
            wireType = mkArrayWireType(wireType, unwrappedInfo.isStreamOrFlux);
          }
          return { wireType, blockers };
        } else {
          blockers.push({
            code: 'UNSUPPORTED_JACKSON_FEATURE',
            file: cls.filePath,
            message: 'Delegating creator mode requires exactly one parameter',
          });
        }
      }
    }

    // Collect properties
    const properties: WirePropertyContract[] = [];
    const seenWireNames = new Set<string>();
    const creatorParamWireNames = new Map<string, string>();

    if (creatorMethod) {
      let hasMissingParamNames = false;
      for (const p of creatorMethod.parameters) {
        const info = getParamPropInfo(p.name, p.annotations);
        if (!info.hasJsonProperty || !info.jsonPropertyName) {
          hasMissingParamNames = true;
        }
      }
      if (hasMissingParamNames) {
        blockers.push({
          code: 'UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES',
          message: 'Creator parameter names require @JsonProperty or compiled -parameters metadata',
          file: cls.filePath,
        });
      }

      for (const p of creatorMethod.parameters) {
        const info = getParamPropInfo(p.name, p.annotations);
        const wireName = info.jsonPropertyName ?? applyNamingStrategy(p.name, namingStrategy);
        creatorParamWireNames.set(p.name, wireName);
        seenWireNames.add(wireName);

        const unwrappedInfo = unwrapSpringContainer(p.type.display);
        const typeRes = this.extractWireType(unwrappedInfo.payloadTypeName, cls.filePath, visitedClasses);
        blockers.push(...typeRes.blockers);
        let propType = typeRes.wireType;
        if (unwrappedInfo.isArray) {
          propType = mkArrayWireType(propType, unwrappedInfo.isStreamOrFlux);
        }
        const isPrimitive = ['int', 'long', 'boolean', 'double', 'float', 'byte', 'short', 'char'].includes(p.type.display.trim());
        const paramSource = structMethod?.parameters.find(candidate => candidate.name === p.name)?.text ?? '';
        const facts = inclusionFacts(paramSource || creatorRawText, propType, isPrimitive, unwrappedInfo.isOptional);

        properties.push({
          wireName,
          type: propType,
          ...facts,
          validationConstraints: [],
          provenance: {
            language: 'JAVA',
            file: cls.filePath,
            line: creatorMethod.lineStart,
            astIdentity: `${cls.fqcn}#<init>.${p.name}`,
          }
        });
      }
    }

    if (cls.extendsName && cls.extendsName !== 'Object') {
      const superRes = this.extractWireType(cls.extendsName, cls.filePath, visitedClasses);
      blockers.push(...superRes.blockers);
      if (superRes.wireType.kind === 'OBJECT') {
        for (const prop of superRes.wireType.properties) {
          if (!seenWireNames.has(prop.wireName)) {
            seenWireNames.add(prop.wireName);
            properties.push(prop);
          }
        }
      }
    }

    // 1. Process getters
    for (const m of synthesizedMethods) {
      if (m.isStatic || m.parameters.length > 0 || m.name === 'getClass' || m.visibility !== 'public' && !m.annotations.includes('JsonProperty')) continue;
      const getterProp = getterToPropName(m.name);
      if (!getterProp) continue;

      const mLine = this.memberAnnotationText(fileLines, m.lineStart);
      if (mLine.includes('@JsonIgnore') || m.annotations.includes('JsonIgnore')) continue;

      let wireName = creatorParamWireNames.get(getterProp) ?? applyNamingStrategy(getterProp, namingStrategy);
      const jsonPropMatch = mLine.match(/@JsonProperty\s*\(\s*(?:value\s*=\s*)?"([^"]+)"\s*\)/);
      if (jsonPropMatch) {
        wireName = jsonPropMatch[1];
      }

      if (seenWireNames.has(wireName)) {
        if (creatorParamWireNames.has(getterProp)) continue;
        properties.splice(properties.findIndex(p => p.wireName === wireName), 1);
      }
      seenWireNames.add(wireName);

      // Check for @JsonUnwrapped
      const isUnwrapped = mLine.includes('@JsonUnwrapped') || m.annotations.includes('JsonUnwrapped');
      const unwrappedInfo = unwrapSpringContainer(m.returnType.display);
      const typeRes = this.extractWireType(unwrappedInfo.payloadTypeName, cls.filePath, visitedClasses);
      blockers.push(...typeRes.blockers);

      let propType = typeRes.wireType;
      if (unwrappedInfo.isArray) {
        propType = mkArrayWireType(propType, unwrappedInfo.isStreamOrFlux);
      }

      if (isUnwrapped && propType.kind === 'OBJECT') {
        // Inline properties
        for (const innerProp of propType.properties) {
          if (!seenWireNames.has(innerProp.wireName)) {
            seenWireNames.add(innerProp.wireName);
            properties.push(innerProp);
          }
        }
        continue;
      }

      const isPrimitive = ['int', 'long', 'boolean', 'double', 'float', 'byte', 'short', 'char'].includes(m.returnType.display.trim());
      const facts=inclusionFacts(mLine,propType,isPrimitive,unwrappedInfo.isOptional);

      properties.push({
        wireName,
        type: propType,
        ...facts,
        validationConstraints: [],
        provenance: {
          language: 'JAVA',
          file: cls.filePath,
          line: m.lineStart,
          astIdentity: `${cls.fqcn}#${m.name}`,
        }
      });
    }

    // 2. Process public fields or record components
    for (const field of cls.fields) {
      if (field.isStatic) continue;
      const isRecord = cls.kind === 'record';
      if (!isRecord && field.visibility !== 'public') continue;

      const fLine = this.memberAnnotationText(fileLines, field.line);
      if (fLine.includes('@JsonIgnore') || field.annotations.includes('JsonIgnore')) continue;

      let wireName = creatorParamWireNames.get(field.name) ?? applyNamingStrategy(field.name, namingStrategy);
      const jsonPropMatch = fLine.match(/@JsonProperty\s*\(\s*(?:value\s*=\s*)?"([^"]+)"\s*\)/);
      if (jsonPropMatch) {
        wireName = jsonPropMatch[1];
      }

      if (seenWireNames.has(wireName)) {
        if (creatorParamWireNames.has(field.name)) continue;
        const previous = properties.findIndex(p => p.wireName === wireName);
        if (properties[previous]?.provenance?.astIdentity?.startsWith(cls.fqcn)) continue;
        properties.splice(previous, 1);
      }
      seenWireNames.add(wireName);

      const unwrappedInfo = unwrapSpringContainer(field.type.display);
      const typeRes = this.extractWireType(unwrappedInfo.payloadTypeName, cls.filePath, visitedClasses);
      blockers.push(...typeRes.blockers);

      let propType = typeRes.wireType;
      if (unwrappedInfo.isArray) {
        propType = mkArrayWireType(propType, unwrappedInfo.isStreamOrFlux);
      }

      const isPrimitive = ['int', 'long', 'boolean', 'double', 'float', 'byte', 'short', 'char'].includes(field.type.display.trim());
      const facts=inclusionFacts(fLine,propType,isPrimitive,unwrappedInfo.isOptional);

      properties.push({
        wireName,
        type: propType,
        ...facts,
        validationConstraints: [],
        provenance: {
          language: 'JAVA',
          file: cls.filePath,
          line: field.line,
          astIdentity: `${cls.fqcn}.${field.name}`,
        }
      });
    }

    // Discriminator property injection for Jackson polymorphism
    const poly = this.findPolymorphicDiscriminator(cls);
    if (poly) {
      blockers.push(...poly.blockers);
      if (poly.subtypeName) {
        const discriminatorProp: WirePropertyContract = {
          wireName: poly.propertyName,
          type: mkLiteralWireType(poly.subtypeName),
          optional: false,
          nullable: false,
          validationConstraints: [],
          provenance: {
            language: 'JAVA',
            file: cls.filePath,
            line: cls.lineStart,
            astIdentity: `${cls.fqcn}.${poly.propertyName}`,
          }
        };
        const existingIdx = properties.findIndex(p => p.wireName === poly.propertyName);
        if (existingIdx >= 0) {
          properties[existingIdx] = discriminatorProp;
        } else {
          properties.unshift(discriminatorProp);
        }
        seenWireNames.add(poly.propertyName);
      }
    }

    return {
      wireType: mkObjectWireType(properties, cls.name, false, {
        language: 'JAVA',
        file: cls.filePath,
        line: cls.lineStart,
        astIdentity: cls.fqcn,
      }),
      blockers,
    };
  }

  private extractAnnotationParenBody(text: string, annotationName: string): string | null {
    const match = new RegExp(`@(?:[\\w.]+\\.)?${annotationName}\\b`).exec(text);
    if (!match) return null;
    const idx = match.index;
    const parenStart = text.indexOf('(', idx);
    if (parenStart === -1) return null;
    let depth = 0;
    for (let i = parenStart; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) {
          return text.slice(parenStart + 1, i);
        }
      }
    }
    return null;
  }

  private extractJsonTypeInfo(cls: JavaClassDeclIR): {
    use: string;
    include?: string;
    property: string;
    subtypes: { className: string; name: string }[];
  } | null {
    const sourceText = (this.host.getFileContent(cls.filePath) ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.replace(/[^\n]/g, ' '));
    const declarationOffset = sourceText.search(new RegExp(`\\b(?:class|record|enum|interface)\\s+${cls.name}\\b`));
    const beforeClass = sourceText.slice(0, Math.max(0, declarationOffset));
    const structuralClass = this.structure(cls.filePath).classes.find(candidate => candidate.name === cls.name && candidate.lineStart <= cls.lineStart && candidate.lineEnd >= cls.lineStart);
    const classHeader = (structuralClass?.modifiers ? structuralClass.modifiers + '\n' : '') + beforeClass.slice(Math.max(beforeClass.lastIndexOf('}'), beforeClass.lastIndexOf(';')) + 1);

    if (!classHeader.includes('JsonTypeInfo') && !cls.annotations.includes('JsonTypeInfo')) {
      return null;
    }

    const typeInfoBody = this.extractAnnotationParenBody(classHeader, 'JsonTypeInfo');
    let use = 'NAME';
    let include: string | undefined = undefined;
    let property = '@type';

    if (typeInfoBody) {
      const useMatch = typeInfoBody.match(/\buse\s*=\s*(?:(?:JsonTypeInfo\.)?Id\.)?([A-Za-z0-9_]+)/);
      if (useMatch) use = useMatch[1].toUpperCase();

      const includeMatch = typeInfoBody.match(/\binclude\s*=\s*(?:(?:JsonTypeInfo\.)?As\.)?([A-Za-z0-9_]+)/);
      if (includeMatch) include = includeMatch[1].toUpperCase();

      const propMatch = typeInfoBody.match(/\bproperty\s*=\s*"([^"]+)"/);
      if (propMatch) property = propMatch[1];
    }

    const subtypes: { className: string; name: string }[] = [];
    const subTypesBody = this.extractAnnotationParenBody(classHeader, 'JsonSubTypes');
    if (subTypesBody) {
      const typeRegex = /@(?:JsonSubTypes\.)?Type\s*\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = typeRegex.exec(subTypesBody)) !== null) {
        const args = m[1];
        const valueMatch = args.match(/(?:value\s*=\s*)?([A-Za-z0-9_$.]+)\.class/);
        const nameMatch = args.match(/(?:name\s*=\s*)"([^"]+)"/);
        const namesMatch = args.match(/(?:names\s*=\s*)\{([^}]+)\}/);
        const className = valueMatch ? valueMatch[1].split('.').pop()! : '';
        if (className) {
          if (nameMatch) {
            subtypes.push({ className, name: nameMatch[1] });
          } else if (namesMatch) {
            const names = namesMatch[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean);
            for (const n of names) {
              subtypes.push({ className, name: n });
            }
          } else {
            subtypes.push({ className, name: className });
          }
        }
      }
    }

    return { use, include, property, subtypes };
  }

  private findPolymorphicDiscriminator(cls: JavaClassDeclIR): {
    propertyName: string;
    subtypeName: string;
    blockers: AnalysisBlocker[];
  } | undefined {
    // 1. Check direct annotations on cls
    const directInfo = this.extractJsonTypeInfo(cls);
    if (directInfo) {
      if (directInfo.use === 'DEDUCTION') {
        return {
          propertyName: directInfo.property,
          subtypeName: '',
          blockers: [{
            code: 'UNRESOLVED_JACKSON_DEDUCTION',
            message: 'Jackson deduction cannot be verified statically',
            file: cls.filePath,
          }]
        };
      }
      const match = directInfo.subtypes.find(st =>
        st.className === cls.name || st.className === cls.simpleName || st.className === cls.fqcn
      );
      if (match) {
        return {
          propertyName: directInfo.property,
          subtypeName: match.name,
          blockers: [],
        };
      }
    }

    // 2. Check parents (extends and implements)
    const candidates: string[] = [];
    if (cls.extendsName && cls.extendsName !== 'Object') {
      candidates.push(cls.extendsName);
    }
    candidates.push(...cls.implementsNames);

    for (const parentName of candidates) {
      let parentCls = this.host.getClassByFQCN(parentName);
      if (!parentCls) {
        const res = this.host.resolveClass(parentName, cls.filePath);
        if (res.status === 'RESOLVED') {
          parentCls = res.declaration ?? this.host.getClassByFQCN(res.fqcn);
        }
      }
      if (parentCls) {
        const info = this.extractJsonTypeInfo(parentCls);
        if (info) {
          if (info.use === 'DEDUCTION') {
            return {
              propertyName: info.property,
              subtypeName: '',
              blockers: [{
                code: 'UNRESOLVED_JACKSON_DEDUCTION',
                message: 'Jackson deduction cannot be verified statically',
                file: cls.filePath,
              }]
            };
          }
          const matchingSub = info.subtypes.find(st =>
            st.className === cls.name ||
            st.className === cls.simpleName ||
            st.className === cls.fqcn
          );
          if (matchingSub) {
            return {
              propertyName: info.property,
              subtypeName: matchingSub.name,
              blockers: [],
            };
          }
        }
        const recursive = this.findPolymorphicDiscriminator(parentCls);
        if (recursive) return recursive;
      }
    }

    // 3. Check all other classes in the compilation host for @JsonSubTypes registering cls
    for (const otherCls of this.host.getAllClasses()) {
      if (otherCls.fqcn === cls.fqcn) continue;
      const info = this.extractJsonTypeInfo(otherCls);
      if (info) {
        const matchingSub = info.subtypes.find(st =>
          st.className === cls.name ||
          st.className === cls.simpleName ||
          st.className === cls.fqcn
        );
        if (matchingSub) {
          if (info.use === 'DEDUCTION') {
            return {
              propertyName: info.property,
              subtypeName: '',
              blockers: [{
                code: 'UNRESOLVED_JACKSON_DEDUCTION',
                message: 'Jackson deduction cannot be verified statically',
                file: cls.filePath,
              }]
            };
          }
          return {
            propertyName: info.property,
            subtypeName: matchingSub.name,
            blockers: [],
          };
        }
      }
    }

    return undefined;
  }

  private memberAnnotationText(lines: string[], line: number): string {
    let text = lines[line - 1] ?? '';
    for (let index = line - 2; index >= 0; index--) {
      const previous = lines[index].trim();
      if (!previous) continue;
      if (!previous.startsWith('@') && !previous.endsWith(')') && !previous.endsWith(',')) break;
      text = previous + ' ' + text;
    }
    return text;
  }

  /**
   * Extract all EndpointContracts from a Spring controller.
   */
  public extractControllerEndpoints(controllerCls: JavaClassDeclIR): {
    readonly endpoints: readonly EndpointContract[];
    readonly blockers: readonly AnalysisBlocker[];
  } {
    const endpoints: EndpointContract[] = [];
    const blockers: AnalysisBlocker[] = [];

    const sourceText = (this.host.getFileContent(controllerCls.filePath) ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.replace(/[^\n]/g, ' '));
    const fileLines = sourceText.split('\n');

    const classOffset = sourceText.search(new RegExp('\\b(?:class|interface)\\s+' + controllerCls.name + '\\b'));
    const classHeader = sourceText.slice(0, Math.max(0, classOffset));
    const structure=this.structure(controllerCls.filePath);
    const declaration=structure.classes.find(cls=>cls.name===controllerCls.name&&cls.lineStart<=controllerCls.lineStart&&cls.lineEnd>=controllerCls.lineStart);
    if(!structure.complete||!declaration)blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:'Controller structural declaration is unqualified'});
    const classMapping = declaration ? parseSpringMapping(declaration.modifiers) : controllerCls.annotations.includes('RequestMapping')
      ? parseSpringMapping(classHeader.slice(classHeader.lastIndexOf('@RequestMapping'))) : undefined;
    if (classMapping?.unresolved) blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:'Class mapping contains unqualified expressions or conditions'});

    for (const method of controllerCls.methods) {
      let combinedMethodText = fileLines[method.lineStart - 1] ?? '';
      for (let l = method.lineStart - 2; l >= 0 && l >= method.lineStart - 15; l--) {
        const line = (fileLines[l] ?? '').trim();
        if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
          continue;
        }
        if (line.startsWith('@') || line.endsWith(')') || line.endsWith(',')) {
          combinedMethodText = line + ' ' + combinedMethodText;
        } else {
          break;
        }
      }

      const methodSource=declaration?.methods.find(candidate=>candidate.name===method.name&&candidate.lineStart<=method.lineStart&&candidate.lineEnd>=method.lineStart);
      const mapping = parseSpringMapping(methodSource?.modifiers??combinedMethodText);
      if (!mapping) {
        if(controllerCls.implementsNames.length&&method.annotations.includes('Override')&&!blockers.some(b=>b.message.startsWith('Inherited Spring mappings')))
          blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:`Inherited Spring mappings require captured interface declarations and annotation-inheritance qualification: ${controllerCls.implementsNames.join(', ')}`});
        if (method.annotations.some(name=>['RequestMapping','GetMapping','PostMapping','PutMapping','PatchMapping','DeleteMapping'].includes(name))) blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:'Mapped method annotation source could not be resolved'});
        continue;
      }
      if (mapping.unresolved) blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:'Method mapping contains unqualified expressions or conditions'});
      const routes = (classMapping?.paths ?? ['']).flatMap(prefix=>mapping.paths.map(route=>combineSpringRoutes(prefix,route)));
      const methods = mapping.methods.filter(verb=>!classMapping || classMapping.methods.includes(verb));
      if (!routes.length || !methods.length) continue;
      const httpMethod = methods[0];
      const normalizedRoute = normalizeRouteSegments(routes[0]);
      const endpointStart = endpoints.length;

      // Extract Response Body
      const unwrappedReturn = unwrapSpringContainer(method.returnType.display);
      let responseWireType: WireType | null = null;

      if (unwrappedReturn.isOpaqueContainer) {
        blockers.push({
          code: 'UNRESOLVED_JAVA_GENERIC',
          file: controllerCls.filePath,
          message: `Unparameterized or wildcard response entity '${method.returnType.display}' requires explicit DTO typing`,
        });
        responseWireType = { kind: 'UNKNOWN', reason: 'Unparameterized response entity' };
      } else if (unwrappedReturn.payloadTypeName !== 'void' && unwrappedReturn.payloadTypeName !== 'Void') {
        const res = this.extractWireType(unwrappedReturn.payloadTypeName, controllerCls.filePath);
        blockers.push(...res.blockers);
        responseWireType = unwrappedReturn.isArray
          ? mkArrayWireType(res.wireType, unwrappedReturn.isStreamOrFlux)
          : res.wireType;
      }

      // Extract Request Body & Parameters
      let requestBodyType: WireType | null = null;
      const pathParams: ParamContract[] = [];
      const queryParams: ParamContract[] = [];
      const headers: ParamContract[] = [];

      for (const param of method.parameters) {
        const parameterSource=methodSource?.parameters.find(candidate=>candidate.name===param.name)?.text??'';
        const parameterFacts=(annotation:string)=>{
          const argumentsText=new RegExp(`@(?:[\\w.]+\\.)?${annotation}\\s*\\(([^)]*)\\)`).exec(parameterSource)?.[1]??'';
          const alias=/(?:^\s*|\b(?:name|value)\s*=\s*)"([^"\\]*)"/.exec(argumentsText)?.[1];
          const required=/\brequired\s*=\s*([^,\s]+)/.exec(argumentsText)?.[1];
          const defaultValue=/\bdefaultValue\s*=\s*([^,]+)/.exec(argumentsText)?.[1]?.trim();
          if(required&&required!=='true'&&required!=='false'||defaultValue&&!/^"[^"\\]*"$/.test(defaultValue)) blockers.push({code:'UNRESOLVED_ROUTE',file:controllerCls.filePath,message:`Unqualified ${annotation} required/defaultValue expression for ${param.name}`});
          return {name:alias??param.name,required:required!=='false'&&!defaultValue};
        };
        const isRequestBody = param.annotations.includes('RequestBody');
        const isPathVariable = param.annotations.includes('PathVariable');
        const isRequestParam = param.annotations.includes('RequestParam');
        const isRequestHeader = param.annotations.includes('RequestHeader');

        const constraints: ValidationConstraint[] = [];
        if (param.annotations.includes('NotNull')) constraints.push({ kind: 'NOT_NULL' });
        if (param.annotations.includes('NotBlank')) constraints.push({ kind: 'NOT_BLANK' });
        if (param.annotations.includes('NotEmpty')) constraints.push({ kind: 'NOT_EMPTY' });

        if (isRequestBody) {
          parameterFacts('RequestBody');
          const unwrappedBody = unwrapSpringContainer(param.type.display);
          const bodyRes = this.extractWireType(unwrappedBody.payloadTypeName, controllerCls.filePath);
          blockers.push(...bodyRes.blockers);
          requestBodyType = unwrappedBody.isArray
            ? mkArrayWireType(bodyRes.wireType, unwrappedBody.isStreamOrFlux)
            : bodyRes.wireType;
          const validationActive = param.annotations.includes('Valid') || param.annotations.includes('Validated');
          const acceptedRequest = (type: WireType): WireType => {
            if (type.kind === 'ARRAY') return { ...type, elementType: acceptedRequest(type.elementType) };
            if (type.kind !== 'OBJECT') return type;
            return { ...type, properties: type.properties.map(property => {
              const ownerFile = property.provenance?.file ?? controllerCls.filePath;
              const owner = this.host.getFileClasses(ownerFile).find(c => c.name === type.name);
              const member = owner?.fields.find(f => property.provenance?.astIdentity?.endsWith(`.${f.name}`)) ?? owner?.methods.find(m => property.provenance?.astIdentity?.endsWith(`#${m.name}`));
              const names = member?.annotations ?? [];
              const validationConstraints: ValidationConstraint[] = validationActive ? names.flatMap(name => {
                const kinds: Record<string, ValidationConstraint['kind']> = { NotNull: 'NOT_NULL', NotBlank: 'NOT_BLANK', NotEmpty: 'NOT_EMPTY', Size: 'SIZE', Min: 'MIN', Max: 'MAX', Pattern: 'PATTERN', Email: 'EMAIL' };
                return kinds[name] ? [{ kind: kinds[name] }] : [];
              }) : [];
              const required = validationConstraints.some(c => ['NOT_NULL', 'NOT_BLANK', 'NOT_EMPTY'].includes(c.kind));
              return { ...property, type: acceptedRequest(property.type), optional: !required, nullable: !required, validationConstraints };
            }) };
          };
          requestBodyType = acceptedRequest(requestBodyType);
          if(parameterSource&&/@(?:[\w.]+\.)?RequestBody\s*\([^)]*\brequired\s*=\s*false\b/.test(parameterSource)) requestBodyType=mkOptionalWireType(mkNullableWireType(requestBodyType));
        } else if (isPathVariable) {
          pathParams.push({
            ...parameterFacts('PathVariable'),
            type: javaScalarToWireType(param.type.display),
            validationConstraints: constraints,
          });
        } else if (isRequestParam) {
          queryParams.push({
            ...parameterFacts('RequestParam'),
            type: javaScalarToWireType(param.type.display),
            validationConstraints: constraints,
          });
        } else if (isRequestHeader) {
          headers.push({
            ...parameterFacts('RequestHeader'),
            type: javaScalarToWireType(param.type.display),
            validationConstraints: constraints,
          });
        }
      }

      // Response Contract
      endpoints.push({
        identity: {
          service: null,
          httpMethod,
          normalizedRoute,
          direction: 'RESPONSE',
        },
        pathParameters: pathParams,
        queryParameters: queryParams,
        headers,
        body: responseWireType,
        provenance: {
          language: 'JAVA',
          file: controllerCls.filePath,
          line: method.lineStart,
          astIdentity: `${controllerCls.fqcn}#${method.name}`,
        }
      });

      // Request Contract (if request body or parameters present)
      if (requestBodyType || pathParams.length > 0 || queryParams.length > 0) {
        endpoints.push({
          identity: {
            service: null,
            httpMethod,
            normalizedRoute,
            direction: 'REQUEST',
          },
          pathParameters: pathParams,
          queryParameters: queryParams,
          headers,
          body: requestBodyType,
          provenance: {
            language: 'JAVA',
            file: controllerCls.filePath,
            line: method.lineStart,
            astIdentity: `${controllerCls.fqcn}#${method.name}`,
          }
        });
      }
      const templates = endpoints.splice(endpointStart);
      for (const verb of methods) for (const route of routes) for (const template of templates) endpoints.push({...template,mappingConditions:{params:[...(classMapping?.params??[]),...(mapping.params??[])],complete:!mapping.unresolved&&!classMapping?.unresolved},identity:{...template.identity,httpMethod:verb,normalizedRoute:normalizeRouteSegments(route)}});
    }

    return { endpoints, blockers };
  }
}
