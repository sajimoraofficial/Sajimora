use crate::ir::{
    ContractDirection, EndpointContract, ParamContract, PrimitiveScalar, RouteSegmentContract,
    ValidationConstraint, ValidationConstraintKind, WireType,
};
use crate::report::ReasonCode;
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestFixtures {
    pub endpoints: BTreeMap<String, EndpointRequestFixture>,
    pub authentication: Option<AuthenticationFixture>,
    pub transactional: bool,
    pub setup_sql: Vec<String>,
    pub cleanup_sql: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthenticationFixture {
    pub username: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct EndpointRequestFixture {
    // A present JSON null is an explicit body, not an absent fixture.
    #[serde(
        deserialize_with = "deserialize_body",
        skip_serializing_if = "Option::is_none"
    )]
    pub body: Option<Value>,
    pub path_parameters: BTreeMap<String, String>,
    pub query_parameters: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub headers_from_env: BTreeMap<String, String>,
    pub session_attributes: BTreeMap<String, Value>,
    pub authentication: Option<AuthenticationFixture>,
    pub setup_sql: Vec<String>,
    pub cleanup_sql: Vec<String>,
    pub expected_status: Option<u16>,
}

fn deserialize_body<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq)]
pub struct SynthesizedRequest {
    pub path: String,
    pub body: Option<Value>,
    /// A root-level `String` parameter consumes the request text itself, not a JSON document.
    pub raw_text_body: bool,
    pub query_parameters: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub headers_from_env: BTreeMap<String, String>,
    pub evidence: Vec<String>,
}

fn is_root_string_body(body: &WireType) -> bool {
    matches!(
        body,
        WireType::Primitive(primitive)
            if primitive.scalar == PrimitiveScalar::String && primitive.format.is_none()
    )
}

fn request_record<'a>(
    response: &EndpointContract,
    endpoints: &'a [EndpointContract],
) -> Result<Option<&'a EndpointContract>> {
    ensure!(
        response.identity.direction == ContractDirection::Response,
        "request synthesis requires a RESPONSE record"
    );
    let mut matches = endpoints.iter().filter(|endpoint| {
        endpoint.identity.direction == ContractDirection::Request
            && endpoint.identity.service == response.identity.service
            && endpoint.identity.http_method == response.identity.http_method
            && endpoint.identity.normalized_route.raw_path
                == response.identity.normalized_route.raw_path
            && endpoint.mapping_conditions == response.mapping_conditions
    });
    let first = matches.next();
    ensure!(
        matches.next().is_none(),
        "insufficient evidence: ambiguous REQUEST records for {} {}",
        response.identity.http_method,
        response.identity.normalized_route.raw_path
    );
    Ok(first)
}

fn parameters<'a>(
    request: Option<&'a EndpointContract>,
    response: &'a EndpointContract,
    kind: &str,
) -> &'a [ParamContract] {
    let select = |endpoint: &'a EndpointContract| match kind {
        "path" => endpoint.path_parameters.as_slice(),
        "query" => endpoint.query_parameters.as_slice(),
        _ => endpoint.headers.as_slice(),
    };
    request
        .map(select)
        .filter(|params| !params.is_empty())
        .unwrap_or_else(|| select(response))
}

