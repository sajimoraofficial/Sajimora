/**
 * EndpointIdentity.ts
 *
 * Implements deterministic endpoint identity normalization and linking based on:
 *   (service identity, HTTP method, normalized route segments & constraints, direction)
 *
 * Supports:
 *   - Spring class-level @RequestMapping + method-level annotations
 *   - @GetMapping, @PostMapping, @PutMapping, @PatchMapping, @DeleteMapping, @RequestMapping(method=...)
 *   - Path variables ({id}), constrained path variables ({id:[0-9]+}), wildcards (*, **)
 *   - Positional normalization with constraint metadata retention
 *   - Ambiguous mapping detection -> structured AMBIGUOUS_ENDPOINT blocker
 */

import {
  NormalizedRouteContract,
  RouteSegmentContract,
  EndpointIdentityContract,
  ContractDirection
} from './CanonicalContractIR';

/**
 * Parse and normalize a raw route path (from Spring or TS) into canonical RouteSegmentContract[].
 * E.g.:
 *   "/api/users/{id:[0-9]+}" -> [
 *     { text: "api", isParam: false },
 *     { text: "users", isParam: false },
 *     { text: "{0}", isParam: true, paramIndex: 0, paramName: "id", regexConstraint: "[0-9]+" }
 *   ]
 *
 *   "/api/files/*" -> [
 *     { text: "api", isParam: false },
 *     { text: "files", isParam: false },
 *     { text: "*", isParam: false, isWildcard: true }
 *   ]
 */
export function normalizeRouteSegments(path: string): NormalizedRouteContract {
  const pathname = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '') || '/';
  const cleaned = pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (cleaned === '/') {
    return { rawPath: path, segments: [] };
  }

  const parts = cleaned.split('/').slice(1);
  const segments: RouteSegmentContract[] = [];
  let paramIdx = 0;

  for (const part of parts) {
    if (!part) continue;

    // Check for Spring path parameter: {id} or {id:[0-9]+} or {id:regex}
    const springParamMatch = part.match(/^\{([a-zA-Z0-9_$]+)(?::([^}]+))?\}$/);
    if (springParamMatch) {
      const paramName = springParamMatch[1];
      const regexConstraint = springParamMatch[2]?.trim();
      segments.push({
        text: `{${paramIdx}}`,
        isParam: true,
        paramIndex: paramIdx++,
        paramName,
        regexConstraint,
      });
      continue;
    }

    // Check for TS template literal parameter: ${id} or ${expr}
    const tsParamMatch = part.match(/^\$\{([^}]+)\}$/);
    if (tsParamMatch) {
      const expr = tsParamMatch[1].trim();
      segments.push({
        text: `{${paramIdx}}`,
        isParam: true,
        paramIndex: paramIdx++,
        paramName: expr,
      });
      continue;
    }

    // Check for wildcards
    if (part === '*' || part === '**') {
      segments.push({
        text: part,
        isParam: false,
        isWildcard: true,
      });
      continue;
    }

    // Static segment
    segments.push({
      text: part,
      isParam: false,
    });
  }

  return { rawPath: path, segments };
}

/**
 * Combine Spring class-level prefix and method-level route path.
 */
export function combineSpringRoutes(classPrefix: string | undefined, methodRoute: string): string {
  if (!classPrefix || classPrefix === '/' || classPrefix === '') {
    return ('/' + methodRoute).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }
  const prefix = classPrefix.startsWith('/') ? classPrefix : '/' + classPrefix;
  const suffix = methodRoute.startsWith('/') ? methodRoute : '/' + methodRoute;
  const combined = (prefix + suffix).replace(/\/+/g, '/');
  return combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
}

export interface RouteMatchResult {
  readonly matches: boolean;
  readonly constraintMismatch?: string;
}

/**
 * Determine if two normalized routes match canonical identity.
 * Parameters match positionally ({0} matches {0}).
 * Wildcards ('*' matches one segment, '**' matches multiple).
 */
export function matchRoutes(
  routeA: NormalizedRouteContract,
  routeB: NormalizedRouteContract
): RouteMatchResult {
  if ([routeA.rawPath, routeB.rawPath].some(path => path === '<dynamic>')) return { matches: false };
  const segsA = routeA.segments;
  const segsB = routeB.segments;

  let i = 0;
  let j = 0;

  while (i < segsA.length && j < segsB.length) {
    const a = segsA[i];
    const b = segsB[j];

    if (a.text === '**' || b.text === '**') {
      // '**' matches remaining segments
      return { matches: true };
    }

    if (a.isWildcard || b.isWildcard) {
      i++;
      j++;
      continue;
    }

    if (a.isParam && b.isParam) {
      // Both are positional parameters
      if (a.regexConstraint && b.regexConstraint && a.regexConstraint !== b.regexConstraint) {
        return {
          matches: false,
          constraintMismatch: `Constraint mismatch between ${a.regexConstraint} and ${b.regexConstraint}`
        };
      }
      i++;
      j++;
      continue;
    }

    if (a.isParam !== b.isParam) {
      // One is param, other is static -> mismatch
      return { matches: false };
    }

    if (a.text !== b.text) {
      return { matches: false };
    }

    i++;
    j++;
  }

  if (i === segsA.length && j === segsB.length) {
    return { matches: true };
  }

  return { matches: false };
}

/**
 * Form deterministic endpoint key for maps and diffs:
 *   "SERVICE\0METHOD\0SEGMENTS\0DIRECTION"
 */
export function buildEndpointKey(identity: EndpointIdentityContract): string {
  const segStr = identity.normalizedRoute.segments.map(s => s.text).join('/');
  return `${identity.service ?? ''}\0${identity.httpMethod.toUpperCase()}\0${segStr}\0${identity.direction}`;
}
