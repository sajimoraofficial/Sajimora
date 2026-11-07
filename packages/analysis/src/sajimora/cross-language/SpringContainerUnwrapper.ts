/**
 * SpringContainerUnwrapper.ts
 *
 * Recursively unwraps Spring and Java container types into their canonical
 * underlying payload types:
 *   - ResponseEntity<T>, HttpEntity<T> -> T
 *   - Optional<T> -> T (marked nullable/optional)
 *   - CompletableFuture<T>, Callable<T> -> T
 *   - List<T>, Collection<T>, Set<T>, Iterable<T> -> Array<T>
 *   - Mono<T> -> T
 *   - Flux<T> -> Array<T> (with isStreamOrFlux = true)
 *
 * Example:
 *   ResponseEntity<List<UserDto>> -> Array<UserDto>
 */

export interface UnwrappedTypeResult {
  /** The core payload type name (e.g. "UserDto", "String", "int"). */
  readonly payloadTypeName: string;
  /** Whether the container indicates an array/collection shape. */
  readonly isArray: boolean;
  /** Whether the container originated from a reactive Flux or stream. */
  readonly isStreamOrFlux: boolean;
  /** Whether the container was Optional (indicating potential absence). */
  readonly isOptional: boolean;
  /** Whether the container was an unparameterized/opaque container (e.g. raw ResponseEntity or Response). */
  readonly isOpaqueContainer: boolean;
  /** Whether the payload was a wildcard (e.g. ?). */
  readonly isWildcard: boolean;
  /** Chain of unwrapped container names (e.g. ["CompletableFuture", "ResponseEntity", "List"]). */
  readonly unwrappedContainers: readonly string[];
}

const SINGLETON_CONTAINERS = new Set([
  'ResponseEntity',
  'HttpEntity',
  'Optional',
  'CompletableFuture',
  'CompletionStage',
  'DeferredResult',
  'Callable',
  'Mono',
  'Response',
]);

const COLLECTION_CONTAINERS = new Set([
  'List',
  'Collection',
  'Set',
  'Iterable',
  'ArrayList',
  'LinkedList',
  'HashSet',
  'TreeSet',
]);

const STREAM_CONTAINERS = new Set([
  'Flux',
  'Stream',
]);

/**
 * Parse a generic Java type string recursively:
 * e.g. "CompletableFuture<ResponseEntity<List<com.example.UserDto>>>"
 */
export function unwrapSpringContainer(rawTypeDisplay: string): UnwrappedTypeResult {
  let current = rawTypeDisplay.trim();
  let isArray = false;
  let isStreamOrFlux = false;
  let isOptional = false;
  let isWildcard = false;
  const unwrappedContainers: string[] = [];

  // Strip array suffix: e.g. "UserDto[]"
  while (current.endsWith('[]')) {
    isArray = true;
    current = current.slice(0, -2).trim();
  }

  let progressed = true;
  while (progressed) {
    progressed = false;

    // Match Container<Arg> with support for nested brackets
    // e.g. "CompletableFuture<ResponseEntity<Device>>"
    const match = current.match(/^([a-zA-Z0-9_$.]+)<([\s\S]+)>$/);
    if (!match) break;

    const fullContainer = match[1];
    let typeArg = match[2].trim();
    const containerSimple = fullContainer.split('.').pop() ?? fullContainer;

    // Handle wildcard bounds: ? extends T -> T, ? super T -> T
    if (/^\?\s+extends\s+/.test(typeArg)) {
      typeArg = typeArg.replace(/^\?\s+extends\s+/, '').trim();
    } else if (/^\?\s+super\s+/.test(typeArg)) {
      typeArg = typeArg.replace(/^\?\s+super\s+/, '').trim();
    } else if (typeArg === '?') {
      isWildcard = true;
    }

    if (SINGLETON_CONTAINERS.has(containerSimple)) {
      unwrappedContainers.push(containerSimple);
      if (containerSimple === 'Optional') {
        isOptional = true;
      }
      current = typeArg;
      progressed = true;
    } else if (COLLECTION_CONTAINERS.has(containerSimple)) {
      unwrappedContainers.push(containerSimple);
      isArray = true;
      current = typeArg;
      progressed = true;
    } else if (STREAM_CONTAINERS.has(containerSimple)) {
      unwrappedContainers.push(containerSimple);
      isArray = true;
      isStreamOrFlux = true;
      current = typeArg;
      progressed = true;
    }
  }

  // Final check for trailing [] on the inner type
  while (current.endsWith('[]')) {
    isArray = true;
    current = current.slice(0, -2).trim();
  }

  // Detect opaque raw container if current is itself a container name without arguments
  const currentSimple = current.split('.').pop() ?? current;
  const isOpaqueContainer = (
    currentSimple === 'ResponseEntity' ||
    currentSimple === 'HttpEntity' ||
    currentSimple === 'Response' ||
    currentSimple === 'DeferredResult' ||
    currentSimple === 'CompletableFuture' ||
    isWildcard
  );

  return {
    payloadTypeName: current,
    isArray,
    isStreamOrFlux,
    isOptional,
    isOpaqueContainer,
    isWildcard,
    unwrappedContainers,
  };
}
