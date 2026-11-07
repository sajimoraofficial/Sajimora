//! shape_report.rs — how far each route still is from a fully-shaped contract.
//!
//! A verdict says whether linked contracts agree; it says nothing about how much of the
//! corpus was too unresolved to be asked. That second number is what a buyer reads as
//! coverage, so it has to leave the tool with the same definition the measurement
//! harness uses. `scripts/measurement/census.cjs` is that definition, and this module is
//! its Rust twin: one leaf rule, one unresolved rule, one per-root denominator. If the
//! two ever disagree, the disagreement is a bug in one of them, not a choice of framing.
//!
//! Leaf positions (the denominator):
//!   resolved   PRIMITIVE, ENUM, LITERAL
//!   unresolved UNKNOWN leaves, dangling references, hollow references
//! `distance_to_complete` adds property-less OBJECT targets, because an empty object also
//! stops a route from being fully shaped without being a leaf.
//!
//! The debt split answers "of what is unresolved, how much is *our* fault". Untyped
//! source cannot be shaped by any amount of analysis, so it must be reported separately
//! from an extractor gap that a release can close. Classification reads the abstention
//! reasons this repository's own extractors emit; a reason that matches no rule lands in
//! `unclassified` rather than in either flattering bucket.

use crate::envelope::{ArtifactPayload, ContractArtifactEnvelope, FrontendContractPayload};
use crate::ir::{ContractDirection, WireType};
use anyhow::Result;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// One unresolved position, attributed to the reason it is unresolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum DebtClass {
    /// The source carries no type at that position (`any`, untyped JavaScript). No
    /// amount of extractor work can shape it.
    UntypedSource,
    /// A human wrote the shape, but the wire form is chosen while running (Jackson
    /// polymorphism, a runtime serializer, an interface dispatched by payload).
    RuntimeDecided,
    /// The information is in the source and static analysis can reach it; we do not
    /// reach it yet.
    ExtractorGap,
    /// An abstention reason no rule claims. Kept visible so a new extractor message
    /// cannot quietly enlarge either of the other buckets.
    Unclassified,
}

impl DebtClass {
    fn label(self) -> &'static str {
        match self {
            DebtClass::UntypedSource => "untypedSource",
            DebtClass::RuntimeDecided => "runtimeDecided",
            DebtClass::ExtractorGap => "extractorGap",
            DebtClass::Unclassified => "unclassified",
        }
    }
}

/// Attribute one abstention reason to a debt class.
///
/// Rules are phrased over the semantics of the message, never over a repository, a type
/// name, or a file path, so a corpus we have never seen classifies the same way.
pub fn classify_debt(reason: &str) -> DebtClass {
    let text = reason.trim();
    let lower = text.to_lowercase();

    // A token scan, not a substring scan: `many`, `index.anything` and `Company` must not
    // be read as the `any` type.
    if mentions_any_type(&lower) || contains_any(&lower, UNTYPED_SOURCE_MARKERS) {
        return DebtClass::UntypedSource;
    }
    if contains_any(&lower, RUNTIME_DECIDED_MARKERS) {
        return DebtClass::RuntimeDecided;
    }
    if contains_any(&lower, EXTRACTOR_GAP_MARKERS) {
        return DebtClass::ExtractorGap;
    }
    DebtClass::Unclassified
}

const UNTYPED_SOURCE_MARKERS: &[&str] = &[
    "untyped",
    "implicit any",
    "no type information",
    "no type annotation",
    "without type annotations",
    "annotated as `any`",
    "declared as any",
];

const RUNTIME_DECIDED_MARKERS: &[&str] = &[
    "runtime serialization decides",
    "whichever implementation",
    "whichever subtype",
    "decided at runtime",
    "determined at runtime",
    "computed field name",
    "dynamic field",
    "data-driven field",
    "field names come from",
    "values are chosen at runtime",
    "@jsontypeinfo",
    "@jsonserialize",
    "@jsonanygetter",
    "@jsonrawvalue",
    "@jsonunwrapped",
];