pub fn synthesize_request(
    response: &EndpointContract,
    endpoints: &[EndpointContract],
    pool: Option<&BTreeMap<String, WireType>>,
    fixture: Option<&EndpointRequestFixture>,
) -> Result<SynthesizedRequest> {
    let request = request_record(response, endpoints)?;
    let default_fixture = EndpointRequestFixture::default();
    let fixture = fixture.unwrap_or(&default_fixture);
    validate_endpoint_values(fixture)?;
    let selectors = validate_parameter_keys(fixture, response, request)?;
    let mut evidence = vec![
        "Schema samples are not evidence of domain validity or dataset/entity existence."
            .to_string(),
    ];
    if selectors.incomplete {
        evidence.push("mappingConditions complete=false: params selectors are not exhaustive; full route selection is not established.".to_string());
    }
    let ambiguous_post = response.identity.http_method.eq_ignore_ascii_case("POST");
    let mut sampler = Sampler {
        pool,
        active: BTreeSet::new(),
        remaining: 10_000,
        ambiguous_post,
    };
    let path = render_path(
        response,
        parameters(request, response, "path"),
        fixture,
        &mut sampler,
        &mut evidence,
    )?;
    let mut query_parameters = fixture.query_parameters.clone();
    for name in query_parameters.keys() {
        evidence.push(format!("explicit fixture: query parameter {name}"));
    }
    let query = parameters(request, response, "query");
    for (name, selector) in &selectors.parameters {
        if query_parameters.contains_key(name) {
            continue;
        }
        if let Some(value) = &selector.equal {
            query_parameters.insert(name.clone(), value.clone());
            evidence.push(format!("mappingConditions params equality: query parameter {name}; not proof of schema/domain validity"));
        } else if selector.present {
            let value = if let Some(param) = query.iter().find(|param| param.name == *name) {
                sampler.parameter(param)?
            } else {
                "sajimora".to_string()
            };
            query_parameters.insert(name.clone(), value);
            evidence.push(format!("schema sample: mappingConditions params presence query parameter {name}; not proof of domain validity"));
        }
    }
    for param in query {
        validate_key(&param.name)?;
        if param.required && !query_parameters.contains_key(&param.name) {
            let value = sampler.parameter(param)?;
            query_parameters.insert(param.name.clone(), value);
            evidence.push(format!(
                "schema sample: required query parameter {}",
                param.name
            ));
        }
    }
    for (name, selector) in &selectors.parameters {
        if let Some(value) = query_parameters.get(name) {
            ensure!(selector.accepts(value), "query parameter {name:?} conflicts with mappingConditions params selectors; explicit satisfying fixture required");
        }
    }
    let mut headers = fixture.headers.clone();
    for name in headers.keys() {
        evidence.push(format!("explicit fixture: header {name}"));
    }
    for name in fixture.headers_from_env.keys() {
        evidence.push(format!(
            "explicit fixture: header {name} from environment (not read during synthesis)"
        ));
    }
    for param in parameters(request, response, "header") {
        validate_header_name(&param.name)?;
        let configured = headers
            .keys()
            .chain(fixture.headers_from_env.keys())
            .any(|key| key.eq_ignore_ascii_case(&param.name));
        if param.required && !configured {
            let value = sampler.parameter(param)?;
            validate_header_value(&value)?;
            headers.insert(param.name.clone(), value);
            evidence.push(format!("schema sample: required header {}", param.name));
        }
    }
    let raw_text_body = request
        .and_then(|record| record.body.as_ref())
        .is_some_and(is_root_string_body);
    let body = if let Some(body) = &fixture.body {
        evidence.push("explicit fixture: request body; schema/domain constraints are the configured fixture's responsibility (including Pattern)".to_string());
        Some(body.clone())
    } else if let Some(body) = request.and_then(|record| record.body.as_ref()) {
        let value = sampler
            .sample(body, &[], 0)
            .context("REQUEST body requires an explicit fixture or supported schema")?;
        if value.is_some() {
            evidence.push("schema sample: body from exact matching REQUEST record".to_string());
        }
        value
    } else {
        evidence.push(
            "no REQUEST body evidence; no body invented from HTTP method or RESPONSE body"
                .to_string(),
        );
        None
    };
    if raw_text_body {
        if let Some(value) = &body {
            ensure!(
                value.is_string(),
                "REQUEST body fixture for a root-level String parameter must be a JSON string containing the raw body text"
            );
        }
        evidence.push("root-level String body emitted as raw text with text/plain; consumes media type is not extraction evidence".to_string());
    }
    Ok(SynthesizedRequest {
        path,
        body,
        raw_text_body,
        query_parameters,
        headers,
        headers_from_env: fixture.headers_from_env.clone(),
        evidence,
    })
}

pub fn validate_fixtures(fixtures: &RequestFixtures, endpoints: &[EndpointContract]) -> Result<()> {
    validate_authentication(fixtures.authentication.as_ref())?;
    ensure!(
        fixtures.transactional
            || (fixtures.setup_sql.is_empty() && fixtures.cleanup_sql.is_empty()),
        "fixture SQL requires transactional=true"
    );
    for (key, fixture) in &fixtures.endpoints {
        let (method, path) = key.split_once(' ').ok_or_else(|| {
            anyhow!("malformed endpoint fixture key {key:?}; expected METHOD /raw/path")
        })?;
        ensure!(
            is_token(method)
                && method == method.to_ascii_uppercase()
                && path.starts_with('/')
                && !path.chars().any(|c| c.is_control() || c.is_whitespace()),
            "malformed endpoint fixture key {key:?}; expected uppercase METHOD /raw/path"
        );
        let responses: Vec<_> = endpoints
            .iter()
            .filter(|endpoint| {
                endpoint.identity.direction == ContractDirection::Response
                    && endpoint.identity.http_method == method
                    && endpoint.identity.normalized_route.raw_path == path
            })
            .collect();
        ensure!(
            !responses.is_empty(),
            "unmatched endpoint fixture key {key:?}"
        );
        let response = responses[0];
        ensure!(
            responses
                .iter()
                .all(|other| other.identity.service == response.identity.service
                    && other.mapping_conditions == response.mapping_conditions),
            "ambiguous response fixture key {key:?}: service or mapping conditions differ"
        );
        validate_endpoint_values(fixture).with_context(|| format!("fixture {key}"))?;
        ensure!(
            fixtures.transactional
                || (fixture.setup_sql.is_empty() && fixture.cleanup_sql.is_empty()),
            "fixture {key}: SQL requires transactional=true"
        );
        if fixture.expected_status == Some(204) {
            // This API has no pool argument: unresolved refs must not weaken body assertions.
            ensure!(responses.iter().all(|record| record.body.as_ref().map(definitely_void).unwrap_or(true)), "fixture {key}: 204 conflicts with a nonvoid or unresolved RESPONSE body; resolve references before validation");
        }
        let request = request_record(response, endpoints)?;
        validate_parameter_keys(fixture, response, request)
            .with_context(|| format!("fixture {key}"))?;
        let path_params = parameters(request, response, "path");
        for segment in route_segments(response)
            .iter()
            .filter(|segment| segment.is_param)
        {
            let name = segment.param_name.as_deref().or_else(|| {
                segment
                    .param_index
                    .and_then(|index| path_params.get(index as usize))
                    .map(|param| param.name.as_str())
            });
            if let Some(value) = name.and_then(|name| fixture.path_parameters.get(name)) {
                check_route_regex(
                    segment.regex_constraint.as_deref(),
                    value,
                    true,
                    &mut Vec::new(),
                )?;
            }
        }
    }
    Ok(())
}

