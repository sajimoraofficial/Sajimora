//! routes.rs -- Route normalization, matching, and endpoint key building.
//!
//! Exact port of EndpointIdentity.ts.
//! - normalizeRouteSegments: Spring {id}, {id:regex}, TS ${id}, wildcards *, **
//! - matchRoutes: positional parameter match, wildcard handling, constraint checks
//! - buildEndpointKey: SERVICE\0METHOD\0SEGMENTS\0DIRECTION
//! - combineSpringRoutes: class prefix + method route

use crate::ir::{
    ContractDirection, EndpointIdentityContract, NormalizedRouteContract, RouteSegmentContract,
};

// ---------------------------------------------------------------------------
// normalizeRouteSegments -- mirrors EndpointIdentity.ts:normalizeRouteSegments
// ---------------------------------------------------------------------------

/// Parse and normalize a raw route path into canonical RouteSegmentContract[].
/// Supports Spring {id}, {id:regex}, TS ${expr}, and wildcards * / **.
pub fn normalize_route_segments(path: &str) -> NormalizedRouteContract {
    // Strip scheme+authority (http://host/...) to get just the path
    let pathname = strip_authority(path);
    // Collapse duplicate slashes, strip trailing slash
    let cleaned = normalize_slashes(pathname);

    if cleaned == "/" || cleaned.is_empty() {
        return NormalizedRouteContract {
            raw_path: path.to_string(),
            segments: vec![],
        };
    }

    // Split unconditionally: a route without a leading slash keeps its first segment. The empty
    // part produced by a leading slash is skipped with the rest below.
    let parts: Vec<&str> = cleaned.split('/').collect();

    let mut segments: Vec<RouteSegmentContract> = Vec::new();
    let mut param_idx: u32 = 0;

    for part in &parts {
        if part.is_empty() {
            continue;
        }
        // Spring path parameter: {id} or {id:[0-9]+}
        if let Some(seg) = try_spring_param(part, &mut param_idx) {
            segments.push(seg);
            continue;
        }
        // TS template literal parameter: ${id}
        if let Some(seg) = try_ts_param(part, &mut param_idx) {
            segments.push(seg);
            continue;
        }
        // Placeholder parameter written by the TypeScript extractor for an interpolation it
        // could not resolve (`:param`), or named by the client itself (`:id`).
        if let Some(seg) = try_placeholder_param(part, &mut param_idx) {
            segments.push(seg);
            continue;
        }
        // Wildcard
        if *part == "*" || *part == "**" {
            segments.push(RouteSegmentContract {
                text: part.to_string(),
                is_param: false,
                param_index: None,
                param_name: None,
                regex_constraint: None,
                is_wildcard: Some(true),
            });
            continue;
        }
        // Static segment
        segments.push(RouteSegmentContract {
            text: part.to_string(),
            is_param: false,
            param_index: None,
            param_name: None,
            regex_constraint: None,
            is_wildcard: None,
        });
    }

    NormalizedRouteContract {
        raw_path: path.to_string(),
        segments,
    }
}

fn strip_authority(path: &str) -> &str {
    // Only strip leading scheme://host if anchored at the start
    let bytes = path.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return path;
    }

    if let Some(scheme_end) = path.find("://") {
        let scheme = &path[..scheme_end];
        // Valid RFC 3986 URI scheme: starts with letter, followed by letters, digits, '+', '-', '.'
        // and cannot contain slashes or query characters
        if scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        {
            let rest = &path[scheme_end + 3..];
            if let Some(slash_pos) = rest.find('/') {
                return &rest[slash_pos..];
            }
            return "/";
        }
    }
    path
}

fn normalize_slashes(s: &str) -> String {
    // Replace multiple consecutive slashes with one, strip trailing slash
    let mut result = String::new();
    let mut prev_slash = false;
    for ch in s.chars() {
        if ch == '/' {
            if !prev_slash {
                result.push(ch);
            }
            prev_slash = true;
        } else {
            result.push(ch);
            prev_slash = false;
        }
    }
    // Strip trailing slash unless root
    if result.len() > 1 && result.ends_with('/') {
        result.pop();
    }
    if result.is_empty() {
        "/".to_string()
    } else {
        result
    }
}

