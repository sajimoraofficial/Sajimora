export type JaxRsHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface JaxRsParameterBinding {
  kind: 'PATH' | 'QUERY' | 'HEADER' | 'ENTITY' | 'CONTEXT' | 'BEAN';
  name?: string; // absent for ENTITY and CONTEXT
  defaultValue?: string; // from @DefaultValue
}

export interface JaxRsBlocker {
  code: string;
  message: string;
}

export interface JaxRsEndpointCandidate {
  classPath: string;           // @Path on class (may be empty)
  methodPath: string;          // @Path on method (may be empty)
  effectivePath: string;       // composed, normalized canonical path
  httpMethods: JaxRsHttpMethod[];
  consumesMediaTypes: string[];  // from @Consumes, empty = wildcard
  producesMediaTypes: string[];  // from @Produces, empty = wildcard
  parameters: JaxRsParameterBinding[];
  blockers: JaxRsBlocker[];     // UNSUPPORTED_JAXRS_*, AMBIGUOUS_JAXRS_*, UNRESOLVED_*
  classification: 'SUPPORTED' | 'EXPLICITLY_BLOCKED' | 'UNRESOLVED';
  strippedRegexes?: Record<string, string>;
  regexConstraints?: Record<string, string>;
}

const MEDIA_TYPE_CONSTANTS: Record<string, string> = {
  APPLICATION_JSON: 'application/json',
  APPLICATION_XML: 'application/xml',
  TEXT_XML: 'text/xml',
  APPLICATION_ATOM_XML: 'application/atom+xml',
  APPLICATION_XHTML_XML: 'application/xhtml+xml',
  APPLICATION_SVG_XML: 'application/svg+xml',
  APPLICATION_FORM_URLENCODED: 'application/x-www-form-urlencoded',
  MULTIPART_FORM_DATA: 'multipart/form-data',
  APPLICATION_OCTET_STREAM: 'application/octet-stream',
  TEXT_PLAIN: 'text/plain',
  TEXT_HTML: 'text/html',
  SERVER_SENT_EVENTS: 'text/event-stream',
  WILDCARD: '*/*',
};

function stripComments(text: string): string {
  let result = '';
  let inString = false;
  let quoteChar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      result += c;
      if (c === quoteChar && text[i - 1] !== '\\') {
        inString = false;
      }
    } else if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      result += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      result += c;
    }
  }
  return result;
}

function splitAttributes(text: string): string[] {
  const result: string[] = [];
  let quote = false;
  let quoteChar = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quoteChar && text[i - 1] !== '\\') quote = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = true;
      quoteChar = c;
      continue;
    }
    if ('{([<'.includes(c)) depth++;
    if ('})]>'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function extractPathValue(text: string): { hasPath: boolean; pathValue: string } {
  const match = /@(?:(?:javax|jakarta)\.ws\.rs\.)?Path\b(?:\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\))?/.exec(text);
  if (!match) {
    return { hasPath: false, pathValue: '' };
  }
  return { hasPath: true, pathValue: match[1] ?? '' };
}

function composeCanonicalPath(classPath: string, methodPath: string): { effectivePath: string; strippedRegexes: Record<string, string> } {
  const strippedRegexes: Record<string, string> = {};
  const p1 = classPath.trim();
  const p2 = methodPath.trim();

  let combined: string;
  if (p1 && p2) {
    const s1 = p1.endsWith('/') ? p1.slice(0, -1) : p1;
    const s2 = p2.startsWith('/') ? p2.slice(1) : p2;
    combined = `${s1}/${s2}`;
  } else if (p1) {
    combined = p1;
  } else if (p2) {
    combined = p2;
  } else {
    combined = '/';
  }

  if (!combined.startsWith('/')) {
    combined = '/' + combined;
  }
  combined = combined.replace(/\/+/g, '/');
  if (combined.length > 1 && combined.endsWith('/')) {
    combined = combined.slice(0, -1);
  }

  // Strip regex constraints: {id: [0-9]+} -> {id}
  const effectivePath = combined.replace(/\{([a-zA-Z0-9_$]+)\s*:\s*([^}]+)\}/g, (_, name, regex) => {
    strippedRegexes[name] = regex.trim();
    return `{${name}}`;
  });

  return { effectivePath, strippedRegexes };
}