const EXTRACTOR_GAP_MARKERS: &[&str] = &[
    "unresolved java type",
    "unresolved type",
    "could not be resolved",
    "not bound at this use site",
    "exceeded the depth budget",
    "recursion budget",
    "request body expression",
    "index signature",
    "not modelled",
    "not modeled",
    "property-less object",
    "empty object",
    "dangling reference",
    "hollow reference",
    // A type expression is written in the source; reading that form is extractor work, not
    // absent typing. Checked after the `any` scan so a literal `any` stays untyped source.
    "unsupported type expression",
    "non-identifier or unresolvable type expression",
    "does not resolve to a declared object",
    "could not be resolved from call context",
    "union member types are not expanded",
];

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// True when the reason quotes a type expression whose members include bare `any`.
/// Splitting on type-expression punctuation keeps `Record<string, any>` and `any[]`
/// counted while `Promise<anything>` is not.
fn mentions_any_type(lower: &str) -> bool {
    lower
        .split(|c| {
            matches!(
                c,
                ' ' | ',' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ';' | '|'
            )
        })
        .any(|token| token == "any" || token == "unknown")
}

/// Leaf accounting for one traversal, mirroring `newStats()` in census.cjs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafStats {
    pub resolved_leaves: usize,
    pub unknown_leaves: usize,
    pub dangling_refs: usize,
    pub hollow_refs: usize,
    pub empty_object_targets: usize,
    pub fields_total: usize,
    pub fields_unknown: usize,
    #[serde(skip)]
    debt: BTreeMap<DebtClass, usize>,
    /// Normalized abstention reason -> positions, the same key census.cjs reports.
    #[serde(skip)]
    reasons: BTreeMap<String, usize>,
}

impl LeafStats {
    /// Unresolved leaf positions: the census denominator for "not yet shaped".
    pub fn unresolved_positions(&self) -> usize {
        self.unknown_leaves + self.dangling_refs + self.hollow_refs
    }

    pub fn positions_total(&self) -> usize {
        self.resolved_leaves + self.unresolved_positions()
    }

    /// Positions that must be resolved before this route is fully shaped.
    pub fn distance_to_complete(&self) -> usize {
        self.unresolved_positions() + self.empty_object_targets
    }

    pub fn is_fully_shaped(&self) -> bool {
        self.distance_to_complete() == 0
    }

    fn merge(&mut self, other: &LeafStats) {
        self.resolved_leaves += other.resolved_leaves;
        self.unknown_leaves += other.unknown_leaves;
        self.dangling_refs += other.dangling_refs;
        self.hollow_refs += other.hollow_refs;
        self.empty_object_targets += other.empty_object_targets;
        self.fields_total += other.fields_total;
        self.fields_unknown += other.fields_unknown;
        for (k, v) in &other.debt {
            *self.debt.entry(*k).or_default() += *v;
        }
        for (r, v) in &other.reasons {
            *self.reasons.entry(r.clone()).or_default() += *v;
        }
    }
}

/// Normalized reason key, so `Unresolved Java type: TimeUnit` and `...: ZoneId` share a
/// class while remaining separable. Same normalisation census.cjs applies.
fn normalize_reason(reason: &str) -> String {
    let chars: Vec<char> = reason.chars().collect();
    let mut out = String::with_capacity(reason.len());
    let mut i = 0;
    let mut digit_run = false;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '`' {
            // One `X` per quoted identifier, exactly as census.cjs collapses it.
            let close = (i + 1..chars.len()).find(|j| chars[*j] == '`');
            match close {
                Some(j) => {
                    out.push_str("`X`");
                    i = j + 1;
                    continue;
                }
                // An unpaired backtick is literal text, not an identifier.
                None => out.push('`'),
            }
        }
        if ch.is_ascii_digit() {
            if !digit_run {
                out.push('N');
                digit_run = true;
            }
            i += 1;
            continue;
        }
        digit_run = false;
        out.push(ch);
        i += 1;
    }
    out.trim().to_string()
}