fn definitely_void(wire: &WireType) -> bool {
    match wire {
        WireType::Primitive(primitive) => primitive.scalar == PrimitiveScalar::Void,
        WireType::Nullable(nullable) => definitely_void(&nullable.inner_type),
        WireType::Optional(optional) => definitely_void(&optional.inner_type),
        WireType::Union(union) => {
            !union.types.is_empty() && union.types.iter().all(definitely_void)
        }
        _ => false,
    }
}

fn validate_authentication(authentication: Option<&AuthenticationFixture>) -> Result<()> {
    if let Some(authentication) = authentication {
        ensure!(
            !authentication.username.trim().is_empty(),
            "authentication username must be nonblank"
        );
    }
    Ok(())
}

fn validate_endpoint_values(fixture: &EndpointRequestFixture) -> Result<()> {
    validate_authentication(fixture.authentication.as_ref())?;
    if let Some(status) = fixture.expected_status {
        ensure!(
            (200..300).contains(&status),
            "expectedStatus must be in 200..299"
        );
    }
    for (name, value) in &fixture.path_parameters {
        validate_key(name)?;
        validate_path_value(value)?;
    }
    for name in fixture.query_parameters.keys() {
        validate_key(name)?;
    }
    let mut header_names = BTreeSet::new();
    for name in fixture
        .headers
        .keys()
        .chain(fixture.headers_from_env.keys())
    {
        validate_header_name(name)?;
        ensure!(
            header_names.insert(name.to_ascii_lowercase()),
            "duplicate configured header {name}"
        );
    }
    for value in fixture.headers.values() {
        validate_header_value(value)?;
    }
    for env in fixture.headers_from_env.values() {
        let mut chars = env.chars();
        ensure!(
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "invalid environment variable name {env:?}"
        );
    }
    for (name, value) in &fixture.session_attributes {
        validate_key(name)?;
        ensure!(
            matches!(value, Value::String(_) | Value::Bool(_) | Value::Number(_)),
            "session attribute {name}: only nonnull JSON scalar values are supported"
        );
        if let Value::Number(number) = value {
            ensure!(
                !number.is_u64() || number.as_u64().is_some_and(|n| n <= i64::MAX as u64),
                "session attribute {name}: integer exceeds Java Long range"
            );
        }
    }
    Ok(())
}

fn validate_key(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && !name.chars().any(char::is_control),
        "parameter/attribute key must be nonempty and have no controls"
    );
    Ok(())
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn validate_header_name(name: &str) -> Result<()> {
    ensure!(is_token(name), "invalid header token name {name:?}");
    Ok(())
}

fn validate_header_value(value: &str) -> Result<()> {
    ensure!(
        !value.contains(['\r', '\n']),
        "header values must not contain CR/LF"
    );
    Ok(())
}

