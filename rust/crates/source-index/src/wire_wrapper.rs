//! Central classification of Java wire wrappers.
//!
//! The Java lane has two consumers of the same knowledge: resolving a declared
//! type into a wire shape, and peeling a return type before comparing it with a
//! declared schema. Keeping the table in one place prevents the two paths from
//! drifting (Micronaut's `HttpResponse<T>` had already been added to one path and
//! not the other).
//!
//! Classification is by simple type name, matching the existing extractor's
//! evidence model. Unknown containers are left untouched; callers resolve them as
//! types and produce an UNKNOWN wire type when that fails, never a silently
//! dropped payload.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapperClass {
    /// The payload is the first type argument (`Mono<T>`, `ResponseEntity<T>`, ...).
    Transparent,
    /// Async stream of values that serializes as a JSON array (`Flux<T>`, `Multi<T>`).
    Stream,
    /// Synchronous collection that serializes as a JSON array.
    Collection,
    /// Spring Data page/slice: an object with `content` plus page metadata.
    Page { slice: bool },
    /// String-keyed map.
    Map,
    /// Spring `MultiValueMap`: object whose values are arrays.
    MultiValueMap,
}

pub fn classify(container_simple: &str) -> Option<WrapperClass> {
    match container_simple {
        "ResponseEntity" | "HttpEntity" | "HttpResponse" | "RestResponse" | "Uni" | "Optional"
        | "DeferredResult" | "CompletableFuture" | "CompletionStage" | "Mono" | "Call"
        | "Observable" | "Maybe" | "Single" | "Flowable" | "Response" => {
            Some(WrapperClass::Transparent)
        }
        "Flux" | "Multi" => Some(WrapperClass::Stream),
        "List"
        | "Set"
        | "Collection"
        | "Iterable"
        | "ArrayList"
        | "LinkedList"
        | "HashSet"
        | "TreeSet"
        | "CopyOnWriteArrayList"
        | "ConcurrentSkipListSet"
        | "LinkedHashSet"
        | "SortedSet"
        | "NavigableSet" => Some(WrapperClass::Collection),
        "Page" | "PageImpl" => Some(WrapperClass::Page { slice: false }),
        "Slice" => Some(WrapperClass::Page { slice: true }),
        "Map" | "HashMap" | "LinkedHashMap" | "TreeMap" | "ConcurrentHashMap" | "ConcurrentMap"
        | "SortedMap" | "NavigableMap" | "EnumMap" | "WeakHashMap" | "IdentityHashMap"
        | "Hashtable" => Some(WrapperClass::Map),
        "MultiValueMap" | "LinkedMultiValueMap" => Some(WrapperClass::MultiValueMap),
        _ => None,
    }
}

/// Split `Container<Arg>` at the first `<` and the final `>`, keeping nested
/// generic arguments intact.
fn split_generic(type_str: &str) -> Option<(&str, &str)> {
    let trimmed = type_str.trim();
    let start = trimmed.find('<')?;
    if !trimmed.ends_with('>') {
        return None;
    }
    let container = trimmed[..start].trim();
    let argument = trimmed[start + 1..trimmed.len() - 1].trim();
    if container.is_empty() {
        return None;
    }
    // An empty argument (`ResponseEntity<>`) still belongs to the wrapper. The
    // historical behavior folds it to an empty payload, which the caller treats
    // as Any rather than as an unresolved concrete type.
    Some((container, argument))
}

/// Peel a declared return type down to its payload for schema comparison.
///
/// This mirrors the historical `unwrap_generic_wrapper` behavior: transparent
/// wrappers peel recursively, stream wrappers become `List<T>`, raw response
/// wrappers become `?`, and every other type is returned unchanged.
pub fn peel_declared_type(type_str: &str) -> Option<String> {
    let trimmed = type_str.trim();
    if let Some((container, argument)) = split_generic(trimmed) {
        let simple = container.rsplit('.').next().unwrap_or(container);
        return match classify(simple) {
            Some(WrapperClass::Transparent) => {
                Some(peel_declared_type(argument).unwrap_or_else(|| argument.to_string()))
            }
            Some(WrapperClass::Stream) => Some(format!(
                "List<{}>",
                peel_declared_type(argument).unwrap_or_else(|| argument.to_string())
            )),
            _ => None,
        };
    }
    let simple = trimmed.rsplit('.').next().unwrap_or(trimmed);
    match simple {
        "ResponseEntity" | "HttpEntity" | "HttpResponse" => Some("?".to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_are_classified_by_payload_shape() {
        assert_eq!(classify("HttpResponse"), Some(WrapperClass::Transparent));
        assert_eq!(classify("Uni"), Some(WrapperClass::Transparent));
        assert_eq!(classify("RestResponse"), Some(WrapperClass::Transparent));
        assert_eq!(classify("CompletionStage"), Some(WrapperClass::Transparent));
        assert_eq!(classify("Multi"), Some(WrapperClass::Stream));
        assert_eq!(classify("Flux"), Some(WrapperClass::Stream));
        assert_eq!(classify("List"), Some(WrapperClass::Collection));
        assert_eq!(classify("Page"), Some(WrapperClass::Page { slice: false }));
        assert_eq!(classify("Slice"), Some(WrapperClass::Page { slice: true }));
        assert_eq!(classify("Map"), Some(WrapperClass::Map));
        assert_eq!(classify("MultiValueMap"), Some(WrapperClass::MultiValueMap));
        assert_eq!(classify("UserDto"), None);
    }

    #[test]
    fn declared_peeling_is_recursive_and_fail_closed() {
        assert_eq!(
            peel_declared_type("ResponseEntity<List<UserDto>>").as_deref(),
            Some("List<UserDto>")
        );
        assert_eq!(
            peel_declared_type("Uni<RestResponse<UserDto>>").as_deref(),
            Some("UserDto")
        );
        assert_eq!(
            peel_declared_type("Multi<UserDto>").as_deref(),
            Some("List<UserDto>")
        );
        assert_eq!(
            peel_declared_type("ResponseEntity<Object>").as_deref(),
            Some("Object")
        );
        assert_eq!(peel_declared_type("ResponseEntity<>").as_deref(), Some(""));
        assert_eq!(peel_declared_type("ResponseEntity").as_deref(), Some("?"));
        assert_eq!(peel_declared_type("Page<UserDto>"), None);
        assert_eq!(peel_declared_type("Map<String, UserDto>"), None);
        assert_eq!(peel_declared_type("UserDto"), None);
    }
}
