/**
 * LombokSynthesizer.ts
 *
 * Synthesizes virtual JavaBean getters, setters, and properties for classes
 * annotated with Project Lombok annotations:
 *   - @Data
 *   - @Getter
 *   - @Setter
 *   - @Value
 *   - @Builder
 *   - @NoArgsConstructor
 *   - @AllArgsConstructor
 *   - @FieldDefaults
 *   - @Accessors (fluent = true/false, chain = true/false)
 *
 * This allows static Java wire model extraction to accurately model Lombok-generated
 * Jackson wire properties without requiring runtime annotation processing or an active compiler.
 */

import { JavaClassDeclIR, JavaMethodSignatureIR, JavaFieldIR } from '../languages/java/ir/JavaTypeIR';

export interface LombokAccessorConfig {
  readonly fluent: boolean;
  readonly chain: boolean;
  readonly prefix: readonly string[];
}

export function parseLombokAccessors(cls: JavaClassDeclIR, classSource?: string): LombokAccessorConfig {
  let fluent = false;
  let chain = false;
  const prefix: string[] = [];

  if (classSource) {
    const match = classSource.match(/@Accessors\s*\(([^)]+)\)/);
    if (match) {
      const body = match[1];
      if (/fluent\s*=\s*true/i.test(body)) fluent = true;
      if (/chain\s*=\s*true/i.test(body)) chain = true;
      const prefixMatch = body.match(/prefix\s*=\s*\{?([^}]+)\}?/);
      if (prefixMatch) {
        const rawPrefixes = prefixMatch[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean);
        prefix.push(...rawPrefixes);
      }
    }
  }

  return { fluent, chain, prefix };
}

export function synthesizeLombokMethods(
  cls: JavaClassDeclIR,
  classSource?: string
): {
  readonly synthesizedMethods: readonly JavaMethodSignatureIR[];
  readonly effectiveFields: readonly JavaFieldIR[];
} {
  const annotations = new Set(cls.annotations);
  const isLombok =
    annotations.has('Data') ||
    annotations.has('Getter') ||
    annotations.has('Setter') ||
    annotations.has('Value') ||
    annotations.has('Builder') ||
    annotations.has('AllArgsConstructor') ||
    annotations.has('NoArgsConstructor') ||
    annotations.has('FieldDefaults') || cls.fields.some(field=>field.annotations.includes('Getter')||field.annotations.includes('Setter'));

  if (!isLombok) {
    return {
      synthesizedMethods: cls.methods,
      effectiveFields: cls.fields,
    };
  }

  const accessors = parseLombokAccessors(cls, classSource);
  const isValue = annotations.has('Value');
  const hasGetter = isValue || annotations.has('Data') || annotations.has('Getter');
  const hasSetter = !isValue && (annotations.has('Data') || annotations.has('Setter'));

  const existingMethodNames = new Set(cls.methods.map(m => m.name));
  const newMethods: JavaMethodSignatureIR[] = [...cls.methods];

  for (const field of cls.fields) {
    if (field.isStatic) continue;

    let propName = field.name;
    for (const p of accessors.prefix) {
      if (propName.startsWith(p)) {
        propName = propName.slice(p.length);
        if (propName.length > 0) {
          propName = propName.charAt(0).toLowerCase() + propName.slice(1);
        }
        break;
      }
    }

    // Synthesize Getter
    if (hasGetter || field.annotations.includes('Getter')) {
      let getterName: string;
      if (accessors.fluent) {
        getterName = propName;
      } else {
        const isBool = field.type.display.trim() === 'boolean';
        getterName = isBool&&/^is[A-Z]/.test(propName)?propName:(isBool ? 'is' : 'get') + propName.charAt(0).toUpperCase() + propName.slice(1);
      }

      if (!existingMethodNames.has(getterName)) {
        existingMethodNames.add(getterName);
        newMethods.push({
          name: getterName,
          returnType: field.type,
          parameters: [],
          typeParameters: [],
          visibility: 'public',
          isStatic: false,
          isAbstract: false,
          isFinal: false,
          isConstructor: false,
          isDeclaredOverride: false,
          annotations: [],
          declarationOrdinal: newMethods.length,
          irContentHash: `lombok-synthesized-getter:${getterName}`,
          lineStart: field.line,
          lineEnd: field.line,
        });
      }
    }

    // Synthesize Setter
    if (hasSetter || field.annotations.includes('Setter')) {
      let setterName: string;
      if (accessors.fluent) {
        setterName = propName;
      } else {
        setterName = 'set' + propName.charAt(0).toUpperCase() + propName.slice(1);
      }

      if (!existingMethodNames.has(setterName)) {
        existingMethodNames.add(setterName);
        newMethods.push({
          name: setterName,
          returnType: {
            schemaVersion: 'SAJIMORA_JAVA_TYPE_IR_V1',
            irContentHash: 'void',
            display: accessors.chain ? cls.name : 'void',
            kind: 'JAVA_VOID',
          },
          parameters: [{
            name: propName,
            type: field.type,
            isVararg: false,
            isFinal: false,
            annotations: [],
          }],
          typeParameters: [],
          visibility: 'public',
          isStatic: false,
          isAbstract: false,
          isFinal: false,
          isConstructor: false,
          isDeclaredOverride: false,
          annotations: [],
          declarationOrdinal: newMethods.length,
          irContentHash: `lombok-synthesized-setter:${setterName}`,
          lineStart: field.line,
          lineEnd: field.line,
        });
      }
    }
  }

  return {
    synthesizedMethods: newMethods,
    effectiveFields: cls.fields,
  };
}