fn try_spring_param(part: &str, param_idx: &mut u32) -> Option<RouteSegmentContract> {
    // Matches {id} or {id:regex}
    if !part.starts_with('{') || !part.ends_with('}') {
        return None;
    }
    let inner = &part[1..part.len() - 1];
    // Must start with an identifier char
    let colon_pos = inner.find(':');
    let (name_part, regex_part) = if let Some(pos) = colon_pos {
        (&inner[..pos], Some(inner[pos + 1..].trim()))
    } else {
        (inner, None)
    };
    // Validate name is alphanumeric/underscore/dollar
    if !name_part
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        || name_part.is_empty()
    {
        return None;
    }
    let idx = *param_idx;
    *param_idx += 1;
    Some(RouteSegmentContract {
        text: format!("{{{idx}}}"),
        is_param: true,
        param_index: Some(idx),
        param_name: Some(name_part.to_string()),
        regex_constraint: regex_part.filter(|s| !s.is_empty()).map(|s| s.to_string()),
        is_wildcard: None,
    })
}

fn try_ts_param(part: &str, param_idx: &mut u32) -> Option<RouteSegmentContract> {
    // Matches ${expr}
    if !part.starts_with("${") || !part.ends_with('}') {
        return None;
    }
    let expr = part[2..part.len() - 1].trim().to_string();
    let idx = *param_idx;
    *param_idx += 1;
    Some(RouteSegmentContract {
        text: format!("{{{idx}}}"),
        is_param: true,
        param_index: Some(idx),
        param_name: Some(expr),
        regex_constraint: None,
        is_wildcard: None,
    })
}

fn try_placeholder_param(part: &str, param_idx: &mut u32) -> Option<RouteSegmentContract> {
    // Matches the colon-parameter form used by Express-style clients and by the
    // TypeScript extractor's unresolved-interpolation placeholder: `:id`, `:param`.
    // The colon must open the segment and the rest must be a single identifier, so
    // segments like `foo:read` or `:` stay static.
    let name = part.strip_prefix(':')?;
    if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    {
        return None;
    }
    let idx = *param_idx;
    *param_idx += 1;
    Some(RouteSegmentContract {
        text: format!("{{{idx}}}"),
        is_param: true,
        param_index: Some(idx),
        param_name: Some(name.to_string()),
        regex_constraint: None,
        is_wildcard: None,
    })
}

// ---------------------------------------------------------------------------
// combineSpringRoutes
// ---------------------------------------------------------------------------

pub fn combine_spring_routes(class_prefix: Option<&str>, method_route: &str) -> String {
    let prefix = class_prefix.unwrap_or("");
    if prefix.is_empty() || prefix == "/" {
        let combined = format!("/{}", method_route);
        return normalize_slashes(&combined)
            .trim_end_matches('/')
            .to_string()
            .if_empty_then("/");
    }
    let p = if prefix.starts_with('/') {
        prefix.to_string()
    } else {
        format!("/{}", prefix)
    };
    let s = if method_route.starts_with('/') {
        method_route.to_string()
    } else {
        format!("/{}", method_route)
    };
    let combined = normalize_slashes(&format!("{}{}", p, s));
    if combined.len() > 1 && combined.ends_with('/') {
        combined[..combined.len() - 1].to_string()
    } else {
        combined
    }
}

trait IfEmptyThen {
    fn if_empty_then(self, fallback: &str) -> String;
}
impl IfEmptyThen for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

// ---------------------------------------------------------------------------
// matchRoutes -- mirrors EndpointIdentity.ts:matchRoutes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RouteMatchResult {
    pub matches: bool,
    pub constraint_mismatch: Option<String>,
}

