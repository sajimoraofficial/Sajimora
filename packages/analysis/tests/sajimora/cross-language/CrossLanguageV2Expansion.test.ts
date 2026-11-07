/**
 * CrossLanguageV2Expansion.test.ts
 *
 * Comprehensive test suite validating the V2 cross-language advisory architecture:
 *   1. Response break (displayName -> name in Java, TS expects displayName) -> LIKELY_VIOLATED
 *   2. Coordinated repair (Java displayName -> name, TS contract displayName -> name, consumers updated) -> LIKELY_PRESERVED
 *   3. Partial repair (Java updated, TS contract updated, but 1 consumer still reads displayName) -> LIKELY_VIOLATED
 *   4. Request break (Java adds @NotNull email, TS request body omits email) -> LIKELY_VIOLATED
 *   5. Unresolvable dynamic URL (fetch(buildUrl())) -> INCONCLUSIVE (reason = DYNAMIC_URL)
 *   6. Custom Jackson serializer (@JsonSerialize(using=...)) -> INCONCLUSIVE (reason = CUSTOM_JACKSON_SERIALIZER)
 *   7. Lombok + generic wrapper (@GetMapping ResponseEntity<List<UserDto>> with Lombok @Data) -> correct canonical array/object wire shape
 *   8. Axios client adapter -> extracts axios.get<UserDto>('/users')
 *   9. URL constant resolver -> resolves imported route constant USERS_URL
 *  10. Strict Zod schema extra property rejection -> LIKELY_VIOLATED
 */

import assert from 'node:assert/strict';
import { JavaSealedCompilerHost } from '../../../src/sajimora/languages/java/programs/JavaSealedCompilerHost';
import { JavaWireModelEngine } from '../../../src/sajimora/cross-language/JavaWireModelEngine';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import { ConsumerImpactGraph } from '../../../src/sajimora/cross-language/ConsumerImpactGraph';
import { FourWayCompatibilityEngine } from '../../../src/sajimora/cross-language/FourWayCompatibilityEngine';
import { UrlConstantResolver } from '../../../src/sajimora/cross-language/UrlConstantResolver';
import { AxiosAdapter, FetchAdapter } from '../../../src/sajimora/cross-language/HttpClientAdapters';
import { unwrapSpringContainer } from '../../../src/sajimora/cross-language/SpringContainerUnwrapper';
import { normalizeRouteSegments, matchRoutes } from '../../../src/sajimora/cross-language/EndpointIdentity';
import * as ts from 'typescript';

console.log('=== CrossLanguage V2 Expansion Tests ===\n');
let passed = 0;
let failed = 0;

async function test(name: string | null, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err}`);
    failed++;
  }
}

function makeSnapshot(files: Record<string, string>) {
  return {
    trackedFiles: Object.keys(files),
    readTextFile: (path: string) => files[path],
  };
}

void (async () => {
  // -------------------------------------------------------------------------
  // Test 1: Response break -> LIKELY_VIOLATED
  // -------------------------------------------------------------------------
  await test('1. Response break: Java renames displayName -> name, TS still expects displayName -> LIKELY_VIOLATED', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getDisplayName() { return "Ada"; }
}`
    };

    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getName() { return "Ada"; }
}`
    };

    const candidateTs = {
      'src/client.ts': `
export interface UserDto {
  displayName: string | null;
}
export async function fetchUser(id: string) {
  const res = await fetch(\`/api/users/\${encodeURIComponent(id)}\`);
  const data: UserDto = await res.json();
  return data;
}
`,
      'src/UserProfile.tsx': `
import { fetchUser, UserDto } from './client';
export function UserProfile(user: UserDto) {
  return <h1>{user.displayName}</h1>;
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints;
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const urlResolver = new UrlConstantResolver(tsMap);
    const fetchAdapter = new FetchAdapter();
    const sf = ts.createSourceFile('src/client.ts', candidateTs['src/client.ts'], ts.ScriptTarget.Latest, true);
    const requests = fetchAdapter.extractRequests(sf, urlResolver, typeParser).requests;

    const consumerGraph = new ConsumerImpactGraph(tsMap);
    const tsEndpoints = requests.map(req => ({
      identity: {
        service: null,
        httpMethod: req.method,
        normalizedRoute: req.route,
        direction: 'RESPONSE' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: req.expectedResponseType ?? null,
      provenance: req.provenance,
    }));

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: consumerGraph,
    });
    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].wirePath, '$.displayName');
    assert.ok(result.findings[0].repairHint.includes('surviving consumer'));
  });

  // -------------------------------------------------------------------------
  // Test 2: Coordinated repair -> LIKELY_PRESERVED
  // -------------------------------------------------------------------------
  await test('2. Coordinated repair: Java displayName -> name, TS contract displayName -> name, consumers updated -> LIKELY_PRESERVED', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getDisplayName() { return "Ada"; }
}`
    };

    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getName() { return "Ada"; }
}`
    };

    // Both TS contract and consumers were repaired to use .name
    const candidateTs = {
      'src/client.ts': `