fn validate_path_value(value: &str) -> Result<()> {
    // Percent is forbidden too: encoded separators/dot segments must not bypass checks.
    ensure!(!value.is_empty() && value != "." && value != ".." && !value.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#' | '%')), "unsafe path parameter value {value:?}: traversal, separators, percent escapes, query/hash and controls are forbidden");
    Ok(())
}

fn encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

fn route_segments(response: &EndpointContract) -> Vec<RouteSegmentContract> {
    if response.identity.normalized_route.segments.is_empty() {
        crate::routes::normalize_route_segments(&response.identity.normalized_route.raw_path)
            .segments
    } else {
        response.identity.normalized_route.segments.clone()
    }
}

#[derive(Default)]
struct QuerySelector {
    present: bool,
    absent: bool,
    equal: Option<String>,
    not_equal: BTreeSet<String>,
}

impl QuerySelector {
    fn accepts(&self, value: &str) -> bool {
        !self.absent
            && self
                .equal
                .as_deref()
                .is_none_or(|expected| expected == value)
            && !self.not_equal.contains(value)
    }
}

#[derive(Default)]
struct MappingQuerySelectors {
    parameters: BTreeMap<String, QuerySelector>,
    known_params: bool,
    incomplete: bool,
}

impl MappingQuerySelectors {
    fn parse(mapping: Option<&Value>) -> Result<Self> {
        let mut result = Self::default();
        let Some(mapping) = mapping else {
            return Ok(result);
        };
        let mapping = mapping.as_object().ok_or_else(|| {
            anyhow!("insufficient endpoint evidence: mappingConditions must be an object")
        })?;
        if let Some(complete) = mapping.get("complete") {
            result.incomplete = !complete.as_bool().ok_or_else(|| {
                anyhow!(
                    "insufficient endpoint evidence: mappingConditions complete must be boolean"
                )
            })?;
        }
        let Some(params) = mapping.get("params") else {
            return Ok(result);
        };
        result.known_params = true;
        let params = params.as_array().ok_or_else(|| anyhow!("insufficient endpoint evidence: mappingConditions params must be a string selector array"))?;
        for expression in params {
            let expression = expression.as_str().ok_or_else(|| anyhow!("insufficient endpoint evidence: mappingConditions params selector must be a string"))?;
            let (name, value, negated) = if let Some((name, value)) = expression.split_once('=') {
                if let Some(name) = name.strip_suffix('!') {
                    (name, Some(value), true)
                } else {
                    (name, Some(value), false)
                }
            } else if let Some(name) = expression.strip_prefix('!') {
                (name, None, true)
            } else {
                (expression, None, false)
            };
            ensure!(!name.is_empty() && !name.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '!' | '=')) && value.is_none_or(|value| !value.chars().any(char::is_control)), "insufficient endpoint evidence: malformed mappingConditions params selector {expression:?}");
            let selector = result.parameters.entry(name.to_string()).or_default();
            match (value, negated) {
                (Some(value), false) => {
                    ensure!(selector.equal.as_deref().is_none_or(|previous| previous == value), "insufficient endpoint evidence: contradictory mappingConditions params equality selectors for {name:?}");
                    selector.equal = Some(value.to_string());
                    selector.present = true;
                }
                (Some(value), true) => {
                    selector.not_equal.insert(value.to_string());
                }
                (None, true) => selector.absent = true,
                (None, false) => selector.present = true,
            }
        }
        for (name, selector) in &result.parameters {
            ensure!(!(selector.present && selector.absent) && selector.equal.as_ref().is_none_or(|value| !selector.not_equal.contains(value)), "insufficient endpoint evidence: contradictory mappingConditions params selectors for {name:?}");
        }
        Ok(result)
    }
}

fn validate_parameter_keys(
    fixture: &EndpointRequestFixture,
    response: &EndpointContract,
    request: Option<&EndpointContract>,
) -> Result<MappingQuerySelectors> {
    let mut path_names: BTreeSet<String> = parameters(request, response, "path")
        .iter()
        .map(|param| param.name.clone())
        .collect();
    path_names.extend(
        route_segments(response)
            .iter()
            .filter_map(|segment| segment.param_name.clone()),
    );
    for name in fixture.path_parameters.keys() {
        ensure!(
            path_names.contains(name),
            "unknown endpoint path parameter {name:?}"
        );
    }
    let selectors = MappingQuerySelectors::parse(response.mapping_conditions.as_ref())?;
    let query = parameters(request, response, "query");
    if request.is_some() || !query.is_empty() || selectors.known_params {
        for name in fixture.query_parameters.keys() {
            ensure!(
                query.iter().any(|param| param.name == *name)
                    || selectors.parameters.contains_key(name),
                "unknown endpoint query parameter {name:?}"
            );
        }
    }
    for (name, selector) in &selectors.parameters {
        ensure!(!selector.absent || !query.iter().any(|param| param.name == *name && param.required), "insufficient endpoint evidence: mappingConditions params absence selector conflicts with required query parameter {name:?}");
        if let Some(value) = fixture.query_parameters.get(name) {
            ensure!(selector.accepts(value), "explicit query parameter {name:?} conflicts with mappingConditions params selectors");
        }
    }
    Ok(selectors)
}