pub fn match_routes(
    route_a: &NormalizedRouteContract,
    route_b: &NormalizedRouteContract,
) -> RouteMatchResult {
    if route_a.raw_path == "<dynamic>" || route_b.raw_path == "<dynamic>" {
        return RouteMatchResult {
            matches: false,
            constraint_mismatch: None,
        };
    }
    let segs_a = &route_a.segments;
    let segs_b = &route_b.segments;
    let mut i = 0usize;
    let mut j = 0usize;

    while i < segs_a.len() && j < segs_b.len() {
        let a = &segs_a[i];
        let b = &segs_b[j];

        if a.text == "**" || b.text == "**" {
            return RouteMatchResult {
                matches: true,
                constraint_mismatch: None,
            };
        }
        if a.is_wildcard.unwrap_or(false) || b.is_wildcard.unwrap_or(false) {
            i += 1;
            j += 1;
            continue;
        }
        if a.is_param && b.is_param {
            if let (Some(rc_a), Some(rc_b)) = (&a.regex_constraint, &b.regex_constraint) {
                if rc_a != rc_b {
                    return RouteMatchResult {
                        matches: false,
                        constraint_mismatch: Some(format!(
                            "Constraint mismatch between {} and {}",
                            rc_a, rc_b
                        )),
                    };
                }
            }
            i += 1;
            j += 1;
            continue;
        }
        if a.is_param != b.is_param {
            return RouteMatchResult {
                matches: false,
                constraint_mismatch: None,
            };
        }
        if a.text != b.text {
            return RouteMatchResult {
                matches: false,
                constraint_mismatch: None,
            };
        }
        i += 1;
        j += 1;
    }

    if i == segs_a.len() && j == segs_b.len() {
        RouteMatchResult {
            matches: true,
            constraint_mismatch: None,
        }
    } else {
        RouteMatchResult {
            matches: false,
            constraint_mismatch: None,
        }
    }
}

// ---------------------------------------------------------------------------
// buildEndpointKey -- mirrors EndpointIdentity.ts:buildEndpointKey
// Format: "SERVICE\0METHOD\0SEGMENTS\0DIRECTION"
// ---------------------------------------------------------------------------

pub fn build_endpoint_key(identity: &EndpointIdentityContract) -> String {
    let seg_str = identity
        .normalized_route
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("/");
    let service = identity.service.as_deref().unwrap_or("");
    let direction = match identity.direction {
        ContractDirection::Request => "REQUEST",
        ContractDirection::Response => "RESPONSE",
    };
    format!(
        "{}\0{}\0{}\0{}",
        service,
        identity.http_method.to_uppercase(),
        seg_str,
        direction
    )
}

// ---------------------------------------------------------------------------
// route_key for comparison engine (mirrors ArtifactComparisonEngine.routeKey)
// Uses canonical_json of [service, method, [[text, regex, is_wildcard], ...]]
// ---------------------------------------------------------------------------