export interface UserDto {
  name: string | null;
}
export async function fetchUser(id: string) {
  const res = await fetch(\`/api/users/\${encodeURIComponent(id)}\`);
  const data: UserDto = await res.json();
  return data;
}
`,
      'src/UserProfile.tsx': `
import { fetchUser, UserDto } from './client';
export function UserProfile(user: UserDto) {
  return <h1>{user.name}</h1>;
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints;
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const urlResolver = new UrlConstantResolver(tsMap);
    const fetchAdapter = new FetchAdapter();
    const sf = ts.createSourceFile('src/client.ts', candidateTs['src/client.ts'], ts.ScriptTarget.Latest, true);
    const requests = fetchAdapter.extractRequests(sf, urlResolver, typeParser).requests;

    const consumerGraph = new ConsumerImpactGraph(tsMap);
    const tsEndpoints = requests.map(req => ({
      identity: {
        service: null,
        httpMethod: req.method,
        normalizedRoute: req.route,
        direction: 'RESPONSE' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: req.expectedResponseType ?? null,
      provenance: req.provenance,
    }));

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: consumerGraph,
    });

    assert.equal(result.verdict, 'LIKELY_PRESERVED', 'Coordinated repair recognized: zero surviving broken consumers');
    assert.equal(result.findings.length, 0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Partial repair -> LIKELY_VIOLATED
  // -------------------------------------------------------------------------
  await test('3. Partial repair: Java updated, TS contract updated, but 1 consumer still reads displayName -> LIKELY_VIOLATED', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getDisplayName() { return "Ada"; }
}`
    };

    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getName() { return "Ada"; }
}`
    };

    // TS contract updated to name, but UserBadge still reads .displayName
    const candidateTs = {
      'src/client.ts': `