function extractMediaTypes(text: string, annotationName: 'Consumes' | 'Produces'): { present: boolean; mediaTypes: string[] } {
  const regex = new RegExp(`@(?:(?:javax|jakarta)\\.ws\\.rs\\.)?${annotationName}\\b(?:\\s*\\(([^)]*)\\))?`, 'g');
  const match = regex.exec(text);
  if (!match) {
    return { present: false, mediaTypes: [] };
  }
  const content = match[1]?.trim() ?? '';
  if (!content) {
    return { present: true, mediaTypes: [] };
  }

  let inner = content;
  const assignmentMatch = /^\s*value\s*=\s*([\s\S]+)$/.exec(inner);
  if (assignmentMatch) {
    inner = assignmentMatch[1].trim();
  }
  if (inner.startsWith('{') && inner.endsWith('}')) {
    inner = inner.slice(1, -1).trim();
  }
  if (!inner) {
    return { present: true, mediaTypes: [] };
  }

  const rawItems = splitAttributes(inner);
  const mediaTypes: string[] = [];
  for (const item of rawItems) {
    const trimmed = item.trim();
    const strMatch = /^["']([^"']*)["']$/.exec(trimmed);
    if (strMatch) {
      mediaTypes.push(strMatch[1]);
      continue;
    }
    const constMatch = /(?:MediaType\.)?([A-Z0-9_]+)/.exec(trimmed);
    if (constMatch && MEDIA_TYPE_CONSTANTS[constMatch[1]]) {
      mediaTypes.push(MEDIA_TYPE_CONSTANTS[constMatch[1]]);
      continue;
    }
    if (trimmed) {
      mediaTypes.push(trimmed);
    }
  }
  return { present: true, mediaTypes };
}

function extractMethodParametersText(methodText: string): string | undefined {
  const stripped = stripComments(methodText);
  let i = 0;
  while (i < stripped.length) {
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (i >= stripped.length) break;

    // Check for annotation
    if (stripped[i] === '@') {
      i++;
      while (i < stripped.length && /[a-zA-Z0-9_.]/.test(stripped[i])) i++;
      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      if (i < stripped.length && stripped[i] === '(') {
        let depth = 1;
        let quote = false;
        let quoteChar = '';
        i++;
        while (i < stripped.length && depth > 0) {
          const c = stripped[i];
          if (quote) {
            if (c === quoteChar && stripped[i - 1] !== '\\') quote = false;
          } else if (c === '"' || c === "'") {
            quote = true;
            quoteChar = c;
          } else if (c === '(') {
            depth++;
          } else if (c === ')') {
            depth--;
          }
          i++;
        }
      }
      continue;
    }

    // Check for method generic type parameters <T, U>
    if (stripped[i] === '<') {
      let depth = 1;
      i++;
      while (i < stripped.length && depth > 0) {
        if (stripped[i] === '<') depth++;
        else if (stripped[i] === '>') depth--;
        i++;
      }
      continue;
    }

    // Found opening parenthesis of method parameter list!
    if (stripped[i] === '(') {
      const start = i + 1;
      let depth = 1;
      let quote = false;
      let quoteChar = '';
      i++;
      while (i < stripped.length && depth > 0) {
        const c = stripped[i];
        if (quote) {
          if (c === quoteChar && stripped[i - 1] !== '\\') quote = false;
        } else if (c === '"' || c === "'") {
          quote = true;
          quoteChar = c;
        } else if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
        }
        i++;
      }
      return stripped.slice(start, i - 1);
    }

    i++;
  }
  return undefined;
}

function addBlocker(blockers: JaxRsBlocker[], code: string, message: string): void {
  if (!blockers.some(b => b.code === code && b.message === message)) {
    blockers.push({ code, message });
  }
}