pub fn route_key_for_endpoint(ep: &crate::ir::EndpointContract) -> String {
    use crate::canonical::canonical_json;
    use serde_json::{json, Value};
    let route = normalize_route_segments(&ep.identity.normalized_route.raw_path);
    let segments: Vec<Value> = route
        .segments
        .iter()
        .map(|s| {
            json!([
                s.text,
                s.regex_constraint
                    .as_ref()
                    .map(|v| Value::String(v.clone()))
                    .unwrap_or(Value::Null),
                s.is_wildcard.unwrap_or(false)
            ])
        })
        .collect();
    let v = json!([ep.identity.service, ep.identity.http_method, segments]);
    canonical_json(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_routes_never_match_concrete_or_dynamic_routes() {
        let unknown = normalize_route_segments("<dynamic>");
        for path in ["/", "/**", "<dynamic>"] {
            assert!(!match_routes(&unknown, &normalize_route_segments(path)).matches);
            assert!(!match_routes(&normalize_route_segments(path), &unknown).matches);
        }
        assert!(
            match_routes(
                &normalize_route_segments("/"),
                &normalize_route_segments("/")
            )
            .matches
        );
    }

    #[test]
    fn normalize_static_path() {
        let r = normalize_route_segments("/api/users");
        assert_eq!(r.segments.len(), 2);
        assert_eq!(r.segments[0].text, "api");
        assert_eq!(r.segments[1].text, "users");
    }

    #[test]
    fn normalize_spring_param() {
        let r = normalize_route_segments("/api/users/{id}");
        assert_eq!(r.segments[2].text, "{0}");
        assert!(r.segments[2].is_param);
        assert_eq!(r.segments[2].param_name.as_deref(), Some("id"));
    }

    #[test]
    fn normalize_spring_param_with_regex() {
        let r = normalize_route_segments("/api/users/{id:[0-9]+}");
        assert_eq!(r.segments[2].regex_constraint.as_deref(), Some("[0-9]+"));
    }

    #[test]
    fn normalize_wildcard() {
        let r = normalize_route_segments("/api/files/*");
        assert!(r.segments[2].is_wildcard.unwrap_or(false));
    }

    #[test]
    fn normalize_double_wildcard() {
        let r = normalize_route_segments("/api/**");
        assert_eq!(r.segments[1].text, "**");
    }

    #[test]
    fn normalize_root() {
        let r = normalize_route_segments("/");
        assert_eq!(r.segments.len(), 0);
    }

    #[test]
    fn match_identical_static() {
        let a = normalize_route_segments("/api/users");
        let b = normalize_route_segments("/api/users");
        assert!(match_routes(&a, &b).matches);
    }

    #[test]
    fn match_params_positional() {
        let a = normalize_route_segments("/api/users/{id}");
        let b = normalize_route_segments("/api/users/{userId}");
        assert!(match_routes(&a, &b).matches);
    }

    #[test]
    fn no_match_different_static() {
        let a = normalize_route_segments("/api/users");
        let b = normalize_route_segments("/api/items");
        assert!(!match_routes(&a, &b).matches);
    }

    #[test]
    fn no_match_different_segment_count() {
        let a = normalize_route_segments("/api/users");
        let b = normalize_route_segments("/api/users/list");
        assert!(!match_routes(&a, &b).matches);
    }

    #[test]
    fn double_wildcard_matches_remaining() {
        let a = normalize_route_segments("/api/**");
        let b = normalize_route_segments("/api/users/123/profile");
        assert!(match_routes(&a, &b).matches);
    }

    #[test]
    fn a_route_without_a_leading_slash_keeps_every_segment() {
        // The comparison engine re-normalizes a producer route with its `/api` prefix removed.
        // Dropping the first segment there turns `/apiTrendz/**` into a bare `**`, which matches
        // every consumer route in the repository.
        let r = normalize_route_segments("Trendz/**");
        assert_eq!(
            r.segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Trendz", "**"]
        );
    }

    #[test]
    fn a_wildcard_proxy_route_does_not_match_an_unrelated_path() {
        let consumer = normalize_route_segments("/api/ruleChain/{id}");
        let stripped_proxy = normalize_route_segments("Trendz/**");
        assert!(
            !match_routes(&consumer, &stripped_proxy).matches,
            "only a path under the proxy prefix may pair with it"
        );
        let under_proxy = normalize_route_segments("Trendz/alarm/list");
        assert!(match_routes(&under_proxy, &stripped_proxy).matches);
        let full = normalize_route_segments("/apiTrendz/**");
        let under_full = normalize_route_segments("/apiTrendz/alarm/list");
        assert!(match_routes(&under_full, &full).matches);
    }

    #[test]
    fn strip_authority_anchored_scheme() {
        assert_eq!(
            strip_authority("https://cdn.example.com/api/users"),
            "/api/users"
        );
        assert_eq!(strip_authority("http://localhost:8080/"), "/");
        assert_eq!(strip_authority("http://localhost:8080"), "/");
        assert_eq!(
            strip_authority("/redirect?to=https://cdn"),
            "/redirect?to=https://cdn"
        );
        assert_eq!(
            strip_authority("/api/v1/proxy/http://other/path"),
            "/api/v1/proxy/http://other/path"
        );
    }

    #[test]
    fn normalize_colon_placeholder_param() {
        let r = normalize_route_segments("/api/orders/:param/items");
        assert_eq!(r.segments[2].text, "{0}");
        assert!(r.segments[2].is_param);
        assert_eq!(r.segments[2].param_name.as_deref(), Some("param"));
        assert_eq!(r.segments[3].text, "items");
        assert!(!r.segments[3].is_param);
    }

    #[test]
    fn colon_param_links_to_spring_param_of_any_name() {
        for consumer in ["/api/orders/:param", "/api/orders/:id"] {
            let a = normalize_route_segments(consumer);
            for producer in ["/api/orders/{id}", "/api/orders/{orderId}"] {
                assert!(
                    match_routes(&a, &normalize_route_segments(producer)).matches,
                    "{consumer} should link to {producer}"
                );
            }
        }
    }

    #[test]
    fn colon_param_gets_the_same_canonical_text_as_spring_param_at_that_position() {
        let consumer = normalize_route_segments("/api/orders/:param/items/:param");
        let producer = normalize_route_segments("/api/orders/{id}/items/{sku}");
        assert_eq!(
            consumer
                .segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            producer
                .segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn colon_param_does_not_widen_matching_to_static_segments() {
        // A placeholder is a variable, not a wildcard: it must not link to a literal.
        let p = normalize_route_segments("/api/orders/{id}");
        assert!(!match_routes(&normalize_route_segments("/api/orders/mine"), &p).matches);
        assert!(!match_routes(&normalize_route_segments("/api/orders/:param/extra"), &p).matches);
    }

    #[test]
    fn colon_outside_segment_start_stays_static() {
        for part in ["foo:read", ":", ":1order", "a:b:c", "1param"] {
            let r = normalize_route_segments(&format!("/api/{part}"));
            assert!(
                !r.segments[1].is_param,
                "{part} must remain a literal segment"
            );
            assert_eq!(r.segments[1].text, part);
        }
    }
}

// ---------------------------------------------------------------------------
// Lexicographic Route Specificity Engine (Phase 1/Route Matching Contract)
//
// Replaces additive weighted sum with strict positional, segment-by-segment
// lexicographic comparison, matching framework semantics (Spring PathPatternParser,
// RFC 6570 URI Templates).
// ---------------------------------------------------------------------------

/// Five specificity tiers for route segments, ordered low → high.
/// The higher the tier, the more specific the segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SegmentTier {
    /// `**` — matches zero or more path segments.
    MultiWildcard = 1,
    /// `*` — matches exactly one path segment.
    SingleWildcard = 2,
    /// `{id}`, `${id}` — unconstrained path variable.
    Variable = 3,
    /// `{id:[0-9]+}` — regex-constrained path variable.
    RegexVariable = 4,
    /// `orders`, `api`, `export` — exact literal segment.
    Literal = 5,
}

/// Outcome of a specificity comparison between two candidate templates
/// for a given concrete path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecificityOrdering {
    RouteAWins,
    RouteBWins,
    /// Two templates match with identical specificity — must be rejected as ambiguous.
    AmbiguousTie,
}

/// Outcome of matching a concrete path against a catalog of route templates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConcreteMatchOutcome {
    /// Unambiguously matched to exactly one route template.
    Matched(String), // canonical route template string
    /// Matched more than one template with equal specificity — marked untracked.
    AmbiguousCollision { candidates: Vec<String> },
    /// No template in the catalog matched the concrete path.
    NoMatch,
}