export interface UserDto {
  name: string | null;
}
export async function fetchUser(id: string) {
  const res = await fetch(\`/api/users/\${encodeURIComponent(id)}\`);
  const data: UserDto = await res.json();
  return data;
}
`,
      'src/UserProfile.tsx': `
import { UserDto } from './client';
export function UserProfile(user: UserDto) {
  return <h1>{user.name}</h1>;
}
`,
      'src/UserBadge.tsx': `
import { UserDto } from './client';
export function UserBadge(user: UserDto) {
  return <span>{user.displayName}</span>;
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints;
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const urlResolver = new UrlConstantResolver(tsMap);
    const fetchAdapter = new FetchAdapter();
    const sf = ts.createSourceFile('src/client.ts', candidateTs['src/client.ts'], ts.ScriptTarget.Latest, true);
    const requests = fetchAdapter.extractRequests(sf, urlResolver, typeParser).requests;

    const consumerGraph = new ConsumerImpactGraph(tsMap);
    const tsEndpoints = requests.map(req => ({
      identity: {
        service: null,
        httpMethod: req.method,
        normalizedRoute: req.route,
        direction: 'RESPONSE' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: req.expectedResponseType ?? null,
      provenance: req.provenance,
    }));

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: consumerGraph,
    });

    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].repairHint.includes('src/UserBadge.tsx:4'), 'Identifies exact surviving broken consumer file and line');
  });

  // -------------------------------------------------------------------------
  // Test 4: Request break -> LIKELY_VIOLATED
  // -------------------------------------------------------------------------
  await test('4. Request break: Java candidate adds required @NotNull email, TS request body omits email -> LIKELY_VIOLATED', () => {
    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @PostMapping("/api/users")
  public void createUser(@Valid @RequestBody UserCreateRequest req) {}
}`,
      'src/UserCreateRequest.java': `package com.example;
public class UserCreateRequest {
  @NotNull
  public String email;
  public String name;
}`
    };

    const candidateTs = {
      'src/client.ts': `
export interface UserPayload {
  name: string | null;
}
export async function createUser(data: UserPayload) {
  return fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
}
`
    };

    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const cEngine = new JavaWireModelEngine(cHost);
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const parsedPayload = typeParser.parseTypeByName('UserPayload', 'src/client.ts').wireType;

    const tsEndpoints = [{
      identity: {
        service: null,
        httpMethod: 'POST',
        normalizedRoute: normalizeRouteSegments('/api/users'),
        direction: 'REQUEST' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: parsedPayload,
      provenance: {
        language: 'TYPESCRIPT' as const,
        file: 'src/client.ts',
        line: 5,
      }
    }];

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: [],
      candidateJavaEndpoints: cEps,
      parentTsRequests: [],
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: new ConsumerImpactGraph(tsMap),
    });

    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].wirePath, 'request.$.email');
    assert.ok(result.findings[0].repairHint.includes("requires property 'email'"));
  });

  // -------------------------------------------------------------------------
  // Test 5: Unresolvable dynamic URL -> INCONCLUSIVE (DYNAMIC_URL)
  // -------------------------------------------------------------------------
  await test('5. Unresolvable dynamic URL: fetch(buildUrl(x)) -> INCONCLUSIVE with DYNAMIC_URL blocker', () => {
    const tsFiles = {
      'src/client.ts': `
export async function fetchDynamic(id: string) {
  return fetch(buildCustomUrl(id, 'profile'));
}
`
    };

    const tsMap = new Map(Object.entries(tsFiles));
    const urlResolver = new UrlConstantResolver(tsMap);
    const typeParser = new TypeScriptContractParser(tsMap);
    const fetchAdapter = new FetchAdapter();
    const sf = ts.createSourceFile('src/client.ts', tsFiles['src/client.ts'], ts.ScriptTarget.Latest, true);

    const extraction = fetchAdapter.extractRequests(sf, urlResolver, typeParser);
    assert.ok(extraction.blockers.some(b => b.code === 'DYNAMIC_URL'));
  });

  // -------------------------------------------------------------------------
  // Test 6: Custom Jackson Serializer -> INCONCLUSIVE (CUSTOM_JACKSON_SERIALIZER)
  // -------------------------------------------------------------------------
  await test('6. Custom Jackson Serializer: @JsonSerialize(using = Custom.class) -> emits CUSTOM_JACKSON_SERIALIZER', () => {
    const javaFiles = {
      'src/UserDto.java': `package com.example;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
@JsonSerialize(using = CustomUserSerializer.class)
public class UserDto {
  public String name;
}`
    };

    const host = new JavaSealedCompilerHost(makeSnapshot(javaFiles));
    const engine = new JavaWireModelEngine(host);
    const result = engine.extractWireType('com.example.UserDto');

    assert.ok(result.blockers.some(b => b.code === 'CUSTOM_JACKSON_SERIALIZER'), 'Emits CUSTOM_JACKSON_SERIALIZER blocker');
  });

  // -------------------------------------------------------------------------
  // Test 7: Lombok + Generic Container Unwrapping
  // -------------------------------------------------------------------------
  await test('7. Lombok + generic container: ResponseEntity<List<UserDto>> with Lombok @Data -> canonical Array<Object(UserDto)>', () => {
    const javaFiles = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import java.util.List;
@RestController
public class UserController {
  @GetMapping("/api/users")
  public ResponseEntity<List<UserDto>> listUsers() { return null; }
}`,
      'src/UserDto.java': `package com.example;
import lombok.Data;
@Data
public class UserDto {
  private Long id;
  private String displayName;
}`
    };

    const host = new JavaSealedCompilerHost(makeSnapshot(javaFiles));
    const engine = new JavaWireModelEngine(host);
    const controller = host.getClassByFQCN('com.example.UserController')!;
    const { endpoints, blockers } = engine.extractControllerEndpoints(controller);

    assert.equal(blockers.length, 0, 'No UNSUPPORTED_LOMBOK_ACCESSOR blockers; Lombok successfully synthesized');
    assert.equal(endpoints.length, 1);
    const respBody = endpoints[0].body;
    assert.equal(respBody?.kind, 'ARRAY', 'Unwrapped outer ResponseEntity and List to ARRAY');
    if (respBody?.kind === 'ARRAY') {
      assert.equal(respBody.elementType.kind, 'OBJECT');
      if (respBody.elementType.kind === 'OBJECT') {
        const propNames = respBody.elementType.properties.map(p => p.wireName);
        assert.ok(propNames.includes('id'), 'Synthesized id getter');
        assert.ok(propNames.includes('displayName'), 'Synthesized displayName getter');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 8: Axios Client Adapter
  // -------------------------------------------------------------------------
  await test('8. Axios client adapter: extracts axios.get<UserDto>("/api/users")', () => {
    const tsFiles = {
      'src/api.ts': `
import axios from 'axios';
export interface UserDto {
  id: number;
}
export async function getUsers() {
  return axios.get<UserDto>('/api/users');
}
`
    };

    const tsMap = new Map(Object.entries(tsFiles));
    const urlResolver = new UrlConstantResolver(tsMap);
    const typeParser = new TypeScriptContractParser(tsMap);
    const axiosAdapter = new AxiosAdapter();
    const sf = ts.createSourceFile('src/api.ts', tsFiles['src/api.ts'], ts.ScriptTarget.Latest, true);

    const res = axiosAdapter.extractRequests(sf, urlResolver, typeParser);
    assert.equal(res.requests.length, 1);
    assert.equal(res.requests[0].clientKind, 'AXIOS');
    assert.equal(res.requests[0].method, 'GET');
    assert.equal(res.requests[0].responseTypeName, 'UserDto');
    assert.equal(res.requests[0].route.rawPath, '/api/users');
  });

  // -------------------------------------------------------------------------
  // Test 9: URL Constant Resolver
  // -------------------------------------------------------------------------
  await test('9. URL Constant Resolver: resolves imported constant USERS_URL in route template', () => {
    const tsFiles = {
      'src/constants.ts': `
export const USERS_API = '/api/v1/users';
`,
      'src/client.ts': `
import { USERS_API } from './constants';
export async function getUser(id: string) {
  return fetch(\`\${USERS_API}/\${encodeURIComponent(id)}\`);
}
`
    };

    const tsMap = new Map(Object.entries(tsFiles));
    const urlResolver = new UrlConstantResolver(tsMap);
    const sf = ts.createSourceFile('src/client.ts', tsFiles['src/client.ts'], ts.ScriptTarget.Latest, true);

    let extractedUrl: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
        const resolved = urlResolver.resolveUrl(node.arguments[0], 'src/client.ts');
        extractedUrl = resolved.url;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    assert.ok(extractedUrl?.includes('/api/v1/users'), `Resolved URL through constant: ${extractedUrl}`);
  });

  // -------------------------------------------------------------------------
  // Test 10: Strict Zod Schema Extra Field Rejection
  // -------------------------------------------------------------------------
  await test('10. Strict Zod Schema: candidate Java adds new field, TS Zod is .strict() -> LIKELY_VIOLATED', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String name;
}`
    };

    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String name;
  public String internalTrackingCode; // newly added field
}`
    };

    const candidateTs = {
      'src/client.ts': `
import { z } from 'zod';
export const UserSchema = z.object({
  name: z.string().nullable(),
}).strict();

export async function fetchUser(id: string) {
  const res = await fetch(\`/api/users/\${encodeURIComponent(id)}\`);
  return UserSchema.parse(await res.json());
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints;
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const parsedZod = typeParser.parseTypeByName('UserSchema', 'src/client.ts').wireType;

    const tsEndpoints = [{
      identity: {
        service: null,
        httpMethod: 'GET',
        normalizedRoute: normalizeRouteSegments('/api/users/{id}'),
        direction: 'RESPONSE' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: parsedZod,
      provenance: {
        language: 'TYPESCRIPT' as const,
        file: 'src/client.ts',
        line: 8,
      }
    }];

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: new ConsumerImpactGraph(tsMap),
    });

    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].wirePath, '$.internalTrackingCode');
    assert.ok(result.findings[0].repairHint.includes('.strict()'));
  });

  // -------------------------------------------------------------------------
  // Test 11: Entire Method Deleted (Endpoint Removed)
  // -------------------------------------------------------------------------
  await test('11. Entire method deleted: Java deletes @DeleteMapping endpoint, TS client still calls it -> LIKELY_VIOLATED', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }

  @DeleteMapping("/api/users/{id}")
  public void deleteUser(@PathVariable String id) {}
}`,
      'src/UserDto.java': `package com.example; public class UserDto { public String name; }`
    };

    // In candidate, deleteUser method was completely removed!
    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example; public class UserDto { public String name; }`
    };

    const candidateTs = {
      'src/client.ts': `