fn render_path(
    response: &EndpointContract,
    params: &[ParamContract],
    fixture: &EndpointRequestFixture,
    sampler: &mut Sampler<'_>,
    evidence: &mut Vec<String>,
) -> Result<String> {
    let raw = &response.identity.normalized_route.raw_path;
    ensure!(
        raw.starts_with('/'),
        "insufficient route evidence: expected a local absolute raw path"
    );
    let segments = route_segments(response);
    let mut segments = segments.iter();
    let mut result = Vec::new();
    let mut consumed = BTreeSet::new();
    for part in raw.split('/') {
        if part.is_empty() {
            result.push(String::new());
            continue;
        }
        let segment = segments
            .next()
            .ok_or_else(|| anyhow!("raw path and normalized route segments disagree"))?;
        ensure!(
            !segment.is_wildcard.unwrap_or(false) && (segment.is_param || !part.contains('*')),
            "unsupported wildcard route requires concrete endpoint evidence"
        );
        let parsed = crate::routes::normalize_route_segments(part);
        ensure!(
            parsed.segments.len() == 1 && parsed.segments[0].is_param == segment.is_param,
            "raw path and normalized parameter evidence disagree"
        );
        if segment.is_param {
            let parsed = &parsed.segments[0];
            ensure!(
                parsed
                    .param_name
                    .as_ref()
                    .zip(segment.param_name.as_ref())
                    .is_none_or(|(raw, normalized)| raw == normalized),
                "raw and normalized path parameter names disagree"
            );
            ensure!(
                parsed.regex_constraint.is_none()
                    || parsed.regex_constraint == segment.regex_constraint,
                "raw and normalized route regex evidence disagree"
            );
        }
        if !segment.is_param {
            ensure!(
                !part.contains(['{', '}', '?', '#', '\\']) && !part.chars().any(char::is_control),
                "unsupported static route segment {part:?}"
            );
            result.push(part.to_string());
            continue;
        }
        let name = segment
            .param_name
            .as_deref()
            .or_else(|| {
                segment
                    .param_index
                    .and_then(|index| params.get(index as usize))
                    .map(|param| param.name.as_str())
            })
            .ok_or_else(|| {
                anyhow!("path parameter lacks name metadata; explicit fixture needed")
            })?;
        let param = params.iter().find(|param| param.name == name);
        let explicit = fixture.path_parameters.get(name);
        let value = if let Some(value) = explicit {
            evidence.push(format!(
                "explicit fixture: path parameter {name} (configured dataset responsibility)"
            ));
            consumed.insert(name.to_string());
            value.clone()
        } else if let Some(param) = param {
            let value = sampler.parameter(param)?;
            if let Some(pattern) = segment.regex_constraint.as_deref() {
                if let Some(regex) = SimpleRegex::parse(pattern) {
                    if !regex.matches(&value) {
                        // Only a scalar string sample may be replaced by a route-regex sample.
                        sampler.route_string_parameter(param, &regex)?
                    } else {
                        value
                    }
                } else {
                    bail!("unsupported route regex {pattern:?}; explicit path fixture required");
                }
            } else {
                value
            }
        } else if let Some(pattern) = segment.regex_constraint.as_deref() {
            SimpleRegex::parse(pattern)
                .ok_or_else(|| {
                    anyhow!("unsupported route regex {pattern:?}; explicit path fixture required")
                })?
                .sample()
        } else {
            "sajimora".to_string()
        };
        validate_path_value(&value)?;
        check_route_regex(
            segment.regex_constraint.as_deref(),
            &value,
            explicit.is_some(),
            evidence,
        )?;
        if explicit.is_none() {
            evidence.push(format!(
                "schema sample: path parameter {name}; not proof of entity existence"
            ));
        }
        result.push(encode_path_segment(&value));
    }
    ensure!(
        segments.next().is_none(),
        "raw path and normalized route segments disagree"
    );
    ensure!(
        fixture
            .path_parameters
            .keys()
            .all(|name| consumed.contains(name)),
        "configured path parameter has no substitutable normalized route segment"
    );
    Ok(result.join("/"))
}

fn check_route_regex(
    pattern: Option<&str>,
    value: &str,
    explicit: bool,
    evidence: &mut Vec<String>,
) -> Result<()> {
    if let Some(pattern) = pattern {
        if let Some(regex) = SimpleRegex::parse(pattern) {
            ensure!(
                regex.matches(value),
                "path parameter {value:?} does not satisfy supported route regex {pattern:?}"
            );
        } else {
            ensure!(
                explicit,
                "unsupported route regex {pattern:?}; explicit fixture required"
            );
            evidence.push(format!("explicit fixture: unsupported route regex {pattern:?} is configured responsibility; not validated"));
        }
    }
    Ok(())
}

enum SimpleRegex<'a> {
    Digits,
    Literals(Vec<&'a str>),
}

impl<'a> SimpleRegex<'a> {
    fn parse(pattern: &'a str) -> Option<Self> {
        if pattern.len() > 4096 {
            return None;
        }
        let pattern = if pattern.starts_with('^') && pattern.ends_with('$') {
            &pattern[1..pattern.len() - 1]
        } else {
            pattern
        };
        if pattern == "\\d+" || pattern == "[0-9]+" {
            return Some(Self::Digits);
        }
        let pattern = pattern
            .strip_prefix("(?:")
            .and_then(|p| p.strip_suffix(')'))
            .or_else(|| pattern.strip_prefix('(').and_then(|p| p.strip_suffix(')')))
            .unwrap_or(pattern);
        let literals: Vec<_> = pattern.split('|').take(65).collect();
        if literals.len() <= 64
            && literals.iter().all(|literal| {
                !literal.is_empty()
                    && literal
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
        {
            Some(Self::Literals(literals))
        } else {
            None
        }
    }

    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Digits => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
            Self::Literals(literals) => literals.contains(&value),
        }
    }

    fn sample(&self) -> String {
        match self {
            Self::Digits => "1".to_string(),
            Self::Literals(literals) => literals[0].to_string(),
        }
    }
}