/// Returns the `SegmentTier` for a single `RouteSegmentContract`.
pub fn get_segment_tier(seg: &RouteSegmentContract) -> SegmentTier {
    if seg.text == "**" {
        SegmentTier::MultiWildcard
    } else if seg.is_wildcard.unwrap_or(false) {
        SegmentTier::SingleWildcard
    } else if seg.is_param {
        if seg.regex_constraint.is_some() {
            SegmentTier::RegexVariable
        } else {
            SegmentTier::Variable
        }
    } else {
        SegmentTier::Literal
    }
}

/// Compare two route templates for a given concrete concrete path segments.
///
/// Uses strict **left-to-right lexicographic ordering** by `SegmentTier`.
/// If tiers are equal at every position and both templates have the same length,
/// returns `AmbiguousTie`.
///
/// For `RegexVariable` segments with different regex constraints that both
/// successfully match the same concrete segment, returns `AmbiguousTie`
/// (non-comparable — different regexes, same position).
pub fn compare_route_specificity(
    route_a: &NormalizedRouteContract,
    route_b: &NormalizedRouteContract,
    concrete_segments: &[&str],
) -> SpecificityOrdering {
    let segs_a = &route_a.segments;
    let segs_b = &route_b.segments;

    let min_len = segs_a.len().min(segs_b.len()).min(concrete_segments.len());

    for i in 0..min_len {
        let tier_a = get_segment_tier(&segs_a[i]);
        let tier_b = get_segment_tier(&segs_b[i]);

        // Multi-wildcard in A means A is less specific — B wins (unless B is also **)
        if tier_a == SegmentTier::MultiWildcard && tier_b == SegmentTier::MultiWildcard {
            break; // tie on this prefix, fall through to length comparison
        }
        if tier_a == SegmentTier::MultiWildcard {
            return SpecificityOrdering::RouteBWins;
        }
        if tier_b == SegmentTier::MultiWildcard {
            return SpecificityOrdering::RouteAWins;
        }

        if tier_a > tier_b {
            return SpecificityOrdering::RouteAWins;
        } else if tier_b > tier_a {
            return SpecificityOrdering::RouteBWins;
        }

        // Same tier: apply intra-tier tiebreaking
        if tier_a == SegmentTier::Literal {
            // Both literal: they must be identical (otherwise they wouldn't both match)
            // If they differ, something is wrong; treat as ambiguous.
            if segs_a[i].text != segs_b[i].text {
                return SpecificityOrdering::AmbiguousTie;
            }
        }

        if tier_a == SegmentTier::RegexVariable {
            let re_a = segs_a[i].regex_constraint.as_deref().unwrap_or("");
            let re_b = segs_b[i].regex_constraint.as_deref().unwrap_or("");
            if re_a != re_b {
                // Different regex patterns at the same position matching the same
                // concrete segment → non-comparable; caller must treat as ambiguous.
                return SpecificityOrdering::AmbiguousTie;
            }
        }
        // Same tier and same content at this position: continue to next segment.
    }

    // Common prefix identical up to min_len.
    // A route without trailing wildcard is more specific than one with **.
    let ends_multi_a = segs_a.last().map(|s| s.text == "**").unwrap_or(false);
    let ends_multi_b = segs_b.last().map(|s| s.text == "**").unwrap_or(false);

    match (ends_multi_a, ends_multi_b) {
        (false, true) => SpecificityOrdering::RouteAWins,
        (true, false) => SpecificityOrdering::RouteBWins,
        (false, false) if segs_a.len() == segs_b.len() => SpecificityOrdering::AmbiguousTie,
        (false, false) => {
            // Different lengths without trailing wildcard → cannot both match (route_matches
            // would have returned false); treat as no-tie, longer wins (more specific).
            if segs_a.len() > segs_b.len() {
                SpecificityOrdering::RouteAWins
            } else {
                SpecificityOrdering::RouteBWins
            }
        }
        (true, true) => SpecificityOrdering::AmbiguousTie,
    }
}