export async function removeUser(id: string) {
  return fetch(\`/api/users/\${encodeURIComponent(id)}\`, { method: 'DELETE' });
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints;
    const cEps = cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints;

    const tsMap = new Map(Object.entries(candidateTs));
    const tsEndpoints = [{
      identity: {
        service: null,
        httpMethod: 'DELETE',
        normalizedRoute: normalizeRouteSegments('/api/users/{id}'),
        direction: 'RESPONSE' as const,
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: null,
      provenance: {
        language: 'TYPESCRIPT' as const,
        file: 'src/client.ts',
        line: 3,
      }
    }];

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: new ConsumerImpactGraph(tsMap),
    });

    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].wirePath, 'endpoint');
    assert.ok(result.findings[0].repairHint.includes('was completely deleted'));
  });

  // -------------------------------------------------------------------------
  // Test 12: Multiple Files Edited Simultaneously (Controllers, DTOs, Components)
  // -------------------------------------------------------------------------
  await test('12. Multiple files edited simultaneously: 3 Java files + 3 TS files -> all breaks tracked across files', () => {
    const parentJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/OrderController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController {
  @GetMapping("/api/orders/{id}")
  public OrderDto getOrder(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getDisplayName() { return ""; }
}`,
      'src/OrderDto.java': `package com.example;
public class OrderDto {
  public double getAmount() { return 0; }
}`
    };

    // In candidate, both UserDto and OrderDto are modified
    const candidateJava = {
      'src/UserController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  @GetMapping("/api/users/{id}")
  public UserDto getUser(@PathVariable String id) { return null; }
}`,
      'src/OrderController.java': `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController {
  @GetMapping("/api/orders/{id}")
  public OrderDto getOrder(@PathVariable String id) { return null; }
}`,
      'src/UserDto.java': `package com.example;
public class UserDto {
  public String getName() { return ""; }
}`, // renamed
      'src/OrderDto.java': `package com.example;
public class OrderDto {
  public String getAmount() { return ""; }
}` // type changed double -> String
    };

    const candidateTs = {
      'src/userClient.ts': `
export interface UserDto { displayName: string | null; }
export async function fetchUser(id: string) { return (await fetch(\`/api/users/\${encodeURIComponent(id)}\`)).json(); }
`,
      'src/orderClient.ts': `
export interface OrderDto { amount: number; }
export async function fetchOrder(id: string) { return (await fetch(\`/api/orders/\${encodeURIComponent(id)}\`)).json(); }
`,
      'src/Dashboard.tsx': `
import { UserDto } from './userClient';
import { OrderDto } from './orderClient';
export function Dashboard(u: UserDto, o: OrderDto) {
  return <div>{u.displayName} - {o.amount}</div>;
}
`
    };

    const pHost = new JavaSealedCompilerHost(makeSnapshot(parentJava));
    const cHost = new JavaSealedCompilerHost(makeSnapshot(candidateJava));
    const pEngine = new JavaWireModelEngine(pHost);
    const cEngine = new JavaWireModelEngine(cHost);

    const pEps = [
      ...pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.UserController')!).endpoints,
      ...pEngine.extractControllerEndpoints(pHost.getClassByFQCN('com.example.OrderController')!).endpoints,
    ];
    const cEps = [
      ...cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.UserController')!).endpoints,
      ...cEngine.extractControllerEndpoints(cHost.getClassByFQCN('com.example.OrderController')!).endpoints,
    ];

    const tsMap = new Map(Object.entries(candidateTs));
    const typeParser = new TypeScriptContractParser(tsMap);
    const userType = typeParser.parseTypeByName('UserDto', 'src/userClient.ts').wireType;
    const orderType = typeParser.parseTypeByName('OrderDto', 'src/orderClient.ts').wireType;

    const tsEndpoints = [
      {
        identity: { service: null, httpMethod: 'GET', normalizedRoute: normalizeRouteSegments('/api/users/{id}'), direction: 'RESPONSE' as const },
        pathParameters: [], queryParameters: [], headers: [], body: userType,
        provenance: { language: 'TYPESCRIPT' as const, file: 'src/userClient.ts', line: 3 }
      },
      {
        identity: { service: null, httpMethod: 'GET', normalizedRoute: normalizeRouteSegments('/api/orders/{id}'), direction: 'RESPONSE' as const },
        pathParameters: [], queryParameters: [], headers: [], body: orderType,
        provenance: { language: 'TYPESCRIPT' as const, file: 'src/orderClient.ts', line: 3 }
      }
    ];

    const engine = new FourWayCompatibilityEngine();
    const result = engine.analyze({
      parentJavaEndpoints: pEps,
      candidateJavaEndpoints: cEps,
      parentTsRequests: tsEndpoints,
      candidateTsRequests: tsEndpoints,
      candidateConsumerGraph: new ConsumerImpactGraph(tsMap),
    });

    assert.equal(result.verdict, 'LIKELY_VIOLATED');
    assert.equal(result.findings.length, 2, 'Detects violations in both endpoints simultaneously across multiple files');
    const wirePaths = result.findings.map(f => f.wirePath).sort();
    assert.deepEqual(wirePaths, ['$.amount', '$.displayName']);
  });

  await test('13. Acronym getter decapitalization: getURL, getID, getURLPath map to url, id, urlPath', () => {
    const javaCode = {
      'src/main/java/com/example/AcronymDto.java': `
package com.example;
public class AcronymDto {
  private String url;
  private Long id;
  private String path;
  public String getURL() { return this.url; }
  public Long getID() { return this.id; }
  public String getURLPath() { return this.path; }
}`
    };

    const host = new JavaSealedCompilerHost(makeSnapshot(javaCode));
    const engine = new JavaWireModelEngine(host);
    const { wireType: wire } = engine.extractWireType('com.example.AcronymDto', 'src/main/java/com/example/AcronymDto.java');

    assert.equal(wire.kind, 'OBJECT');
    if (wire.kind === 'OBJECT') {
      const propNames = wire.properties.map(p => p.wireName).sort();
      assert.deepEqual(propNames, ['id', 'url', 'urlPath']);
    }
  });

  await test('14. Temporal Java types do not silently become primitive string', () => {
    const javaCode = {
      'src/main/java/com/example/TemporalDto.java': `
package com.example;
import java.util.Date;
import java.time.Instant;
public class TemporalDto {
  private Date createdAt;
  private Instant updatedInstant;
  public Date getCreatedAt() { return this.createdAt; }
  public Instant getUpdatedInstant() { return this.updatedInstant; }
}`
    };

    const host = new JavaSealedCompilerHost(makeSnapshot(javaCode));
    const engine = new JavaWireModelEngine(host);
    const { wireType: wire, blockers } = engine.extractWireType('com.example.TemporalDto', 'src/main/java/com/example/TemporalDto.java');

    assert.equal(wire.kind, 'OBJECT');
    assert.ok(blockers.length > 0, 'Temporal types must emit blockers rather than silently pretending to be strings');
    assert.ok(blockers.some(b => b.message.includes('Date') || b.message.includes('Instant')));
  });

  await test('15. Grounded Snake Case Jackson Naming: Java camelCase getters wire to snake_case properties with TS validation', () => {
    const javaCode = {
      'src/main/java/com/example/AccountDto.java': `
package com.example;
public class AccountDto {
  private String accountId;
  private String userEmail;
  public String getAccountId() { return this.accountId; }
  public String getUserEmail() { return this.userEmail; }
}`
    };

    const host = new JavaSealedCompilerHost(makeSnapshot(javaCode));
    const engine = new JavaWireModelEngine(host, 'SNAKE_CASE');
    const { wireType: wire, blockers } = engine.extractWireType('com.example.AccountDto', 'src/main/java/com/example/AccountDto.java');

    assert.equal(blockers.length, 0);
    assert.equal(wire.kind, 'OBJECT');
    if (wire.kind === 'OBJECT') {
      const propNames = wire.properties.map(p => p.wireName).sort();
      assert.deepEqual(propNames, ['account_id', 'user_email'], 'SNAKE_CASE naming strategy must transform getter names to snake_case wire properties');
    }
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