#[derive(Default)]
struct Constraints<'a> {
    min: Option<i64>,
    max: Option<i64>,
    size_min: usize,
    size_max: Option<usize>,
    size: bool,
    not_null: bool,
    not_blank: bool,
    not_empty: bool,
    email: bool,
    positive: bool,
    patterns: Vec<SimpleRegex<'a>>,
}

impl<'a> Constraints<'a> {
    fn parse(constraints: &'a [ValidationConstraint]) -> Result<Self> {
        let mut result = Self::default();
        for constraint in constraints {
            match constraint.kind {
                ValidationConstraintKind::NotNull => result.not_null = true,
                ValidationConstraintKind::NotBlank => result.not_blank = true,
                ValidationConstraintKind::NotEmpty => result.not_empty = true,
                ValidationConstraintKind::Email => result.email = true,
                ValidationConstraintKind::Positive => result.positive = true,
                ValidationConstraintKind::Pattern => {
                    let pattern = constraint.value.as_ref().and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("{}: Pattern requires a literal regexp; --request-fixtures is required", ReasonCode::UnsupportedConstruct.as_str()))?;
                    ensure!(
                        result.patterns.len() < 16,
                        "{}: Pattern sampling budget exceeded; --request-fixtures is required",
                        ReasonCode::UnsupportedConstruct.as_str()
                    );
                    // A generated candidate is not a predicate. Only retain regexes that every
                    // selected value can actually be checked against with the supported matcher.
                    let regex = SimpleRegex::parse(pattern).ok_or_else(|| anyhow!(
                        "{}: unsupported or over-budget Pattern constraint; --request-fixtures is required",
                        ReasonCode::UnsupportedConstruct.as_str()
                    ))?;
                    result.patterns.push(regex);
                }
                ValidationConstraintKind::Min => {
                    let value = integer(
                        constraint
                            .value
                            .as_ref()
                            .ok_or_else(|| anyhow!("Min constraint lacks value"))?,
                    )?;
                    result.min = Some(result.min.map_or(value, |old| old.max(value)));
                }
                ValidationConstraintKind::Max => {
                    let value = integer(
                        constraint
                            .value
                            .as_ref()
                            .ok_or_else(|| anyhow!("Max constraint lacks value"))?,
                    )?;
                    result.max = Some(result.max.map_or(value, |old| old.min(value)));
                }
                ValidationConstraintKind::Size => {
                    let value = constraint
                        .value
                        .as_ref()
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            anyhow!("Size constraint needs an object with min/max bounds")
                        })?;
                    ensure!(
                        !value.is_empty() && value.keys().all(|key| key == "min" || key == "max"),
                        "unsupported Size constraint values"
                    );
                    result.size = true;
                    if let Some(min) = value.get("min") {
                        result.size_min = result.size_min.max(
                            usize::try_from(integer(min)?)
                                .context("Size min must be nonnegative")?,
                        );
                    }
                    if let Some(max) = value.get("max") {
                        let max = usize::try_from(integer(max)?)
                            .context("Size max must be nonnegative")?;
                        result.size_max = Some(result.size_max.map_or(max, |old| old.min(max)));
                    }
                }
            }
        }
        ensure!(
            result
                .min
                .zip(result.max)
                .is_none_or(|(min, max)| min <= max),
            "contradictory Min/Max constraints"
        );
        ensure!(
            result.size_max.is_none_or(|max| result.size_min <= max),
            "contradictory Size constraints"
        );
        Ok(result)
    }

    fn validate(&self, value: &Value) -> Result<()> {
        ensure!(
            !self.not_null || !value.is_null(),
            "NotNull constraint violated"
        );
        if self.positive && !value.is_null() {
            ensure!(
                value.as_f64().is_some_and(|number| number > 0.0),
                "Positive requires a strictly positive numeric sample"
            );
        }
        if !value.is_null() {
            for regex in &self.patterns {
                let text = value
                    .as_str()
                    .ok_or_else(|| anyhow!("Pattern requires a string"))?;
                ensure!(regex.matches(text), "sample violates Pattern constraint");
            }
        }
        if self.min.is_some() || self.max.is_some() {
            let value = value
                .as_i64()
                .ok_or_else(|| anyhow!("Min/Max requires a supported integer numeric sample"))?;
            ensure!(
                self.min.is_none_or(|min| value >= min) && self.max.is_none_or(|max| value <= max),
                "numeric sample contradicts Min/Max"
            );
        }
        if self.not_blank || self.email {
            let value = value
                .as_str()
                .ok_or_else(|| anyhow!("NotBlank/Email requires a string"))?;
            ensure!(
                !self.not_blank || !value.trim().is_empty(),
                "NotBlank constraint violated"
            );
            // Only the known generated address is certified, not arbitrary enum/literal addresses.
            ensure!(
                !self.email || value == "sajimora@example.test",
                "Email sample requires known supported address or explicit fixture"
            );
        }
        if self.size || self.not_empty {
            let size = match value {
                Value::String(value) => value.encode_utf16().count(),
                Value::Array(value) => value.len(),
                Value::Object(value) => value.len(),
                _ => bail!("Size/NotEmpty requires a string, array or map sample"),
            };
            ensure!(!self.not_empty || size > 0, "NotEmpty constraint violated");
            ensure!(
                size >= self.size_min && self.size_max.is_none_or(|max| size <= max),
                "sample contradicts Size bounds"
            );
        }
        Ok(())
    }
}

