import { describe, it, expect } from 'vitest';
import { unwrapSpringContainer } from '../../../src/sajimora/cross-language/SpringContainerUnwrapper';

describe('SpringContainerUnwrapper complex generic return types', () => {
  it('unwraps nested CompletableFuture<ResponseEntity<Device>> down to Device', () => {
    const result = unwrapSpringContainer('CompletableFuture<ResponseEntity<com.thingsboard.Device>>');
    expect(result.payloadTypeName).toBe('com.thingsboard.Device');
    expect(result.isArray).toBe(false);
    expect(result.isStreamOrFlux).toBe(false);
    expect(result.isOptional).toBe(false);
    expect(result.isOpaqueContainer).toBe(false);
    expect(result.unwrappedContainers).toEqual(['CompletableFuture', 'ResponseEntity']);
  });

  it('unwraps nested CompletableFuture<ResponseEntity<List<Device>>> down to Device with isArray: true', () => {
    const result = unwrapSpringContainer('CompletableFuture<ResponseEntity<List<com.thingsboard.Device>>>');
    expect(result.payloadTypeName).toBe('com.thingsboard.Device');
    expect(result.isArray).toBe(true);
    expect(result.unwrappedContainers).toEqual(['CompletableFuture', 'ResponseEntity', 'List']);
  });

  it('unwraps DeferredResult<ResponseEntity<Map<String, Object>>> to Map<String, Object>', () => {
    const result = unwrapSpringContainer('DeferredResult<ResponseEntity<Map<String, Object>>>');
    expect(result.payloadTypeName).toBe('Map<String, Object>');
    expect(result.unwrappedContainers).toEqual(['DeferredResult', 'ResponseEntity']);
  });

  it('unwraps Optional<UserDto> to UserDto with isOptional: true', () => {
    const result = unwrapSpringContainer('Optional<com.example.UserDto>');
    expect(result.payloadTypeName).toBe('com.example.UserDto');
    expect(result.isOptional).toBe(true);
    expect(result.isArray).toBe(false);
  });

  it('unwraps wildcard bound ResponseEntity<? extends Device> down to Device', () => {
    const result = unwrapSpringContainer('ResponseEntity<? extends com.thingsboard.Device>');
    expect(result.payloadTypeName).toBe('com.thingsboard.Device');
    expect(result.unwrappedContainers).toEqual(['ResponseEntity']);
    expect(result.isOpaqueContainer).toBe(false);
  });

  it('detects unparameterized/opaque ResponseEntity as isOpaqueContainer: true', () => {
    const result = unwrapSpringContainer('ResponseEntity');
    expect(result.isOpaqueContainer).toBe(true);
  });

  it('detects DeferredResult<ResponseEntity> as isOpaqueContainer: true', () => {
    const result = unwrapSpringContainer('DeferredResult<ResponseEntity>');
    expect(result.isOpaqueContainer).toBe(true);
    expect(result.unwrappedContainers).toEqual(['DeferredResult']);
  });

  it('detects unconstrained wildcard ResponseEntity<?> as isOpaqueContainer: true and isWildcard: true', () => {
    const result = unwrapSpringContainer('ResponseEntity<?>');
    expect(result.isOpaqueContainer).toBe(true);
    expect(result.isWildcard).toBe(true);
  });

  it('unwraps Flux<TelemetryEntry> with isArray: true and isStreamOrFlux: true', () => {
    const result = unwrapSpringContainer('Flux<org.thingsboard.TelemetryEntry>');
    expect(result.payloadTypeName).toBe('org.thingsboard.TelemetryEntry');
    expect(result.isArray).toBe(true);
    expect(result.isStreamOrFlux).toBe(true);
  });

  it('handles fully qualified java package names on containers', () => {
    const result = unwrapSpringContainer('java.util.concurrent.CompletableFuture<org.springframework.http.ResponseEntity<org.thingsboard.Device>>');
    expect(result.payloadTypeName).toBe('org.thingsboard.Device');
    expect(result.unwrappedContainers).toEqual(['CompletableFuture', 'ResponseEntity']);
  });
});