/// Match a concrete request path against a catalog of normalized route templates.
///
/// ## Semantics
/// 1. Strip query string (`?...`) and trailing slash (unless root `/`).
/// 2. For each template in `catalog`, test whether it matches the concrete path
///    using `match_routes`.
/// 3. Among all matching templates, select the winner via lexicographic
///    `compare_route_specificity`.
/// 4. If two or more templates tie, return `AmbiguousCollision` (fail-closed).
///
/// ## Returns
/// `ConcreteMatchOutcome::Matched(template)` | `AmbiguousCollision` | `NoMatch`.
pub fn match_concrete_path_to_template<'a>(
    concrete_path: &str,
    catalog: &'a [NormalizedRouteContract],
) -> ConcreteMatchOutcome {
    // Canonicalize: strip query string, trailing slash
    let canonical = canonicalize_concrete_path(concrete_path);
    let concrete_norm = normalize_route_segments(&canonical);
    let concrete_segs: Vec<&str> = concrete_norm
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect();

    // Collect all matching templates
    let mut matches: Vec<&NormalizedRouteContract> = catalog
        .iter()
        .filter(|tmpl| template_matches_concrete(tmpl, &concrete_segs))
        .collect();

    if matches.is_empty() {
        return ConcreteMatchOutcome::NoMatch;
    }
    if matches.len() == 1 {
        return ConcreteMatchOutcome::Matched(matches[0].raw_path.clone());
    }

    // Multiple candidates: determine winner by lexicographic specificity.
    matches.sort_by(|a, b| {
        match compare_route_specificity(a, b, &concrete_segs) {
            SpecificityOrdering::RouteAWins => std::cmp::Ordering::Less, // a before b = a wins
            SpecificityOrdering::RouteBWins => std::cmp::Ordering::Greater,
            SpecificityOrdering::AmbiguousTie => std::cmp::Ordering::Equal,
        }
    });

    // Check if top candidate is unambiguously ahead of second place
    let best = matches[0];
    let second = matches[1];
    match compare_route_specificity(best, second, &concrete_segs) {
        SpecificityOrdering::RouteAWins => ConcreteMatchOutcome::Matched(best.raw_path.clone()),
        _ => {
            // Tie at the top → ambiguous collision
            let candidates = matches
                .iter()
                .take_while(|t| {
                    ***t == *best
                        || matches!(
                            compare_route_specificity(best, t, &concrete_segs),
                            SpecificityOrdering::AmbiguousTie
                        )
                })
                .map(|t| t.raw_path.clone())
                .collect();
            ConcreteMatchOutcome::AmbiguousCollision { candidates }
        }
    }
}