export function parseJaxRsMethod(
  methodText: string,
  classAnnotationText: string
): JaxRsEndpointCandidate | undefined {
  const methodPathInfo = extractPathValue(methodText);
  const classPathInfo = extractPathValue(classAnnotationText ?? '');

  // Extract HTTP verbs
  const verbRegex = /@(?:(?:javax|jakarta)\.ws\.rs\.)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  const httpMethods: JaxRsHttpMethod[] = [];
  let m: RegExpExecArray | null;
  while ((m = verbRegex.exec(methodText)) !== null) {
    const verb = m[1] as JaxRsHttpMethod;
    if (!httpMethods.includes(verb)) {
      httpMethods.push(verb);
    }
  }

  // If method has neither HTTP verbs nor @Path, it is not a JAX-RS candidate
  if (httpMethods.length === 0 && !methodPathInfo.hasPath) {
    return undefined;
  }

  const blockers: JaxRsBlocker[] = [];

  // Check subresource locator: @Path on method but no HTTP verb
  if (httpMethods.length === 0 && methodPathInfo.hasPath) {
    addBlocker(
      blockers,
      'UNSUPPORTED_JAXRS_SUBRESOURCE_LOCATOR',
      'Subresource locators without HTTP verb annotations are unsupported'
    );
  }

  // Compose canonical path and strip regex constraints
  const { effectivePath, strippedRegexes } = composeCanonicalPath(
    classPathInfo.pathValue,
    methodPathInfo.pathValue
  );

  // Extract media types independently
  const methodProduces = extractMediaTypes(methodText, 'Produces');
  const classProduces = extractMediaTypes(classAnnotationText ?? '', 'Produces');
  const producesMediaTypes = methodProduces.present
    ? methodProduces.mediaTypes
    : classProduces.present
      ? classProduces.mediaTypes
      : [];

  const methodConsumes = extractMediaTypes(methodText, 'Consumes');
  const classConsumes = extractMediaTypes(classAnnotationText ?? '', 'Consumes');
  const consumesMediaTypes = methodConsumes.present
    ? methodConsumes.mediaTypes
    : classConsumes.present
      ? classConsumes.mediaTypes
      : [];

  const hasExplicitConsumes = methodConsumes.present || classConsumes.present;

  // Extract parameters
  const paramListText = extractMethodParametersText(methodText);
  const rawParams = paramListText ? splitAttributes(paramListText) : [];

  const parameters: JaxRsParameterBinding[] = [];
  let pendingDefaultValue: string | undefined = undefined;

  interface EntityCandidate {
    paramIndex: number;
    defaultValue?: string;
  }
  const entityCandidates: EntityCandidate[] = [];

  for (const param of rawParams) {
    const defaultValueMatch = /@(?:(?:javax|jakarta)\.ws\.rs\.)?DefaultValue\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/.exec(param);
    if (defaultValueMatch) {
      pendingDefaultValue = defaultValueMatch[1];
    }

    // Unsupported JAX-RS parameter annotations
    if (/@(?:(?:javax|jakarta)\.ws\.rs\.)?CookieParam\b/.test(param)) {
      addBlocker(blockers, 'UNSUPPORTED_JAXRS_COOKIE_PARAM', '@CookieParam is unsupported for cross-language API contracts');
      continue;
    }
    if (/@(?:(?:javax|jakarta)\.ws\.rs\.|org\.glassfish\.jersey\.media\.multipart\.)?(?:FormParam|FormDataParam)\b|@(?:retrofit2\.http\.)?Part\b/.test(param)) {
      addBlocker(blockers, 'UNSUPPORTED_JAXRS_FORM_PARAM', '@FormParam/@FormDataParam is unsupported for cross-language API contracts');
      continue;
    }
    if (/@(?:(?:javax|jakarta)\.ws\.rs\.)?MatrixParam\b/.test(param)) {
      addBlocker(blockers, 'UNSUPPORTED_JAXRS_MATRIX_PARAM', '@MatrixParam is unsupported for cross-language API contracts');
      continue;
    }
    if (/@(?:(?:javax|jakarta)\.ws\.rs(?:\.container)?\.)?Suspended\b/.test(param)) {
      addBlocker(blockers, 'UNSUPPORTED_JAXRS_SUSPENDED_PARAM', '@Suspended asynchronous parameters are unsupported');
      continue;
    }

    // Supported parameter annotations (JAX-RS + Retrofit client declarations)
    const pathParamMatch = /@(?:(?:javax|jakarta)\.ws\.rs\.|retrofit2\.http\.)?Path(?:Param)?\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/.exec(param);
    if (pathParamMatch) {
      parameters.push({
        kind: 'PATH',
        name: pathParamMatch[1],
        ...(pendingDefaultValue !== undefined ? { defaultValue: pendingDefaultValue } : {}),
      });
      pendingDefaultValue = undefined;
      continue;
    }

    const queryParamMatch = /@(?:(?:javax|jakarta)\.ws\.rs\.|retrofit2\.http\.)?Query(?:Param)?\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/.exec(param);
    if (queryParamMatch) {
      parameters.push({
        kind: 'QUERY',
        name: queryParamMatch[1],
        ...(pendingDefaultValue !== undefined ? { defaultValue: pendingDefaultValue } : {}),
      });
      pendingDefaultValue = undefined;
      continue;
    }

    const headerParamMatch = /@(?:(?:javax|jakarta)\.ws\.rs\.|retrofit2\.http\.)?Header(?:Param)?\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/.exec(param);
    if (headerParamMatch) {
      parameters.push({
        kind: 'HEADER',
        name: headerParamMatch[1],
        ...(pendingDefaultValue !== undefined ? { defaultValue: pendingDefaultValue } : {}),
      });
      pendingDefaultValue = undefined;
      continue;
    }

    const isExplicitContext = /@(?:(?:javax|jakarta)\.ws\.rs(?:\.core)?\.)?Context\b/.test(param);
    const isImplicitContextType = /(?:^|\s)(?:(?:javax|jakarta)\.servlet(?:\.http)?\.|(?:javax|jakarta)\.ws\.rs\.core\.|java\.security\.)?(?:HttpServletRequest|HttpServletResponse|ServletRequest|ServletResponse|HttpSession|Principal|Authentication|SecurityContext|UriInfo|HttpHeaders|Request|ResourceContext|Providers|ServletContext|ServletConfig|AsyncContext)\b/.test(param);

    if (isExplicitContext || isImplicitContextType) {
      parameters.push({
        kind: 'CONTEXT',
      });
      pendingDefaultValue = undefined;
      continue;
    }

    if (/@(?:(?:javax|jakarta)\.ws\.rs\.)?BeanParam\b/.test(param)) {
      parameters.push({
        kind: 'BEAN',
        ...(pendingDefaultValue !== undefined ? { defaultValue: pendingDefaultValue } : {}),
      });
      pendingDefaultValue = undefined;
      continue;
    }

    // Unannotated non-context parameter candidate
    entityCandidates.push({
      paramIndex: parameters.length,
      defaultValue: pendingDefaultValue,
    });
    parameters.push({
      kind: 'ENTITY',
      ...(pendingDefaultValue !== undefined ? { defaultValue: pendingDefaultValue } : {}),
    });
    pendingDefaultValue = undefined;
  }

  // Count unannotated non-context parameters
  if (entityCandidates.length > 1) {
    addBlocker(
      blockers,
      'AMBIGUOUS_JAXRS_ENTITY_PARAM',
      'Multiple unannotated entity parameters found on JAX-RS method'
    );
  }

  // Media type classification (only for active endpoint methods)
  if (httpMethods.length > 0) {
    const isJsonMediaType = (t: string) => {
      const clean = t.split(';')[0].trim().toLowerCase();
      return clean === 'application/json' || /^application\/[a-zA-Z0-9_.-]+\+json$/i.test(clean) || clean === 'application/*+json';
    };

    // Produces classification
    if (producesMediaTypes.length === 0 || producesMediaTypes.includes('*/*')) {
      addBlocker(
        blockers,
        'UNRESOLVED_MEDIA_TYPE',
        'Wildcard or unstated response media type requires explicit resolution'
      );
    } else if (producesMediaTypes.some(isJsonMediaType)) {
      // Supported for response direction
    } else {
      addBlocker(
        blockers,
        'NON_JSON_RESPONSE_MEDIA_TYPE',
        'Non-JSON response media type is not supported for cross-language contracts'
      );
    }

    // Consumes classification
    const hasEntityParam = entityCandidates.length > 0;
    const isBodyMethod = httpMethods.some(m => ['POST', 'PUT', 'PATCH'].includes(m));
    const requiresConsumesResolution = hasExplicitConsumes || hasEntityParam || isBodyMethod;

    if (requiresConsumesResolution) {
      if (consumesMediaTypes.length === 0 || consumesMediaTypes.includes('*/*')) {
        addBlocker(
          blockers,
          'UNRESOLVED_REQUEST_MEDIA_TYPE',
          'Wildcard or unstated request media type requires explicit resolution'
        );
      } else if (consumesMediaTypes.some(isJsonMediaType)) {
        // Supported for request direction
      } else {
        addBlocker(
          blockers,
          'NON_JSON_REQUEST_MEDIA_TYPE',
          'Non-JSON request media type is not supported for cross-language contracts'
        );
      }
    }
  }

  // Determine overall classification
  let classification: 'SUPPORTED' | 'EXPLICITLY_BLOCKED' | 'UNRESOLVED' = 'SUPPORTED';
  const hasExplicitBlocker = blockers.some(b =>
    b.code.startsWith('UNSUPPORTED_') ||
    b.code.startsWith('NON_JSON_') ||
    b.code.startsWith('AMBIGUOUS_')
  );
  const hasUnresolvedBlocker = blockers.some(b =>
    b.code.startsWith('UNRESOLVED_')
  );

  if (hasExplicitBlocker) {
    classification = 'EXPLICITLY_BLOCKED';
  } else if (hasUnresolvedBlocker) {
    classification = 'UNRESOLVED';
  } else {
    classification = 'SUPPORTED';
  }

  return {
    classPath: classPathInfo.pathValue,
    methodPath: methodPathInfo.pathValue,
    effectivePath,
    httpMethods,
    consumesMediaTypes,
    producesMediaTypes,
    parameters,
    blockers,
    classification,
    strippedRegexes,
    regexConstraints: strippedRegexes,
  };
}
