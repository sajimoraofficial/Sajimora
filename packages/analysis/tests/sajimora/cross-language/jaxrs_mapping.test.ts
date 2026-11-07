import { describe, it, expect } from 'vitest';
import { parseJaxRsMethod } from '../../../src/sajimora/cross-language/JaxRsMapping';
import { discoverContractObligations } from '../../../src/sajimora/cross-language/IndependentContractInventory';

describe('JAX-RS mapping and route extraction', () => {
  // 1. Simple GET endpoint with @Path and explicit @Produces("application/json") → SUPPORTED
  it('classifies simple GET endpoint with @Path and explicit @Produces("application/json") as SUPPORTED', () => {
    const classAnnotation = '@Path("/api/v1")';
    const methodText = `
      @GET
      @Path("/items")
      @Produces("application/json")
      public Response getItems() {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, classAnnotation);
    expect(candidate).toBeDefined();
    expect(candidate!.classPath).toBe('/api/v1');
    expect(candidate!.methodPath).toBe('/items');
    expect(candidate!.effectivePath).toBe('/api/v1/items');
    expect(candidate!.httpMethods).toEqual(['GET']);
    expect(candidate!.producesMediaTypes).toEqual(['application/json']);
    expect(candidate!.classification).toBe('SUPPORTED');
    expect(candidate!.blockers).toHaveLength(0);
  });

  // 2. Method with @Path but no HTTP verb → EXPLICITLY_BLOCKED with UNSUPPORTED_JAXRS_SUBRESOURCE_LOCATOR
  it('blocks method with @Path but no HTTP verb as UNSUPPORTED_JAXRS_SUBRESOURCE_LOCATOR', () => {
    const classAnnotation = '@Path("/api")';
    const methodText = `
      @Path("/subresource")
      public SubResource getSubResource() {
        return new SubResource();
      }
    `;
    const candidate = parseJaxRsMethod(methodText, classAnnotation);
    expect(candidate).toBeDefined();
    expect(candidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(candidate!.httpMethods).toHaveLength(0);
    expect(candidate!.effectivePath).toBe('/api/subresource');
    expect(candidate!.blockers.some(b => b.code === 'UNSUPPORTED_JAXRS_SUBRESOURCE_LOCATOR')).toBe(true);
  });

  // 3. @Produces("application/xml") → EXPLICITLY_BLOCKED with NON_JSON_RESPONSE_MEDIA_TYPE
  it('blocks strictly non-JSON @Produces as EXPLICITLY_BLOCKED with NON_JSON_RESPONSE_MEDIA_TYPE', () => {
    const methodText = `
      @GET
      @Path("/xml-endpoint")
      @Produces("application/xml")
      public Response getXml() {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(candidate!.blockers.some(b => b.code === 'NON_JSON_RESPONSE_MEDIA_TYPE')).toBe(true);
  });

  // 4. Wildcard @Produces with no media type → UNRESOLVED with UNRESOLVED_MEDIA_TYPE
  it('marks wildcard @Produces with no media type as UNRESOLVED with UNRESOLVED_MEDIA_TYPE', () => {
    const methodText = `
      @GET
      @Path("/wildcard")
      public Response getWildcard() {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.producesMediaTypes).toEqual([]);
    expect(candidate!.classification).toBe('UNRESOLVED');
    expect(candidate!.blockers.some(b => b.code === 'UNRESOLVED_MEDIA_TYPE')).toBe(true);
  });

  // 5. @FormParam → EXPLICITLY_BLOCKED with UNSUPPORTED_JAXRS_FORM_PARAM
  it('blocks @FormParam as EXPLICITLY_BLOCKED with UNSUPPORTED_JAXRS_FORM_PARAM', () => {
    const methodText = `
      @POST
      @Path("/submit")
      @Consumes("application/x-www-form-urlencoded")
      @Produces("application/json")
      public Response submitForm(@FormParam("username") String username) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(candidate!.blockers.some(b => b.code === 'UNSUPPORTED_JAXRS_FORM_PARAM')).toBe(true);
  });

  // 6. @Context parameters excluded from entity param count
  it('excludes @Context parameters from entity param count and avoids false ambiguity', () => {
    const methodText = `
      @POST
      @Path("/create")
      @Consumes("application/json")
      @Produces("application/json")
      public Response create(
        @Context UriInfo uriInfo,
        @Context SecurityContext sec,
        UserDto user
      ) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.parameters.filter(p => p.kind === 'CONTEXT')).toHaveLength(2);
    expect(candidate!.parameters.filter(p => p.kind === 'ENTITY')).toHaveLength(1);
    expect(candidate!.blockers.some(b => b.code === 'AMBIGUOUS_JAXRS_ENTITY_PARAM')).toBe(false);
    expect(candidate!.classification).toBe('SUPPORTED');
  });

  // 7. Two unannotated params → AMBIGUOUS_JAXRS_ENTITY_PARAM
  it('blocks multiple unannotated parameters with AMBIGUOUS_JAXRS_ENTITY_PARAM', () => {
    const methodText = `
      @POST
      @Path("/multi-body")
      @Consumes("application/json")
      @Produces("application/json")
      public Response multiBody(UserDto user, ConfigDto config) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(candidate!.blockers.some(b => b.code === 'AMBIGUOUS_JAXRS_ENTITY_PARAM')).toBe(true);
  });

  // 8. @DefaultValue recorded on next parameter
  it('records @DefaultValue on next parameter binding', () => {
    const methodText = `
      @GET
      @Path("/search")
      @Produces("application/json")
      public Response search(
        @DefaultValue("asc") @QueryParam("order") String order,
        @QueryParam("limit") @DefaultValue("25") int limit,
        @PathParam("section") String section
      ) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.parameters).toHaveLength(3);
    expect(candidate!.parameters[0]).toEqual({
      kind: 'QUERY',
      name: 'order',
      defaultValue: 'asc',
    });
    expect(candidate!.parameters[1]).toEqual({
      kind: 'QUERY',
      name: 'limit',
      defaultValue: '25',
    });
    expect(candidate!.parameters[2]).toEqual({
      kind: 'PATH',
      name: 'section',
    });
  });

  // 9. Jakarta namespace (@jakarta.ws.rs.GET) works same as @javax.ws.rs.GET
  it('treats jakarta.ws.rs and javax.ws.rs namespaces identically', () => {
    const jakartaMethod = `
      @jakarta.ws.rs.GET
      @jakarta.ws.rs.Path("/items/{id}")
      @jakarta.ws.rs.Produces("application/json")
      public Response getJakarta(@jakarta.ws.rs.PathParam("id") String id) {
        return null;
      }
    `;
    const javaxMethod = `
      @javax.ws.rs.GET
      @javax.ws.rs.Path("/items/{id}")
      @javax.ws.rs.Produces("application/json")
      public Response getJavax(@javax.ws.rs.PathParam("id") String id) {
        return null;
      }
    `;

    const jakartaCandidate = parseJaxRsMethod(jakartaMethod, '');
    const javaxCandidate = parseJaxRsMethod(javaxMethod, '');

    expect(jakartaCandidate).toBeDefined();
    expect(javaxCandidate).toBeDefined();

    expect(jakartaCandidate!.httpMethods).toEqual(['GET']);
    expect(javaxCandidate!.httpMethods).toEqual(['GET']);

    expect(jakartaCandidate!.effectivePath).toBe('/items/{id}');
    expect(javaxCandidate!.effectivePath).toBe('/items/{id}');

    expect(jakartaCandidate!.parameters).toEqual([{ kind: 'PATH', name: 'id' }]);
    expect(javaxCandidate!.parameters).toEqual([{ kind: 'PATH', name: 'id' }]);

    expect(jakartaCandidate!.classification).toBe('SUPPORTED');
    expect(javaxCandidate!.classification).toBe('SUPPORTED');
  });

  // 10. @Consumes and @Produces resolved independently (one JSON, one wildcard = one SUPPORTED direction, one UNRESOLVED direction)
  it('resolves @Consumes and @Produces independently', () => {
    // Subtest A: Consumes JSON, Produces wildcard
    const methodA = `
      @POST
      @Path("/upload")
      @Consumes("application/json")
      public Response upload(UploadDto payload) {
        return null;
      }
    `;
    const candidateA = parseJaxRsMethod(methodA, '');
    expect(candidateA).toBeDefined();
    expect(candidateA!.consumesMediaTypes).toEqual(['application/json']);
    expect(candidateA!.producesMediaTypes).toEqual([]);
    expect(candidateA!.blockers.some(b => b.code === 'UNRESOLVED_MEDIA_TYPE')).toBe(true);
    expect(candidateA!.blockers.some(b => b.code === 'UNRESOLVED_REQUEST_MEDIA_TYPE')).toBe(false);
    expect(candidateA!.classification).toBe('UNRESOLVED');

    // Subtest B: Produces JSON, Consumes wildcard
    const methodB = `
      @POST
      @Path("/create")
      @Produces("application/json")
      public Response create(Payload payload) {
        return null;
      }
    `;
    const candidateB = parseJaxRsMethod(methodB, '');
    expect(candidateB).toBeDefined();
    expect(candidateB!.producesMediaTypes).toEqual(['application/json']);
    expect(candidateB!.consumesMediaTypes).toEqual([]);
    expect(candidateB!.blockers.some(b => b.code === 'UNRESOLVED_REQUEST_MEDIA_TYPE')).toBe(true);
    expect(candidateB!.blockers.some(b => b.code === 'UNRESOLVED_MEDIA_TYPE')).toBe(false);
    expect(candidateB!.classification).toBe('UNRESOLVED');
  });

  // Additional tests: Path regex stripping & unsupported parameter annotations
  it('strips regex constraints from {id: [0-9]+} and records stripped regexes as metadata', () => {
    const classAnnotation = '@Path("/api/v1")';
    const methodText = `
      @GET
      @Path("/users/{id: [0-9]+}/records/{code: [a-zA-Z]+}")
      @Produces("application/json")
      public Response getUserRecord(
        @PathParam("id") Long id,
        @PathParam("code") String code
      ) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, classAnnotation);
    expect(candidate).toBeDefined();
    expect(candidate!.effectivePath).toBe('/api/v1/users/{id}/records/{code}');
    expect(candidate!.strippedRegexes).toEqual({
      id: '[0-9]+',
      code: '[a-zA-Z]+',
    });
    expect(candidate!.classification).toBe('SUPPORTED');
  });

  it('blocks @CookieParam, @MatrixParam, and @Suspended with corresponding blocker codes', () => {
    const cookieMethod = `
      @GET
      @Path("/cookie")
      @Produces("application/json")
      public Response cookieMethod(@CookieParam("session") String session) { return null; }
    `;
    const cookieCandidate = parseJaxRsMethod(cookieMethod, '');
    expect(cookieCandidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(cookieCandidate!.blockers.some(b => b.code === 'UNSUPPORTED_JAXRS_COOKIE_PARAM')).toBe(true);

    const matrixMethod = `
      @GET
      @Path("/matrix")
      @Produces("application/json")
      public Response matrixMethod(@MatrixParam("version") String version) { return null; }
    `;
    const matrixCandidate = parseJaxRsMethod(matrixMethod, '');
    expect(matrixCandidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(matrixCandidate!.blockers.some(b => b.code === 'UNSUPPORTED_JAXRS_MATRIX_PARAM')).toBe(true);

    const suspendedMethod = `
      @GET
      @Path("/async")
      @Produces("application/json")
      public void asyncMethod(@Suspended AsyncResponse asyncResponse) {}
    `;
    const suspendedCandidate = parseJaxRsMethod(suspendedMethod, '');
    expect(suspendedCandidate!.classification).toBe('EXPLICITLY_BLOCKED');
    expect(suspendedCandidate!.blockers.some(b => b.code === 'UNSUPPORTED_JAXRS_SUSPENDED_PARAM')).toBe(true);
  });

  it('supports @BeanParam binding', () => {
    const methodText = `
      @GET
      @Path("/filter")
      @Produces("application/json")
      public Response filter(@BeanParam FilterBean filterBean) { return null; }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    expect(candidate!.parameters).toEqual([{ kind: 'BEAN' }]);
    expect(candidate!.classification).toBe('SUPPORTED');
  });

  it('returns undefined for non-JAX-RS helper methods', () => {
    const methodText = `
      public String helperMethod(String input) {
        return input.trim();
      }
    `;
    expect(parseJaxRsMethod(methodText, '')).toBeUndefined();
    expect(parseJaxRsMethod(methodText, '@Path("/api")')).toBeUndefined();
  });

  // IndependentContractInventory integration test
  it('classifies JAX-RS methods as jaxrs-candidate when class has @Path', () => {
    const javaSourceWithClassPath = `
      package com.example;
      import javax.ws.rs.Path;
      import javax.ws.rs.GET;

      @Path("/api")
      public class Resource {
        @GET
        public String getResource() {
          return "ok";
        }
      }
    `;
    const javaSourceWithoutClassPath = `
      package com.example;
      import javax.ws.rs.GET;

      public class PlainResource {
        @GET
        public String getPlain() {
          return "plain";
        }
      }
    `;

    const filesWithClassPath = new Map([['Resource.java', javaSourceWithClassPath]]);
    const obligationsWithClassPath = discoverContractObligations(filesWithClassPath, 'repo', 'rev');
    const jaxrsCandidate = obligationsWithClassPath.find(o => o.family === 'jaxrs-candidate');
    expect(jaxrsCandidate).toBeDefined();
    expect(jaxrsCandidate!.discoveryEvidence).toContain('@GET');

    const filesWithoutClassPath = new Map([['PlainResource.java', javaSourceWithoutClassPath]]);
    const obligationsWithoutClassPath = discoverContractObligations(filesWithoutClassPath, 'repo', 'rev');
    const unqualifiedJaxrs = obligationsWithoutClassPath.find(o => o.family === 'unqualified-jaxrs');
    expect(unqualifiedJaxrs).toBeDefined();
    expect(unqualifiedJaxrs!.discoveryEvidence).toContain('@GET');
  });

  // Implicit servlet context parameter recognition (fixes 46 Fineract ambiguous entity cases)
  it('recognizes HttpServletRequest, HttpServletResponse, and Principal as implicit CONTEXT parameters', () => {
    const methodText = `
      @POST
      @Path("/deposit")
      @Consumes("application/json")
      @Produces("application/json")
      public Response makeDeposit(
        PaymentDto payment,
        HttpServletRequest request,
        HttpServletResponse response,
        Principal principal
      ) {
        return null;
      }
    `;
    const candidate = parseJaxRsMethod(methodText, '');
    expect(candidate).toBeDefined();
    const contextParams = candidate!.parameters.filter(p => p.kind === 'CONTEXT');
    const entityParams = candidate!.parameters.filter(p => p.kind === 'ENTITY');
    expect(contextParams).toHaveLength(3);
    expect(entityParams).toHaveLength(1);
    expect(candidate!.blockers.some(b => b.code === 'AMBIGUOUS_JAXRS_ENTITY_PARAM')).toBe(false);
    expect(candidate!.classification).toBe('SUPPORTED');
  });
});