/// Strip query string and normalize trailing slash from a concrete request path.
pub fn canonicalize_concrete_path(path: &str) -> String {
    // Remove query string
    let path = path.split('?').next().unwrap_or(path);
    // Strip trailing slash unless root
    let path = if path.len() > 1 && path.ends_with('/') {
        &path[..path.len() - 1]
    } else {
        path
    };
    path.to_string()
}

/// Test whether a single normalized route template matches concrete request path segments.
pub fn template_matches_concrete(tmpl: &NormalizedRouteContract, concrete_segs: &[&str]) -> bool {
    let segs = &tmpl.segments;
    let mut i = 0usize;
    let mut j = 0usize;

    while i < segs.len() && j < concrete_segs.len() {
        let s = &segs[i];
        let c = concrete_segs[j];

        if s.text == "**" {
            return true;
        }
        if s.text == "*" || s.is_wildcard.unwrap_or(false) {
            i += 1;
            j += 1;
            continue;
        }
        if s.is_param {
            if let Some(ref re) = s.regex_constraint {
                if !matches_regex_constraint(re, c) {
                    return false;
                }
            }
            i += 1;
            j += 1;
            continue;
        }
        if s.text != c {
            return false;
        }
        i += 1;
        j += 1;
    }

    if i == segs.len() && j == concrete_segs.len() {
        true
    } else if i < segs.len() && segs[i].text == "**" && i == segs.len() - 1 {
        true
    } else {
        false
    }
}

fn matches_regex_constraint(pattern: &str, text: &str) -> bool {
    if pattern == "[0-9]+" || pattern == "\\d+" {
        !text.is_empty() && text.chars().all(|c| c.is_ascii_digit())
    } else if pattern == "[a-zA-Z]+" {
        !text.is_empty() && text.chars().all(|c| c.is_ascii_alphabetic())
    } else {
        !text.is_empty()
    }
}

#[cfg(test)]
mod specificity_tests {
    use super::*;

    fn route(path: &str) -> NormalizedRouteContract {
        normalize_route_segments(path)
    }

    fn segs(path: &str) -> Vec<String> {
        normalize_route_segments(path)
            .segments
            .into_iter()
            .map(|s| s.text)
            .collect()
    }