/// One shared declaration used by 40 endpoints is counted 40 times: this is the
/// occurrence denominator, and it is the only one this module reports.
fn walk(
    node: Option<&WireType>,
    pool: &BTreeMap<String, WireType>,
    stats: &mut LeafStats,
    seen: &mut HashSet<String>,
) {
    let Some(node) = node else { return };
    match node {
        WireType::Primitive(_) | WireType::Enum(_) | WireType::Literal(_) => {
            stats.resolved_leaves += 1;
        }
        WireType::Unknown(u) => {
            stats.unknown_leaves += 1;
            record(stats, classify_debt(&u.reason), &u.reason);
        }
        WireType::Nullable(n) => walk(Some(&n.inner_type), pool, stats, seen),
        WireType::Optional(o) => walk(Some(&o.inner_type), pool, stats, seen),
        WireType::Array(a) => walk(Some(&a.element_type), pool, stats, seen),
        WireType::Map(m) => {
            walk(Some(&m.key_type), pool, stats, seen);
            walk(Some(&m.value_type), pool, stats, seen);
        }
        WireType::Union(u) => {
            for branch in &u.types {
                walk(Some(branch), pool, stats, seen);
            }
        }
        WireType::Object(o) => {
            for property in &o.properties {
                stats.fields_total += 1;
                if matches!(property.r#type, WireType::Unknown(_)) {
                    stats.fields_unknown += 1;
                }
                walk(Some(&property.r#type), pool, stats, seen);
            }
        }
        WireType::Ref(r) => {
            let Some(target) = pool.get(&r.r#ref) else {
                stats.dangling_refs += 1;
                record(
                    stats,
                    DebtClass::ExtractorGap,
                    &format!("dangling reference `{}`", r.r#ref),
                );
                return;
            };
            if let WireType::Unknown(u) = target {
                stats.hollow_refs += 1;
                // The reference is hollow *because of* the declaration it points at, so the
                // debt belongs to that abstention reason, not to the call site.
                record(stats, classify_debt(&u.reason), &u.reason);
                return;
            }
            if let WireType::Object(o) = target {
                if o.properties.is_empty() {
                    stats.empty_object_targets += 1;
                    record(
                        stats,
                        DebtClass::ExtractorGap,
                        "property-less OBJECT declaration",
                    );
                }
            }
            if !seen.insert(r.r#ref.clone()) {
                // Mutual recursion is stopped by name, so a cycle expands once per root.
                return;
            }
            walk(Some(target), pool, stats, seen);
            seen.remove(&r.r#ref);
        }
    }
}

fn record(stats: &mut LeafStats, class: DebtClass, reason: &str) {
    *stats.debt.entry(class).or_default() += 1;
    // The class prefix makes the key self-describing; classification is a pure function of
    // the reason, so one reason can never appear under two classes.
    let key = format!("{}::{}", class.label(), normalize_reason(reason));
    *stats.reasons.entry(key).or_default() += 1;
}

/// Per-route shape distance, in the form a triage list needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteShapeDistance {
    pub route: String,
    pub direction: String,
    pub positions_total: usize,
    pub positions_resolved: usize,
    pub distance_to_complete: usize,
    pub fully_shaped: bool,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub debt_by_class: BTreeMap<&'static str, usize>,
}

/// How much unresolved shape is the source's fault and how much is ours.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtSplit {
    pub untyped_source: usize,
    pub runtime_decided: usize,
    pub extractor_gap: usize,
    pub unclassified: usize,
}

impl DebtSplit {
    fn from(debt: &BTreeMap<DebtClass, usize>) -> Self {
        DebtSplit {
            untyped_source: debt.get(&DebtClass::UntypedSource).copied().unwrap_or(0),
            runtime_decided: debt.get(&DebtClass::RuntimeDecided).copied().unwrap_or(0),
            extractor_gap: debt.get(&DebtClass::ExtractorGap).copied().unwrap_or(0),
            unclassified: debt.get(&DebtClass::Unclassified).copied().unwrap_or(0),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistanceBucket {
    pub distance: usize,
    pub roots: usize,
}

/// Shape coverage for one artifact, computed with the census definitions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeCoverage {
    pub service_id: String,
    pub lane: &'static str,
    pub roots: usize,
    pub fully_shaped_roots: usize,
    pub positions_total: usize,
    pub positions_resolved: usize,
    /// Resolved share of leaf positions — per-position reach, not coverage of the API.
    pub resolved_rate_percent: f64,
    /// Share of roots that need nothing more — the number a buyer can act on.
    pub fully_shaped_rate_percent: f64,
    pub distance_to_complete: usize,
    pub untyped_source_debt: DebtSplit,
    pub distance_histogram: Vec<DistanceBucket>,
    /// Routes closest to fully shaped: the cheapest next roots.
    pub nearest_routes: Vec<RouteShapeDistance>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub top_debt_reasons: Vec<DebtReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routes: Option<Vec<RouteShapeDistance>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtReason {
    pub class: &'static str,
    pub reason: String,
    pub positions: usize,
}

impl ShapeCoverage {
    /// One-line human summary, used by the reporter and `verify`.
    pub fn summary_line(&self) -> String {
        format!(
            "{} [{}] roots {} fully-shaped {} ({}%) | positions {}/{} resolved ({}%) | distance {} | debt untyped-source {} runtime {} extractor-gap {}",
            self.service_id,
            self.lane,
            self.roots,
            self.fully_shaped_roots,
            self.fully_shaped_rate_percent,
            self.positions_resolved,
            self.positions_total,
            self.resolved_rate_percent,
            self.distance_to_complete,
            self.untyped_source_debt.untyped_source,
            self.untyped_source_debt.runtime_decided,
            self.untyped_source_debt.extractor_gap,
        )
    }
}

/// Compute coverage from an already-loaded envelope. The envelope is read, never
/// rewritten: references stay references so the walk matches the published census.
pub fn coverage_for_envelope(
    envelope: &ContractArtifactEnvelope,
    with_routes: bool,
) -> ShapeCoverage {
    let (lane, mut route_stats) = match &envelope.payload {
        ArtifactPayload::Backend(bp) => {
            let pool = bp.type_pool.clone().unwrap_or_default();
            let mut rows: Vec<(String, String, LeafStats)> = Vec::with_capacity(bp.endpoints.len());
            for ep in &bp.endpoints {
                let mut stats = LeafStats::default();
                let mut seen = HashSet::new();
                walk(ep.body.as_ref(), &pool, &mut stats, &mut seen);
                let direction = match ep.identity.direction {
                    ContractDirection::Request => "REQUEST",
                    ContractDirection::Response => "RESPONSE",
                }
                .to_string();
                rows.push((
                    format!(
                        "{} {}",
                        ep.identity.http_method,
                        canonical_route(&ep.identity.normalized_route.raw_path)
                    ),
                    direction,
                    stats,
                ));
            }
            ("backend", rows)
        }
        ArtifactPayload::Frontend(fp) => {
            let FrontendContractPayload {
                client_contracts,
                type_pool,
                ..
            } = fp;
            let pool = type_pool.clone().unwrap_or_default();
            let mut rows: Vec<(String, String, LeafStats)> =
                Vec::with_capacity(client_contracts.len());
            for contract in client_contracts {
                let mut stats = LeafStats::default();
                let mut seen = HashSet::new();
                walk(contract.request_body.as_ref(), &pool, &mut stats, &mut seen);
                walk(
                    Some(&contract.expected_response),
                    &pool,
                    &mut stats,
                    &mut seen,
                );
                rows.push((
                    format!(
                        "{} {}",
                        contract.http_method,
                        canonical_route(&contract.normalized_route)
                    ),
                    "CONSUMER".to_string(),
                    stats,
                ));
            }
            ("frontend", rows)
        }
    };

    let mut aggregate = LeafStats::default();
    for (_, _, stats) in &route_stats {
        aggregate.merge(stats);
    }

    let fully_shaped_roots = route_stats.iter().filter(|r| r.2.is_fully_shaped()).count();
    let positions_total = aggregate.positions_total();
    let positions_resolved = aggregate.resolved_leaves;

    route_stats.sort_by(|a, b| {
        b.2.distance_to_complete()
            .cmp(&a.2.distance_to_complete())
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut histogram: BTreeMap<usize, usize> = BTreeMap::new();
    for (_, _, stats) in &route_stats {
        *histogram.entry(stats.distance_to_complete()).or_default() += 1;
    }

    let nearest_routes: Vec<RouteShapeDistance> = route_stats
        .iter()
        .rev()
        .filter(|r| r.2.distance_to_complete() > 0)
        .take(10)
        .map(row_to_route)
        .collect();

    let routes = with_routes.then(|| route_stats.iter().map(row_to_route).collect());

    let top_debt_reasons = top_debt_reasons(&aggregate);

    ShapeCoverage {
        service_id: envelope.snapshot.service_id.clone(),
        lane,
        roots: route_stats.len(),
        fully_shaped_roots,
        positions_total,
        positions_resolved,
        resolved_rate_percent: rate(positions_resolved, positions_total),
        fully_shaped_rate_percent: rate(fully_shaped_roots, route_stats.len()),
        distance_to_complete: aggregate.distance_to_complete(),
        untyped_source_debt: DebtSplit::from(&aggregate.debt),
        distance_histogram: histogram
            .into_iter()
            .map(|(distance, roots)| DistanceBucket { distance, roots })
            .collect(),
        nearest_routes,
        top_debt_reasons,
        routes,
    }
}

fn row_to_route(row: &(String, String, LeafStats)) -> RouteShapeDistance {
    RouteShapeDistance {
        route: row.0.clone(),
        direction: row.1.clone(),
        positions_total: row.2.positions_total(),
        positions_resolved: row.2.resolved_leaves,
        distance_to_complete: row.2.distance_to_complete(),
        fully_shaped: row.2.is_fully_shaped(),
        debt_by_class: row.2.debt.iter().map(|(k, v)| (k.label(), *v)).collect(),
    }
}

fn top_debt_reasons(aggregate: &LeafStats) -> Vec<DebtReason> {
    let mut rows: Vec<DebtReason> = aggregate
        .reasons
        .iter()
        .map(|(key, positions)| match key.split_once("::") {
            Some((class, reason)) => DebtReason {
                class: DebtClass::from_label(class)
                    .unwrap_or(DebtClass::Unclassified)
                    .label(),
                reason: reason.to_string(),
                positions: *positions,
            },
            None => DebtReason {
                class: DebtClass::Unclassified.label(),
                reason: key.clone(),
                positions: *positions,
            },
        })
        .collect();
    rows.sort_by(|a, b| {
        b.positions
            .cmp(&a.positions)
            .then_with(|| a.reason.cmp(&b.reason))
    });
    rows.truncate(12);
    rows
}

/// Load an artifact and report its shape distance. Reading is the only effect.
pub fn coverage_for_artifact(path: &Path, with_routes: bool) -> Result<ShapeCoverage> {
    let text = std::fs::read_to_string(path)?;
    let envelope: ContractArtifactEnvelope = serde_json::from_str(&text)?;
    Ok(coverage_for_envelope(&envelope, with_routes))
}

fn canonical_route(raw: &str) -> String {
    // Parameter names differ per lane (`{id}` against `:id`), so the shared form masks
    // them by position. Collapsed routes stay collapsed rather than matching everything.
    raw.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with(':') || (s.starts_with('{') && s.ends_with('}')) {
                "*"
            } else {
                s
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn rate(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        return 0.0;
    }
    ((part as f64 / whole as f64) * 1000.0).round() / 10.0
}

impl DebtClass {
    fn from_label(label: &str) -> Option<DebtClass> {
        match label {
            "untypedSource" => Some(DebtClass::UntypedSource),
            "runtimeDecided" => Some(DebtClass::RuntimeDecided),
            "extractorGap" => Some(DebtClass::ExtractorGap),
            "unclassified" => Some(DebtClass::Unclassified),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debt_class_separates_untyped_source_from_extractor_gap() {
        // Untyped at the position: no analysis can shape it.
        assert_eq!(
            classify_debt("Non-identifier or unresolvable type expression: any"),
            DebtClass::UntypedSource
        );
        assert_eq!(
            classify_debt("untyped JavaScript response has no declared shape"),
            DebtClass::UntypedSource
        );
        // Ours to fix.
        assert_eq!(
            classify_debt("Unresolved Java type: TimeUnit"),
            DebtClass::ExtractorGap
        );
        assert_eq!(
            classify_debt("dangling reference `java:com.example.Thing`"),
            DebtClass::ExtractorGap
        );
        assert_eq!(
            classify_debt("Type expansion exceeded the depth budget (80)"),
            DebtClass::ExtractorGap
        );
        // Shaped by a person, but chosen while running.
        assert_eq!(
            classify_debt(
                "com.acme.Base declares @JsonTypeInfo; runtime serialization decides the wire shape, so its static properties are inconclusive"
            ),
            DebtClass::RuntimeDecided
        );
        assert_eq!(
            classify_debt("com.acme.Filter is an interface; its JSON properties come from whichever implementation the producer returns at runtime"),
            DebtClass::RuntimeDecided
        );
        // A message no rule claims stays visible instead of flattering either bucket.
        assert_eq!(
            classify_debt("brand new abstention message"),
            DebtClass::Unclassified
        );
    }

    #[test]
    fn any_token_scan_does_not_read_words_as_types() {
        assert_eq!(
            classify_debt("Non-identifier: Promise<anything>"),
            DebtClass::Unclassified
        );
        assert_eq!(
            classify_debt("Non-identifier or unresolvable type expression: Record<string, any>"),
            DebtClass::UntypedSource
        );
    }

    #[test]
    fn every_reason_emitted_by_the_two_shipped_lanes_is_claimed() {
        // Reason strings copied from ThingsBoard backend and frontend artifacts. A miss
        // here is not cosmetic: it lands in `unclassified` and the split stops meaning
        // "whose fault is the debt".
        let reasons = [
            "Unresolved Java type: TimeUnit",
            "org.thingsboard.server.common.data.query.AliasEntityId declares @JsonSerialize; runtime serialization decides the wire shape, so its static properties are inconclusive",
            "org.thingsboard.server.common.data.notification.targets.platform.SystemLevelUsersFilter is an interface; its JSON properties come from whichever implementation the producer returns at runtime",
            "Non-identifier or unresolvable type expression: any",
            "Non-identifier or unresolvable type expression: {[alias: string]: string }",
            "Non-identifier or unresolvable type expression: Record<string, any>",
            "Unsupported type expression `FilterPredicateValue<number>`",
            "Type `WidgetActionDescriptor` could not be resolved in local type pool",
            "Response type could not be resolved from call context",
            "Type expansion exceeded the depth budget (80)",
            "PageData<T> declares a type parameter T that is not bound at this use site",
            "Request body expression: defaultHttpOptionsFromConfig(config)",
            "Foo declares an index signature; its arbitrary keys and their value type are not enumerable statically",
            "Bar extends Baz, which does not resolve to a declared object",
            "Union member types are not expanded, so this field stays unresolved",
            "hollow reference `java:com.acme.Thing`",
        ];
        for reason in reasons {
            assert_ne!(
                classify_debt(reason),
                DebtClass::Unclassified,
                "unclaimed abstention reason: {reason}"
            );
        }
        assert_eq!(
            classify_debt(
                "PageData<T> declares a type parameter T that is not bound at this use site"
            ),
            DebtClass::ExtractorGap
        );
        assert_eq!(
            classify_debt("Unsupported type expression `FilterPredicateValue<number>`"),
            DebtClass::ExtractorGap
        );
    }

    #[test]
    fn distance_counts_every_position_that_blocks_a_route() {
        let mut stats = LeafStats::default();
        stats.resolved_leaves = 8;
        stats.unknown_leaves = 2;
        stats.hollow_refs = 1;
        stats.empty_object_targets = 1;
        assert_eq!(stats.positions_total(), 11);
        assert_eq!(stats.distance_to_complete(), 4);
        assert!(!stats.is_fully_shaped());
    }

    #[test]
    fn reason_normalisation_collapses_identifiers_not_classes() {
        assert_eq!(
            normalize_reason("Unresolved Java type: TimeUnit"),
            "Unresolved Java type: TimeUnit"
        );
        assert_eq!(
            normalize_reason("dangling reference `java:com.acme.Foo#Bar`"),
            "dangling reference `X`"
        );
        assert_eq!(
            normalize_reason("expansion budget (80) at line 12"),
            "expansion budget (N) at line N"
        );
    }
}