fn integer(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .ok_or_else(|| anyhow!("unsupported constraint bound {value}: expected signed integer"))
}

struct Sampler<'a> {
    pool: Option<&'a BTreeMap<String, WireType>>,
    active: BTreeSet<String>,
    remaining: usize,
    /// POST does not establish creation. Generated identifiers need explicit operation evidence
    /// before either omitting them or asserting a client-chosen value.
    ambiguous_post: bool,
}

impl Sampler<'_> {
    fn parameter(&mut self, param: &ParamContract) -> Result<String> {
        let value = self
            .sample(
                &param.r#type,
                param.validation_constraints.as_deref().unwrap_or(&[]),
                0,
            )
            .with_context(|| format!("parameter {} requires an explicit fixture", param.name))?
            .ok_or_else(|| anyhow!("required parameter {} has optional schema", param.name))?;
        match value {
            Value::String(value) => Ok(value),
            Value::Number(value) => Ok(value.to_string()),
            Value::Bool(value) => Ok(value.to_string()),
            _ => bail!(
                "parameter {} needs a scalar fixture; complex parameter encoding is unsupported",
                param.name
            ),
        }
    }

    fn route_string_parameter(
        &mut self,
        param: &ParamContract,
        regex: &SimpleRegex<'_>,
    ) -> Result<String> {
        let mut wire = &param.r#type;
        let mut active = BTreeSet::new();
        loop {
            match wire {
                WireType::Nullable(nullable) => wire = &nullable.inner_type,
                WireType::Ref(reference) => {
                    ensure!(active.insert(&reference.r#ref), "required reference cycle");
                    wire = self
                        .pool
                        .and_then(|pool| pool.get(&reference.r#ref))
                        .ok_or_else(|| anyhow!("unresolved reference {}", reference.r#ref))?;
                }
                WireType::Primitive(primitive)
                    if primitive.scalar == PrimitiveScalar::String
                        && primitive.format.is_none() =>
                {
                    break
                }
                _ => bail!(
                    "route regex and parameter schema sample disagree; explicit fixture required"
                ),
            }
        }
        let bounds = Constraints::parse(param.validation_constraints.as_deref().unwrap_or(&[]))?;
        let candidate = match regex {
            SimpleRegex::Digits => {
                let len = bounds.size_min.max(1);
                ensure!(
                    len <= 4096,
                    "route parameter exceeds sane Size budget; explicit fixture required"
                );
                "1".repeat(len)
            }
            _ => regex.sample(),
        };
        bounds.validate(&Value::String(candidate.clone()))?;
        Ok(candidate)
    }

    fn sample(
        &mut self,
        wire: &WireType,
        constraints: &[ValidationConstraint],
        depth: usize,
    ) -> Result<Option<Value>> {
        ensure!(
            depth < 80 && self.remaining > 0,
            "schema sample recursion/size budget exceeded; explicit fixture required"
        );
        self.remaining -= 1;
        if matches!(wire, WireType::Optional(_)) {
            return Ok(None);
        }
        let bounds = Constraints::parse(constraints)?;
        let value = match wire {
            WireType::Primitive(primitive) => match primitive.scalar {
                PrimitiveScalar::String => {
                    // A temporal scalar is still a JSON string, but its grammar is fixed by the
                    // producer: Jackson's date deserializer rejects any other text with 400.
                    if let Some(format) = primitive.format {
                        let sample = match format {
                            crate::ir::PrimitiveFormat::DateTime => "2024-01-01T00:00:00Z",
                            crate::ir::PrimitiveFormat::LocalDateTime => "2024-01-01T00:00:00",
                            crate::ir::PrimitiveFormat::Date => "2024-01-01",
                            crate::ir::PrimitiveFormat::Time => "00:00:00",
                        };
                        bounds.validate(&Value::String(sample.to_string()))?;
                        return Ok(Some(Value::String(sample.to_string())));
                    }
                    let mut value = if bounds.email { "sajimora@example.test".to_string() } else { "sajimora".to_string() };
                    let min = bounds.size_min.max(usize::from(bounds.not_blank || bounds.not_empty));
                    ensure!(min <= 4096, "string sample exceeds sane Size budget; explicit fixture required");
                    if !bounds.email {
                        if let Some(max) = bounds.size_max {
                            value.truncate(max.min(value.len()));
                        }
                        if value.len() < min {
                            value.push_str(&"s".repeat(min - value.len()));
                        }
                    }
                    if !bounds.patterns.is_empty() {
                        let mut candidates = vec![value];
                        for regex in &bounds.patterns {
                            match regex {
                                SimpleRegex::Digits => candidates.push("1".repeat(min.max(1))),
                                SimpleRegex::Literals(values) => candidates.extend(values.iter().map(|value| value.to_string())),
                            }
                        }
                        ensure!(candidates.len() <= 256, "{}: Pattern candidate budget exceeded; explicit fixture required", ReasonCode::UnsupportedConstruct.as_str());
                        let mut selected = None;
                        for candidate in candidates {
                            ensure!(self.remaining > 0, "{}: Pattern sampling budget exceeded; explicit fixture required", ReasonCode::UnsupportedConstruct.as_str());
                            self.remaining -= 1;
                            if bounds.validate(&Value::String(candidate.clone())).is_ok() {
                                selected = Some(candidate);
                                break;
                            }
                        }
                        value = selected.ok_or_else(|| anyhow!("No supported deterministic sample satisfies Pattern and validation constraints; explicit fixture required"))?;
                    }
                    Value::String(value)
                }
                PrimitiveScalar::Number | PrimitiveScalar::BigInt => {
                    let mut value = 1_i64;
                    if let Some(min) = bounds.min { value = value.max(min); }
                    if let Some(max) = bounds.max { value = value.min(max); }
                    ensure!(value.unsigned_abs() <= 1_000_000_000, "numeric sample exceeds sane bound; explicit fixture required");
                    Value::from(value)
                }
                PrimitiveScalar::Boolean => Value::Bool(true),
                PrimitiveScalar::Void | PrimitiveScalar::Any => bail!("void/ANY request schema lacks supported synthesis evidence; explicit fixture required"),
            },
            WireType::Object(object) => {
                ensure!(!bounds.size && !bounds.not_empty, "Size/NotEmpty on bean object is unsupported; explicit fixture required");
                let mut value = Map::new();
                for property in &object.properties {
                    ensure!(!(self.ambiguous_post && property.server_assigned),
                        "{}: generated property {} has ambiguous POST create/update semantics (including required constraints); --request-fixtures is required",
                        ReasonCode::UnsupportedConstruct.as_str(), property.wire_name);
                    if property.optional { continue; }
                    if let Some(sample) = self.sample(&property.r#type, &property.validation_constraints, depth + 1).with_context(|| format!("property {}", property.wire_name))? {
                        ensure!(!value.contains_key(&property.wire_name), "duplicate required object property {}", property.wire_name);
                        value.insert(property.wire_name.clone(), sample);
                    }
                }
                Value::Object(value)
            }
            WireType::Array(array) => {
                let len = bounds.size_min.max(usize::from(bounds.not_empty));
                ensure!(len <= 256, "array sample exceeds sane Size budget; explicit fixture required");
                ensure!(bounds.size_max.is_none_or(|max| len <= max), "contradictory NotEmpty/Size constraints");
                let mut values = Vec::new();
                for _ in 0..len {
                    values.push(self.sample(&array.element_type, &[], depth + 1)?.ok_or_else(|| anyhow!("required array element cannot be omitted"))?);
                }
                Value::Array(values)
            }
            WireType::Nullable(nullable) => return self.sample(&nullable.inner_type, constraints, depth + 1),
            WireType::Optional(_) => unreachable!(),
            WireType::Ref(reference) => {
                ensure!(self.active.insert(reference.r#ref.clone()), "required reference cycle at {}; explicit fixture required", reference.r#ref);
                let result = match self.pool.and_then(|pool| pool.get(&reference.r#ref)) {
                    Some(target) => self.sample(target, constraints, depth + 1),
                    None => Err(anyhow!("unresolved reference {}; explicit fixture required", reference.r#ref)),
                };
                self.active.remove(&reference.r#ref);
                return result;
            }
            WireType::Enum(enumeration) => {
                enumeration.values.iter().filter(|value| !value.is_null())
                    .chain(enumeration.values.iter().filter(|value| value.is_null()))
                    .find(|value| bounds.validate(value).is_ok()).cloned()
                    .ok_or_else(|| anyhow!("enum has no defined value satisfying constraints; explicit fixture required"))?
            }
            WireType::Literal(literal) => literal.value.clone(),
            WireType::Union(union) => {
                let mut errors = Vec::new();
                let mut defined_null = None;
                for branch in &union.types {
                    match self.sample(branch, constraints, depth + 1) {
                        Ok(Some(Value::Null)) => defined_null = Some(Value::Null),
                        Ok(Some(value)) => return Ok(Some(value)),
                        Ok(None) => errors.push("optional branch cannot supply required union value".to_string()),
                        Err(error) => errors.push(format!("{error:#}")),
                    }
                }
                if defined_null.is_some() {
                    return Ok(defined_null);
                }
                bail!("union has no supported sample: {}", errors.join("; "));
            }
            WireType::Unknown(unknown) => bail!("UNKNOWN request schema: {}; explicit fixture required", unknown.reason),
            WireType::Map(_) => bail!("MAP synthesis is unsupported; explicit fixture required"),
        };
        bounds.validate(&value)?;
        Ok(Some(value))
    }
}