    // Helper: collect &str refs from owned Strings
    fn segs_ref<'a>(v: &'a [String]) -> Vec<&'a str> {
        v.iter().map(|s| s.as_str()).collect()
    }

    // -----------------------------------------------------------------------
    // TM-05: Literal-over-param precedence
    // -----------------------------------------------------------------------

    #[test]
    fn test_literal_route_precedence_over_param() {
        // /api/orders/export must win over /api/orders/{id}
        let export_route = route("/api/orders/export");
        let id_route = route("/api/orders/{id}");
        let concrete = segs("/api/orders/export");
        let result = compare_route_specificity(&export_route, &id_route, &segs_ref(&concrete));
        assert_eq!(
            result,
            SpecificityOrdering::RouteAWins,
            "Literal segment 'export' must beat unconstrained param '{{id}}'"
        );
    }

    #[test]
    fn test_param_precedence_over_wildcard() {
        let param_route = route("/api/items/{id}");
        let wildcard_route = route("/api/items/*");
        let concrete = segs("/api/items/42");
        let result = compare_route_specificity(&param_route, &wildcard_route, &segs_ref(&concrete));
        assert_eq!(
            result,
            SpecificityOrdering::RouteAWins,
            "Unconstrained param '{{id}}' must beat single wildcard '*'"
        );
    }

    #[test]
    fn test_regex_param_precedence_over_unconstrained_param() {
        let regex_route = route("/api/users/{id:[0-9]+}");
        let plain_route = route("/api/users/{id}");
        let concrete = segs("/api/users/42");
        let result = compare_route_specificity(&regex_route, &plain_route, &segs_ref(&concrete));
        assert_eq!(
            result,
            SpecificityOrdering::RouteAWins,
            "Regex-constrained param '{{id:[0-9]+}}' must beat unconstrained '{{id}}'"
        );
    }

    // -----------------------------------------------------------------------
    // TM-06: Ambiguous collision (same-tier params at same position)
    // -----------------------------------------------------------------------

    #[test]
    fn test_ambiguous_params_marked_untracked() {
        // /api/items/{id} and /api/items/{slug} have identical specificity
        let id_route = route("/api/items/{id}");
        let slug_route = route("/api/items/{slug}");
        let concrete = segs("/api/items/widget");
        let result = compare_route_specificity(&id_route, &slug_route, &segs_ref(&concrete));
        assert_eq!(
            result,
            SpecificityOrdering::AmbiguousTie,
            "Two unconstrained params at the same segment position must produce AmbiguousTie"
        );
    }

    #[test]
    fn test_different_regex_params_at_same_position_are_ambiguous() {
        // {id:[0-9]+} vs {slug:[a-z]+}: different regexes at the same position
        let num_route = route("/api/users/{id:[0-9]+}");
        let slug_route = route("/api/users/{slug:[a-z]+}");
        let concrete = segs("/api/users/42");
        let result = compare_route_specificity(&num_route, &slug_route, &segs_ref(&concrete));
        assert_eq!(
            result,
            SpecificityOrdering::AmbiguousTie,
            "Different regex constraints at same position must produce AmbiguousTie"
        );
    }

    // -----------------------------------------------------------------------
    // match_concrete_path_to_template end-to-end
    // -----------------------------------------------------------------------

    #[test]
    fn test_match_concrete_literal_wins_over_param() {
        let catalog = vec![route("/api/orders/{id}"), route("/api/orders/export")];
        let result = match_concrete_path_to_template("/api/orders/export", &catalog);
        assert_eq!(
            result,
            ConcreteMatchOutcome::Matched("/api/orders/export".to_string()),
            "Concrete literal path must match the literal template, not the param template"
        );
    }

    #[test]
    fn test_match_me_not_confused_with_id_param() {
        // Classic /api/users/me vs /api/users/{id}
        let catalog = vec![route("/api/users/{id}"), route("/api/users/me")];
        let result = match_concrete_path_to_template("/api/users/me", &catalog);
        assert_eq!(
            result,
            ConcreteMatchOutcome::Matched("/api/users/me".to_string()),
            "/api/users/me must not be conflated with /api/users/{{id}}"
        );
    }

    #[test]
    fn test_ambiguous_collision_fails_closed() {
        let catalog = vec![route("/api/items/{id}"), route("/api/items/{code}")];
        let result = match_concrete_path_to_template("/api/items/widget", &catalog);
        assert!(
            matches!(result, ConcreteMatchOutcome::AmbiguousCollision { .. }),
            "Two unconstrained params at the same position must produce AmbiguousCollision"
        );
    }

    #[test]
    fn test_query_string_stripped_before_matching() {
        let catalog = vec![route("/api/orders")];
        let result = match_concrete_path_to_template("/api/orders?page=2&sort=asc", &catalog);
        assert_eq!(
            result,
            ConcreteMatchOutcome::Matched("/api/orders".to_string()),
            "Query string must be stripped before template matching"
        );
    }

    #[test]
    fn test_trailing_slash_normalized_before_matching() {
        let catalog = vec![route("/api/orders")];
        let result = match_concrete_path_to_template("/api/orders/", &catalog);
        assert_eq!(
            result,
            ConcreteMatchOutcome::Matched("/api/orders".to_string()),
            "Trailing slash must be stripped before template matching"
        );
    }

    #[test]
    fn test_double_wildcard_less_specific_than_literal() {
        let catalog = vec![route("/api/**"), route("/api/admin/dashboard")];
        let result = match_concrete_path_to_template("/api/admin/dashboard", &catalog);
        assert_eq!(
            result,
            ConcreteMatchOutcome::Matched("/api/admin/dashboard".to_string()),
            "Literal template must be preferred over /** wildcard"
        );
    }
}
