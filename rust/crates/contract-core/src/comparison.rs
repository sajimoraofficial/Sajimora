//! comparison.rs -- ArtifactComparisonEngine: exact port of ArtifactComparisonEngine.ts
//!
//! Orchestrates:
//!  1. Artifact admission for all envelopes
//!  2. Identity + profile consistency blockers
//!  3. verify_backend_producer_against_clients / verify_frontend_client_expectations per target
//!  4. wireInclusion per matched consumer
//!  5. Verdict resolution (TOOL_FAILURE/FILE_READ_ERROR -> ANALYSIS_ERROR)
//!  6. Returns a CrossLanguageImpactReport

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::admission::{admit_artifact, ArtifactTrustPolicy};
use crate::canonical::canonical_json;
use crate::envelope::{
    ArtifactKind, ArtifactPayload, ContractArtifactEnvelope, DecoderKind, FrontendClientContract,
};
use crate::inclusion::wire_inclusion;
use crate::ir::{
    ContractDirection, EndpointContract, ObjectWireType, ObservedResponseEvidence,
    ObservedResponseStatus, SourceLanguage, SourceProvenance, StatusCodeFamily, UnknownWireType,
    WireType,
};
use crate::observed::path_present;
use crate::report::{
    build_finding_id_from_parts, make_error_report, AbstentionCode, AnalysisBlocker,
    AnalysisCounts, AnalysisScope, ArtifactRef, ArtifactRefs, BlockerCode, ChangeRecord,
    CompletenessAccounting, ConsumerSite, CrossLanguageFinding, CrossLanguageImpactReport,
    CrossLanguageVerdict, EndpointLocation, EvidenceItem, EvidenceKind, ReasonCode,
    ReasonCodeRecord, ReasonSource, SnapshotIdentity, TsExpectationKind, TypeScriptClientRef,
    ASSURANCE, SCHEMA_VERSION,
};
use crate::routes::{match_routes, normalize_route_segments, route_key_for_endpoint};
use anyhow::Result;
use serde_json::json;

pub struct CheckContractInput {
    pub base: ContractArtifactEnvelope,
    pub candidate: ContractArtifactEnvelope,
    pub targets: Vec<ContractArtifactEnvelope>,
    pub policy: ArtifactTrustPolicy,
    pub trusted_local: bool,
    pub require_service_mapping: bool,
}

struct Engine {
    require_service_mapping: bool,
    unresolved: Vec<String>,
    reasons: Vec<ReasonCodeRecord>,
    linked: HashSet<String>,
    comparison_errors: Vec<AnalysisBlocker>,
}

impl Engine {
    fn new(require_service_mapping: bool) -> Self {
        Engine {
            require_service_mapping,
            unresolved: vec![],
            reasons: vec![],
            linked: HashSet::new(),
            comparison_errors: vec![],
        }
    }

    /// Record one unresolved item: the message still feeds the link count and the
    /// twelve-code census unchanged, while the coded record names the cause and
    /// its context for the report's `reasonCodes`.
    fn abstain(&mut self, record: ReasonCodeRecord) {
        self.unresolved.push(record.detail.clone());
        self.reasons.push(record);
    }

    fn abstain_endpoint(
        &mut self,
        code: ReasonCode,
        detail: impl Into<String>,
        file: &str,
        line: Option<u32>,
        source: ReasonSource,
        method: &str,
        path: &str,
    ) {
        self.abstain(
            ReasonCodeRecord::new(code, detail)
                .with_source(source)
                .with_location(file, line)
                .with_endpoint(method, path),
        );
    }

    fn note_artifact(&mut self, code: ReasonCode, detail: impl Into<String>) {
        self.reasons
            .push(ReasonCodeRecord::new(code, detail).with_source(ReasonSource::Artifact));
    }

    fn admit_all(
        &self,
        base: &ContractArtifactEnvelope,
        candidate: &ContractArtifactEnvelope,
        targets: &[ContractArtifactEnvelope],
        policy: &ArtifactTrustPolicy,
        trusted_local: bool,
    ) -> Vec<AnalysisBlocker> {
        let mut blockers = vec![];
        for (label, envelope) in [("base", base), ("candidate", candidate)].iter().chain(
            targets
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let label: &str = if i == 0 { "target[0]" } else { "target[N]" };
                    (label, t)
                })
                .collect::<Vec<_>>()
                .iter(),
        ) {
            if let Err(e) = admit_artifact(envelope, policy, trusted_local) {
                blockers.push(AnalysisBlocker {
                    code: BlockerCode::ToolFailure,
                    message: format!("{}: admission failed: {}", label, e),
                    file: None,
                });
            }
        }
        blockers
    }

    fn compare(
        &mut self,
        base: &ContractArtifactEnvelope,
        candidate: &ContractArtifactEnvelope,
        targets: &[ContractArtifactEnvelope],
    ) -> CrossLanguageImpactReport {
        self.unresolved.clear();
        self.reasons.clear();
        self.linked.clear();
        self.comparison_errors.clear();

        let mut findings: Vec<CrossLanguageFinding> = vec![];
        let mut blockers: Vec<AnalysisBlocker> = vec![];
        let mut unresolved_evidence: Vec<String> = vec![];

        if base.kind != candidate.kind
            || base.snapshot.repository_id != candidate.snapshot.repository_id
            || base.snapshot.service_id != candidate.snapshot.service_id
        {
            blockers.push(AnalysisBlocker {
                code: BlockerCode::ToolFailure,
                message: "Base and candidate identity mismatch.".to_string(),
                file: None,
            });
        }

        for e in std::iter::once(base)
            .chain(std::iter::once(candidate))
            .chain(targets.iter())
        {
            if e.envelope_version != base.envelope_version
                || e.report_schema_version != base.report_schema_version
            {
                blockers.push(AnalysisBlocker {
                    code: BlockerCode::ToolFailure,
                    message: "Artifact schema mismatch.".to_string(),
                    file: None,
                });
            }
            for b in &e.completeness.blockers {
                blockers.push(AnalysisBlocker {
                    code: parse_blocker_code(&b.code),
                    message: b.message.clone(),
                    file: b.file.clone(),
                });
            }
        }

        for key in ["frameworkProfile", "codecProfile", "clientProfile"] {
            if profile_key(base, key) != profile_key(candidate, key) {
                blockers.push(AnalysisBlocker {
                    code: BlockerCode::ToolFailure,
                    message: format!("Unqualified extraction profile migration: {}", key),
                    file: None,
                });
            }
        }

        let mut is_endpoint_resolved =
            base.completeness.complete && candidate.completeness.complete;

        if !base.completeness.complete {
            let detail = format!(
                "Base artifact {} is incomplete.",
                base.snapshot.candidate_snapshot
            );
            unresolved_evidence.push(detail.clone());
            self.note_artifact(ReasonCode::ArtifactIncomplete, detail);
        }
        if !candidate.completeness.complete {
            let detail = format!(
                "Candidate artifact {} is incomplete.",
                candidate.snapshot.candidate_snapshot
            );
            unresolved_evidence.push(detail.clone());
            self.note_artifact(ReasonCode::ArtifactIncomplete, detail);
        }

        if targets.is_empty() {
            blockers.push(AnalysisBlocker {
                code: BlockerCode::ToolFailure,
                message: "No targets provided for comparison.".to_string(),
                file: None,
            });
            is_endpoint_resolved = false;
        }

        let mut changed_endpoints_linked = HashSet::new();
        for target in targets {
            if !target.completeness.complete {
                is_endpoint_resolved = false;
                let detail = format!(
                    "Target artifact {} is incomplete.",
                    target.snapshot.candidate_snapshot
                );
                unresolved_evidence.push(detail.clone());
                self.note_artifact(ReasonCode::ArtifactIncomplete, detail);
            }

            match (&base.kind, &candidate.kind, &target.kind) {
                (
                    ArtifactKind::BackendContract,
                    ArtifactKind::BackendContract,
                    ArtifactKind::FrontendContract,
                ) => {
                    self.verify_backend_producer_against_clients(
                        base,
                        candidate,
                        target,
                        &mut findings,
                        &mut changed_endpoints_linked,
                    );
                }
                (
                    ArtifactKind::FrontendContract,
                    ArtifactKind::FrontendContract,
                    ArtifactKind::BackendContract,
                ) => {
                    self.verify_frontend_client_expectations(
                        base,
                        candidate,
                        target,
                        &mut findings,
                    );
                }
                _ => {
                    blockers.push(AnalysisBlocker {
                        code: BlockerCode::ToolFailure,
                        message: "Mismatched artifact kinds or invalid target.".to_string(),
                        file: None,
                    });
                }
            }

            // A consumer artifact whose declared target service matches nothing that was
            // compared would silently produce linked: 0. That is a configuration error, not
            // evidence of compatibility, so it must block rather than pass.
            let consumer_producer = match (&base.kind, &target.kind) {
                (ArtifactKind::BackendContract, ArtifactKind::FrontendContract) => {
                    Some((target, base))
                }
                (ArtifactKind::FrontendContract, ArtifactKind::BackendContract) => {
                    Some((candidate, target))
                }
                _ => None,
            };
            if let Some((consumer, producer)) = consumer_producer {
                if let Some(blocker) = unmatched_target_service_blocker(consumer, producer) {
                    blockers.push(blocker);
                    is_endpoint_resolved = false;
                }
            }
        }

        if let (ArtifactPayload::Backend(base_payload), ArtifactPayload::Backend(cand_payload)) =
            (&base.payload, &candidate.payload)
        {
            let changed_backend_endpoints =
                get_changed_backend_endpoints(base_payload, cand_payload);
            let applicable_targets_count = targets
                .iter()
                .filter(|t| is_target_applicable(candidate, t, self.require_service_mapping))
                .count();
            if applicable_targets_count > 0 && !changed_backend_endpoints.is_empty() {
                let unlinked: Vec<_> = changed_backend_endpoints
                    .into_iter()
                    .filter(|ep| {
                        let dir = match ep.identity.direction {
                            ContractDirection::Request => "REQUEST",
                            ContractDirection::Response => "RESPONSE",
                        };
                        !changed_endpoints_linked.contains(&format!(
                            "{}|{}",
                            route_key_for_endpoint(ep),
                            dir
                        ))
                    })
                    .collect();
                if !unlinked.is_empty() {
                    for ep in unlinked {
                        blockers.push(AnalysisBlocker {
                            code: BlockerCode::UnlinkedChangedEndpoint,
                            message: format!(
                                "Changed endpoint {} {} has no linked consumer in applicable target contracts.",
                                ep.identity.http_method, ep.identity.normalized_route.raw_path
                            ),
                            file: None,
                        });
                    }
                    is_endpoint_resolved = false;
                }
            }
        }

        blockers.append(&mut self.comparison_errors);
        // Artifact-level incompleteness belongs in evidence, not the link count.
        let mut seen_evidence: HashSet<String> = HashSet::new();
        self.unresolved
            .retain(|msg| seen_evidence.insert(msg.clone()));
        let mut abstentions_by_code: BTreeMap<String, usize> = BTreeMap::new();
        for msg in &self.unresolved {
            let code_str = match AbstentionCode::classify(msg) {
                Some(code) => code.as_str().to_string(),
                None => "UNCLASSIFIED".to_string(),
            };
            *abstentions_by_code.entry(code_str).or_default() += 1;
        }
        let unresolved_links = self.unresolved.len();
        if !self.unresolved.is_empty() {
            is_endpoint_resolved = false;
        }
        unresolved_evidence.append(&mut self.unresolved);
        self.reasons.sort();
        self.reasons.dedup();
        let reason_codes = std::mem::take(&mut self.reasons);

        let coverage_resolved = is_endpoint_resolved && self.unresolved.is_empty();
        let completeness = CompletenessAccounting {
            endpoint_resolved: is_endpoint_resolved,
            java_wire_resolved: coverage_resolved,
            ts_contract_resolved: coverage_resolved,
            request_resolved: coverage_resolved,
            response_resolved: coverage_resolved,
            consumer_traversal_complete: coverage_resolved,
            unresolved_evidence: unresolved_evidence.clone(),
        };

        let has_tool_failure = blockers.iter().any(|b| {
            matches!(
                b.code,
                BlockerCode::ToolFailure | BlockerCode::FileReadError
            )
        });

        let verdict = if has_tool_failure {
            CrossLanguageVerdict::AnalysisError
        } else if !findings.is_empty() {
            CrossLanguageVerdict::LikelyViolated
        } else if !is_endpoint_resolved || !blockers.is_empty() {
            CrossLanguageVerdict::Inconclusive
        } else {
            CrossLanguageVerdict::LikelyPreserved
        };

        let changed_endpoints = self.changed_count(base, candidate);
        let linked_endpoints = self.linked.len();
        let affected_consumers: usize = findings.iter().map(|f| f.consumers.len()).sum();
        let framework = candidate
            .profile
            .framework_profile
            .clone()
            .unwrap_or_else(|| crate::envelope::FRAMEWORK_SPRING_MVC.to_string());

        CrossLanguageImpactReport {
            delta: None,
            schema_version: SCHEMA_VERSION.to_string(),
            assurance: ASSURANCE.to_string(),
            verdict,
            property: crate::report::assessed_property_for_framework(&framework).to_string(),
            verdict_scope: Some(crate::report::VERDICT_SCOPE_STATIC_COMPAT.to_string()),
            advisories: vec![],
            repository: SnapshotIdentity {
                repository_id: candidate.snapshot.repository_id.clone(),
                parent_commit: candidate.snapshot.parent_commit.clone(),
                candidate_snapshot: candidate.snapshot.candidate_snapshot.clone(),
            },
            scope: AnalysisScope {
                framework,
                codec: candidate
                    .profile
                    .codec_profile
                    .clone()
                    .unwrap_or_else(|| "JACKSON_DEFAULT_V1".to_string()),
                client: targets
                    .first()
                    .and_then(|t| t.profile.client_profile.clone())
                    .unwrap_or_else(|| "STATIC_FETCH_V1".to_string()),
                complete: is_endpoint_resolved && blockers.is_empty(),
            },
            completeness: Some(completeness),
            reason_codes,
            findings,
            blockers,
            counts: AnalysisCounts {
                changed_endpoints,
                linked_endpoints,
                affected_consumers,
                unresolved_links,
                abstentions_by_code: Some(abstentions_by_code),
            },
            artifacts: Some(ArtifactRefs {
                base: artifact_ref(base),
                candidate: artifact_ref(candidate),
                targets: targets.iter().map(artifact_ref).collect(),
            }),
            telemetry: None,
        }
    }

    fn verify_backend_producer_against_clients(
        &mut self,
        base_env: &ContractArtifactEnvelope,
        cand_env: &ContractArtifactEnvelope,
        target_env: &ContractArtifactEnvelope,
        findings: &mut Vec<CrossLanguageFinding>,
        changed_endpoints_linked: &mut HashSet<String>,
    ) {
        let base_payload = match &base_env.payload {
            ArtifactPayload::Backend(p) => p,
            _ => return,
        };
        let cand_payload = match &cand_env.payload {
            ArtifactPayload::Backend(p) => p,
            _ => return,
        };
        let ts_targets = match &target_env.payload {
            ArtifactPayload::Frontend(p) => &p.client_contracts,
            _ => return,
        };

        if cand_env.completeness.complete {
            let cand_keys: HashSet<(String, Option<StatusCodeFamily>)> = cand_payload
                .endpoints
                .iter()
                .map(|e| (route_key_for_endpoint(e), e.status_code_family))
                .collect();
            for base_ep in &base_payload.endpoints {
                let base_family = base_ep.status_code_family;
                let exists_in_cand = cand_keys.iter().any(|(rk, fam)| {
                    rk == &route_key_for_endpoint(base_ep) && {
                        let is_base_error = base_family == Some(StatusCodeFamily::Error4xx5xx);
                        let is_cand_error = fam == &Some(StatusCodeFamily::Error4xx5xx);
                        is_base_error == is_cand_error
                    }
                });
                if !exists_in_cand {
                    let active: Vec<usize> = ts_targets
                        .iter()
                        .enumerate()
                        .filter(|(_, ts)| self.client_matches(ts, base_ep, cand_env))
                        .map(|(i, _)| i)
                        .collect();
                    if !active.is_empty() {
                        let dir = match base_ep.identity.direction {
                            ContractDirection::Request => "REQUEST",
                            ContractDirection::Response => "RESPONSE",
                        };
                        changed_endpoints_linked.insert(format!(
                            "{}|{}",
                            route_key_for_endpoint(base_ep),
                            dir
                        ));
                    }
                    for idx in active {
                        findings.push(self.make_finding(
                            base_ep,
                            &ts_targets[idx],
                            "endpoint",
                            "active",
                            "deleted in java target",
                            "calls deleted endpoint",
                            target_env,
                        ));
                    }
                }
            }
        }

        // Observed (untyped-client) evidence may only produce a finding against a real
        // base→candidate producer delta, so every candidate endpoint needs its base
        // counterpart before the consumer loop.
        let base_by_key: HashMap<String, &EndpointContract> = base_payload
            .endpoints
            .iter()
            .map(|ep| (observed_delta_key(ep), ep))
            .collect();

        let cand_eps: Vec<&EndpointContract> = cand_payload.endpoints.iter().collect();
        for cand_ep in cand_eps {
            if cand_ep.evidence_classification
                == Some(crate::ir::EvidenceClassification::InconclusiveOrConflicting)
            {
                self.comparison_errors.push(AnalysisBlocker {
                    code: BlockerCode::EvidenceConflict,
                    message: format!(
                        "Endpoint {} {} has conflicting evidence between AST implementation and declared OpenAPI annotation",
                        cand_ep.identity.http_method, cand_ep.identity.normalized_route.raw_path
                    ),
                    file: Some(cand_ep.provenance.file.clone()),
                });
            }
            let active: Vec<usize> = ts_targets
                .iter()
                .enumerate()
                .filter(|(_, ts)| self.client_matches(ts, cand_ep, cand_env))
                .map(|(i, _)| i)
                .collect();
            if !active.is_empty() {
                let dir = match cand_ep.identity.direction {
                    ContractDirection::Request => "REQUEST",
                    ContractDirection::Response => "RESPONSE",
                };
                changed_endpoints_linked.insert(format!(
                    "{}|{}",
                    route_key_for_endpoint(cand_ep),
                    dir
                ));
            }
            for idx in active {
                let consumer = &ts_targets[idx];
                self.account_client(consumer);
                self.account_endpoint_parameters(cand_ep);
                self.linked.insert(format!(
                    "{}:{}@{}",
                    consumer.source_file,
                    consumer.source_line,
                    target_env.snapshot.candidate_snapshot
                ));
                match cand_ep.identity.direction {
                    ContractDirection::Response => {
                        let observed = consumer.observed_response.as_ref();
                        let observed_only = observed.is_some()
                            && matches!(consumer.expected_response, WireType::Unknown(_));
                        if observed_only {
                            let base_ep = base_by_key.get(&observed_delta_key(cand_ep)).copied();
                            self.compare_observed_response(
                                base_ep,
                                &base_payload.type_pool,
                                &cand_payload.type_pool,
                                cand_ep,
                                consumer,
                                observed.expect("checked above"),
                                target_env,
                                findings,
                            );
                        }
                        match &cand_ep.body {
                            Some(body) => {
                                if !observed_only {
                                    self.compare_wire_types(
                                        body,
                                        &consumer.expected_response,
                                        cand_ep,
                                        consumer,
                                        "$",
                                        findings,
                                        "RESPONSE",
                                        target_env,
                                    );
                                } else if let Some(observed) = observed {
                                    match observed.status {
                                        ObservedResponseStatus::Observed
                                        | ObservedResponseStatus::NotConsumed => {}
                                        ObservedResponseStatus::Inconclusive => {
                                            let detail = format!(
                                                "{}:{}: untyped response usage is Inconclusive; response body cannot be followed to property reads",
                                                consumer.source_file, consumer.source_line
                                            );
                                            self.abstain_endpoint(
                                                ReasonCode::UntypedUsageInconclusive,
                                                detail,
                                                &consumer.source_file,
                                                Some(consumer.source_line),
                                                ReasonSource::Consumer,
                                                &cand_ep.identity.http_method,
                                                &cand_ep.identity.normalized_route.raw_path,
                                            );
                                        }
                                        _ => {
                                            let detail = format!(
                                                "{}:{}: untyped response usage is {:?}; response body contract is not established",
                                                consumer.source_file, consumer.source_line, observed.status
                                            );
                                            self.abstain_endpoint(
                                                ReasonCode::UntypedUsageInconclusive,
                                                detail,
                                                &consumer.source_file,
                                                Some(consumer.source_line),
                                                ReasonSource::Consumer,
                                                &cand_ep.identity.http_method,
                                                &cand_ep.identity.normalized_route.raw_path,
                                            );
                                        }
                                    }
                                }
                            }
                            None => {
                                if let Some(observed) = observed.filter(|_| observed_only) {
                                    match observed.status {
                                        // The client discards the response, so a bodyless
                                        // producer is not a missing requirement.
                                        ObservedResponseStatus::NotConsumed => {}
                                        ObservedResponseStatus::Observed => {
                                            // Already evaluated against the delta above; a
                                            // guaranteed read of a field that base emitted is
                                            // reported there, not as a body-level finding.
                                        }
                                        _ => {
                                            let detail = format!(
                                                "{}:{}: untyped response usage is {:?}; response body presence is not established",
                                                consumer.source_file, consumer.source_line, observed.status
                                            );
                                            self.abstain_endpoint(
                                                ReasonCode::UntypedUsageInconclusive,
                                                detail,
                                                &consumer.source_file,
                                                Some(consumer.source_line),
                                                ReasonSource::Consumer,
                                                &cand_ep.identity.http_method,
                                                &cand_ep.identity.normalized_route.raw_path,
                                            );
                                        }
                                    }
                                } else if matches!(consumer.expected_response, WireType::Unknown(_))
                                {
                                    self.abstain_endpoint(
                                        ReasonCode::UntypedUsageInconclusive,
                                        "Bodyless response with unknown consumer expectation",
                                        &consumer.source_file,
                                        Some(consumer.source_line),
                                        ReasonSource::Consumer,
                                        &cand_ep.identity.http_method,
                                        &cand_ep.identity.normalized_route.raw_path,
                                    );
                                } else if !is_void_type(&consumer.expected_response) {
                                    findings.push(self.make_finding(
                                        cand_ep,
                                        consumer,
                                        "$",
                                        "body present",
                                        "body absent (null)",
                                        "candidate response body removed; frontend requires response",
                                        target_env,
                                    ));
                                }
                            }
                        }
                    }
                    ContractDirection::Request => {
                        if let Some(body) = &cand_ep.body {
                            if consumer.request_body.is_none() {
                                if !matches!(body, WireType::Optional(_)) {
                                    if consumer.decoder_kind == DecoderKind::Unknown
                                        || consumer.consumer_traversal_complete != Some(true)
                                        || !consumer.unresolved_evidence.is_empty()
                                        || consumer.observed_request_body.is_some()
                                    {
                                        let detail = format!(
                                            "{}:{}: Request body expression could not be statically resolved from client call",
                                            consumer.source_file, consumer.source_line
                                        );
                                        self.abstain_endpoint(
                                            ReasonCode::RequestBodyExpressionUnresolved,
                                            detail,
                                            &consumer.source_file,
                                            Some(consumer.source_line),
                                            ReasonSource::Consumer,
                                            &cand_ep.identity.http_method,
                                            &cand_ep.identity.normalized_route.raw_path,
                                        );
                                    } else {
                                        findings.push(self.make_finding(
                                            cand_ep,
                                            consumer,
                                            "$",
                                            "absent",
                                            "required",
                                            "frontend missing required request body",
                                            target_env,
                                        ));
                                    }
                                }
                            } else if let Some(req_body) = &consumer.request_body {
                                self.compare_wire_types(
                                    body, req_body, cand_ep, consumer, "$", findings, "REQUEST",
                                    target_env,
                                );
                            }
                        }
                    }
                }
            }
        }

        // Fail-closed verification of client expectations against candidate backend endpoints
        for consumer in ts_targets {
            if let Some(ref target_service_id) = consumer.target_service_id {
                if target_service_id != &cand_env.snapshot.service_id {
                    continue;
                }
            }
            let matched = cand_payload
                .endpoints
                .iter()
                .any(|e| self.client_matches(consumer, e, cand_env));
            if !matched {
                if !cand_env.completeness.complete || cand_payload.endpoints.is_empty() {
                    let detail = format!(
                        "{}:{}: client expectation {} {} has no resolved candidate backend endpoint (extraction complete={})",
                        consumer.source_file,
                        consumer.source_line,
                        consumer.http_method,
                        consumer.normalized_route,
                        cand_env.completeness.complete
                    );
                    self.abstain_endpoint(
                        ReasonCode::NoLinkedEndpoint,
                        detail,
                        &consumer.source_file,
                        Some(consumer.source_line),
                        ReasonSource::Consumer,
                        &consumer.http_method,
                        &consumer.normalized_route,
                    );
                } else {
                    // Nothing linked this consumer in the candidate, which does not establish that an
                    // endpoint was deleted. Deletions are reported by the base-side scan above, where
                    // the vanished endpoint carries real provenance; here the cause is unknown.
                    let detail = format!(
                        "{}:{}: client expectation {} {} has no linked candidate backend endpoint ({}). Deletion is not established.",
                        consumer.source_file,
                        consumer.source_line,
                        consumer.http_method,
                        consumer.normalized_route,
                        if route_has_unresolved_placeholder(&consumer.normalized_route) {
                            "consumer route contains an unresolved interpolation placeholder"
                        } else {
                            "no candidate route match"
                        }
                    );
                    self.abstain_endpoint(
                        ReasonCode::NoLinkedEndpoint,
                        detail,
                        &consumer.source_file,
                        Some(consumer.source_line),
                        ReasonSource::Consumer,
                        &consumer.http_method,
                        &consumer.normalized_route,
                    );
                }
            }
        }
    }

    /// Report a field the base producer emitted and the candidate no longer emits when an
    /// untyped client reads it unconditionally. Absence in the candidate alone says nothing
    /// about whether the client ever depended on the field, so a single snapshot never
    /// produces a finding. Guarded reads and fallback alternatives cannot break and are
    /// skipped even if the producer removed the field.
    #[allow(clippy::too_many_arguments)]
    fn compare_observed_response(
        &mut self,
        base_ep: Option<&EndpointContract>,
        base_pool: &Option<BTreeMap<String, WireType>>,
        cand_pool: &Option<BTreeMap<String, WireType>>,
        cand_ep: &EndpointContract,
        consumer: &FrontendClientContract,
        observed: &ObservedResponseEvidence,
        target_env: &ContractArtifactEnvelope,
        findings: &mut Vec<CrossLanguageFinding>,
    ) {
        if observed.status != ObservedResponseStatus::Observed {
            return;
        }
        let Some(base_ep) = base_ep else { return };
        let Some(base_body) = base_ep.body.as_ref() else {
            return;
        };
        for access in &observed.accesses {
            if !access.guaranteed || access.alternative_group.is_some() {
                continue;
            }
            if path_present(base_body, &access.path, base_pool.as_ref()) != Some(true) {
                continue;
            }
            let still_present = match &cand_ep.body {
                Some(body) => path_present(body, &access.path, cand_pool.as_ref()),
                None => Some(false),
            };
            if still_present == Some(false) {
                findings.push(self.make_finding(
                    cand_ep,
                    consumer,
                    &access.path,
                    "present",
                    "removed",
                    "candidate response no longer emits a field the untyped client reads",
                    target_env,
                ));
            }
        }
    }

    fn verify_frontend_client_expectations(
        &mut self,
        _base_env: &ContractArtifactEnvelope,
        cand_env: &ContractArtifactEnvelope,
        target_env: &ContractArtifactEnvelope,
        findings: &mut Vec<CrossLanguageFinding>,
    ) {
        let cand_payload = match &cand_env.payload {
            ArtifactPayload::Frontend(p) => p,
            _ => return,
        };
        let java_targets = match &target_env.payload {
            ArtifactPayload::Backend(p) => &p.endpoints,
            _ => return,
        };
        let clients: Vec<&FrontendClientContract> = cand_payload.client_contracts.iter().collect();

        for cand_client in clients {
            self.account_client(cand_client);
            if let Some(ref svc) = cand_client.target_service_id {
                if *svc != target_env.snapshot.service_id {
                    continue;
                }
            }
            if let Some(ref ver) = cand_client.target_api_version {
                if target_env.snapshot.api_version.as_deref() != Some(ver.as_str()) {
                    self.abstain_endpoint(
                        ReasonCode::ApiVersionMismatch,
                        format!("{}: target API version mismatch", cand_client.source_file),
                        &cand_client.source_file,
                        Some(cand_client.source_line),
                        ReasonSource::Consumer,
                        &cand_client.http_method,
                        &cand_client.normalized_route,
                    );
                    continue;
                }
            }
            if self.require_service_mapping
                && cand_client.target_service_id.is_none()
                && !cand_client.normalized_route.starts_with("http://")
                && !cand_client.normalized_route.starts_with("https://")
            {
                self.abstain_endpoint(
                    ReasonCode::ServiceMappingRequired,
                    format!(
                        "{}: relative route requires targetServiceId",
                        cand_client.source_file
                    ),
                    &cand_client.source_file,
                    Some(cand_client.source_line),
                    ReasonSource::Consumer,
                    &cand_client.http_method,
                    &cand_client.normalized_route,
                );
                continue;
            }

            let unresolved_before = self.unresolved.len();
            let matched_idxs: Vec<usize> = java_targets
                .iter()
                .enumerate()
                .filter(|(_, j)| self.client_matches(cand_client, j, target_env))
                .map(|(i, _)| i)
                .collect();
            // A catch-all handler (`/**`) also matches every concrete route. When a client
            // matches both, the concrete handler is the one its request reaches; comparing
            // it against the catch-all's shape would report a break the consumer never sees.
            let matched_idxs = prefer_non_wildcard_matches(matched_idxs, java_targets);

            if matched_idxs.is_empty()
                && target_env.completeness.complete
                && !java_targets.is_empty()
                && self.unresolved.len() == unresolved_before
            {
                if route_has_unresolved_placeholder(&cand_client.normalized_route) {
                    // The consumer's own route was built from an interpolation the extractor could
                    // not resolve, so a missing counterpart here is a linking failure, not a fact
                    // about the backend.
                    let detail = format!(
                        "{}:{}: client expectation {} {} is built from an unresolved interpolation; route cannot be matched",
                        cand_client.source_file,
                        cand_client.source_line,
                        cand_client.http_method,
                        cand_client.normalized_route
                    );
                    self.abstain_endpoint(
                        ReasonCode::RoutePlaceholderUnresolved,
                        detail,
                        &cand_client.source_file,
                        Some(cand_client.source_line),
                        ReasonSource::Consumer,
                        &cand_client.http_method,
                        &cand_client.normalized_route,
                    );
                } else {
                    let dummy_ep = EndpointContract {
                        identity: crate::ir::EndpointIdentityContract {
                            service: None,
                            http_method: cand_client.http_method.clone(),
                            normalized_route: normalize_route_segments(
                                &cand_client.normalized_route,
                            ),
                            direction: ContractDirection::Response,
                        },
                        path_parameters: vec![],
                        query_parameters: vec![],
                        headers: vec![],
                        body: Some(WireType::Unknown(UnknownWireType {
                            reason: "Missing endpoint".to_string(),
                            provenance: None,
                        })),
                        provenance: SourceProvenance {
                            sha256: None,
                            language: SourceLanguage::Java,
                            file: "unknown".to_string(),
                            line: 0,
                            column: None,
                            ast_identity: None,
                            annotation_or_schema: None,
                            evidence_classification: None,
                        },
                        evidence_classification: None,
                        declared_responses: None,
                        status_code_family: None,
                        mapping_conditions: None,
                    };
                    findings.push(self.make_finding(
                        &dummy_ep,
                        cand_client,
                        "endpoint",
                        "not linked",
                        "no matching endpoint in java target",
                        &format!(
                            "calls a route absent from target {}@{}",
                            target_env.snapshot.repository_id,
                            target_env.snapshot.candidate_snapshot
                        ),
                        target_env,
                    ));
                }
            }

            for idx in matched_idxs {
                let j_ep = &java_targets[idx];
                self.linked.insert(format!(
                    "{}:{}@{}",
                    cand_client.source_file,
                    cand_client.source_line,
                    target_env.snapshot.candidate_snapshot
                ));
                self.account_endpoint_parameters(j_ep);
                match j_ep.identity.direction {
                    ContractDirection::Response => {
                        let observed = cand_client.observed_response.as_ref();
                        let observed_only = observed.is_some()
                            && matches!(cand_client.expected_response, WireType::Unknown(_));
                        if let Some(body) = &j_ep.body {
                            if !observed_only {
                                self.compare_wire_types(
                                    body,
                                    &cand_client.expected_response,
                                    j_ep,
                                    cand_client,
                                    "$",
                                    findings,
                                    "RESPONSE",
                                    target_env,
                                );
                            } else if let Some(observed) = observed {
                                match observed.status {
                                    ObservedResponseStatus::Observed
                                    | ObservedResponseStatus::NotConsumed => {}
                                    ObservedResponseStatus::Inconclusive => {
                                        let detail = format!(
                                            "{}:{}: untyped response usage is Inconclusive; response body cannot be followed to property reads",
                                            cand_client.source_file, cand_client.source_line
                                        );
                                        self.abstain_endpoint(
                                            ReasonCode::UntypedUsageInconclusive,
                                            detail,
                                            &cand_client.source_file,
                                            Some(cand_client.source_line),
                                            ReasonSource::Consumer,
                                            &j_ep.identity.http_method,
                                            &j_ep.identity.normalized_route.raw_path,
                                        );
                                    }
                                    _ => {
                                        let detail = format!(
                                            "{}:{}: untyped response usage is {:?}; response body contract is not established",
                                            cand_client.source_file, cand_client.source_line, observed.status
                                        );
                                        self.abstain_endpoint(
                                            ReasonCode::UntypedUsageInconclusive,
                                            detail,
                                            &cand_client.source_file,
                                            Some(cand_client.source_line),
                                            ReasonSource::Consumer,
                                            &j_ep.identity.http_method,
                                            &j_ep.identity.normalized_route.raw_path,
                                        );
                                    }
                                }
                            }
                        } else if let Some(observed) = &cand_client.observed_response {
                            // This mode compares one target snapshot, so no base→candidate
                            // producer delta exists and observed reads cannot prove removal.
                            match observed.status {
                                ObservedResponseStatus::NotConsumed => {}
                                _ => {
                                    let detail = format!(
                                        "{}:{}: untyped client observation is {:?}; a single target snapshot cannot establish response body removal",
                                        cand_client.source_file, cand_client.source_line, observed.status
                                    );
                                    self.abstain_endpoint(
                                        ReasonCode::UntypedUsageInconclusive,
                                        detail,
                                        &cand_client.source_file,
                                        Some(cand_client.source_line),
                                        ReasonSource::Consumer,
                                        &j_ep.identity.http_method,
                                        &j_ep.identity.normalized_route.raw_path,
                                    );
                                }
                            }
                        } else if matches!(cand_client.expected_response, WireType::Unknown(_)) {
                            self.abstain_endpoint(
                                ReasonCode::UntypedUsageInconclusive,
                                "Bodyless response with unknown consumer expectation",
                                &cand_client.source_file,
                                Some(cand_client.source_line),
                                ReasonSource::Consumer,
                                &j_ep.identity.http_method,
                                &j_ep.identity.normalized_route.raw_path,
                            );
                        } else if !is_void_type(&cand_client.expected_response) {
                            findings.push(self.make_finding(
                                j_ep,
                                cand_client,
                                "$",
                                "required response",
                                "body absent",
                                "backend response body absent; frontend requires response",
                                target_env,
                            ));
                        }
                    }
                    ContractDirection::Request => {
                        if let Some(body) = &j_ep.body {
                            if cand_client.request_body.is_none() {
                                if !matches!(body, WireType::Optional(_)) {
                                    if cand_client.decoder_kind == DecoderKind::Unknown
                                        || cand_client.consumer_traversal_complete != Some(true)
                                        || !cand_client.unresolved_evidence.is_empty()
                                        || cand_client.observed_request_body.is_some()
                                    {
                                        let detail = format!(
                                            "{}:{}: Request body expression could not be statically resolved from client call",
                                            cand_client.source_file, cand_client.source_line
                                        );
                                        self.abstain_endpoint(
                                            ReasonCode::RequestBodyExpressionUnresolved,
                                            detail,
                                            &cand_client.source_file,
                                            Some(cand_client.source_line),
                                            ReasonSource::Consumer,
                                            &j_ep.identity.http_method,
                                            &j_ep.identity.normalized_route.raw_path,
                                        );
                                    } else {
                                        findings.push(self.make_finding(
                                            j_ep,
                                            cand_client,
                                            "$",
                                            "absent",
                                            "required",
                                            "frontend missing required request body",
                                            target_env,
                                        ));
                                    }
                                }
                            } else if let Some(req_body) = &cand_client.request_body {
                                self.compare_wire_types(
                                    body,
                                    req_body,
                                    j_ep,
                                    cand_client,
                                    "$",
                                    findings,
                                    "REQUEST",
                                    target_env,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn compare_wire_types(
        &mut self,
        j_type: &WireType,
        ts_type: &WireType,
        java_ep: &EndpointContract,
        ts_req: &FrontendClientContract,
        wire_path: &str,
        findings: &mut Vec<CrossLanguageFinding>,
        direction: &str,
        target_env: &ContractArtifactEnvelope,
    ) {
        let (produced, mut accepted) = if direction == "RESPONSE" {
            (j_type.clone(), ts_type.clone())
        } else {
            (ts_type.clone(), j_type.clone())
        };
        if direction == "RESPONSE" {
            if let WireType::Object(obj) = &accepted {
                if matches!(ts_req.decoder_kind, DecoderKind::ZodStrict) {
                    accepted = WireType::Object(ObjectWireType {
                        strict: Some(true),
                        ..obj.clone()
                    });
                }
            }
        }
        let path_prefix = if direction == "REQUEST" {
            format!("request.{}", wire_path)
        } else {
            wire_path.to_string()
        };
        for issue in wire_inclusion(&produced, &accepted, &path_prefix, 0) {
            if issue.unresolved {
                let detail = format!(
                    "{}:{} {}: {}",
                    ts_req.source_file, ts_req.source_line, issue.path, issue.reason
                );
                let code = ReasonCode::classify(&issue.reason)
                    .unwrap_or(ReasonCode::WireContractUnresolved);
                self.abstain_endpoint(
                    code,
                    detail,
                    &ts_req.source_file,
                    Some(ts_req.source_line),
                    ReasonSource::Comparison,
                    &java_ep.identity.http_method,
                    &java_ep.identity.normalized_route.raw_path,
                );
            } else {
                findings.push(self.make_finding(
                    java_ep,
                    ts_req,
                    &issue.path,
                    &issue.before,
                    &issue.after,
                    &issue.reason,
                    target_env,
                ));
            }
        }
    }

    fn account_endpoint_parameters(&mut self, endpoint: &EndpointContract) {
        // V1 consumers carry no evidence of supplied parameter values.
        for (location, params) in [
            ("path", &endpoint.path_parameters),
            ("query", &endpoint.query_parameters),
            ("header", &endpoint.headers),
        ] {
            for param in params {
                if param.required
                    || param
                        .validation_constraints
                        .as_ref()
                        .is_some_and(|v| !v.is_empty())
                {
                    let detail = format!(
                        "{} {}: {} parameter {} requires unqualified consumer evidence",
                        endpoint.identity.http_method,
                        endpoint.identity.normalized_route.raw_path,
                        location,
                        param.name
                    );
                    self.abstain_endpoint(
                        ReasonCode::ParameterValueNoEvidence,
                        detail,
                        &endpoint.provenance.file,
                        Some(endpoint.provenance.line),
                        ReasonSource::Producer,
                        &endpoint.identity.http_method,
                        &endpoint.identity.normalized_route.raw_path,
                    );
                }
            }
        }
    }

    fn account_client(&mut self, c: &FrontendClientContract) {
        for item in &c.unresolved_evidence {
            let code = ReasonCode::classify(item).unwrap_or(ReasonCode::Unclassified);
            self.abstain_endpoint(
                code,
                item.clone(),
                &c.source_file,
                Some(c.source_line),
                ReasonSource::Consumer,
                &c.http_method,
                &c.normalized_route,
            );
        }
        if c.consumer_traversal_complete == Some(false)
            || (self.require_service_mapping && c.consumer_traversal_complete != Some(true))
        {
            let detail = format!(
                "{}: consumer traversal incomplete or unqualified",
                c.source_file
            );
            self.abstain_endpoint(
                ReasonCode::ClientTraversalIncomplete,
                detail,
                &c.source_file,
                Some(c.source_line),
                ReasonSource::Consumer,
                &c.http_method,
                &c.normalized_route,
            );
        }
    }

    fn client_matches(
        &mut self,
        c: &FrontendClientContract,
        ep: &EndpointContract,
        backend: &ContractArtifactEnvelope,
    ) -> bool {
        match link_client_to_endpoint(c, ep, backend, self.require_service_mapping) {
            ClientLink::Linked {
                unverified_constraint,
                ..
            } => {
                if unverified_constraint {
                    let detail = format!(
                        "{}: route constraint or wildcard is unverified",
                        c.source_file
                    );
                    self.abstain_endpoint(
                        ReasonCode::RouteConstraintUnverified,
                        detail,
                        &c.source_file,
                        Some(c.source_line),
                        ReasonSource::Consumer,
                        &c.http_method,
                        &c.normalized_route,
                    );
                }
                true
            }
            ClientLink::Blocked(block) => {
                let detail = format!("{}: {}", c.source_file, block.reason());
                let code = match block {
                    ClientLinkBlock::TargetServiceMismatch => ReasonCode::ServiceTargetMismatch,
                    ClientLinkBlock::TargetApiVersionMismatch => ReasonCode::ApiVersionMismatch,
                    ClientLinkBlock::UndeclaredAbsoluteUrl => ReasonCode::UndeclaredAbsoluteUrl,
                    ClientLinkBlock::RelativeRouteWithoutTargetService => {
                        ReasonCode::ServiceMappingRequired
                    }
                };
                self.abstain_endpoint(
                    code,
                    detail,
                    &c.source_file,
                    Some(c.source_line),
                    ReasonSource::Consumer,
                    &c.http_method,
                    &c.normalized_route,
                );
                false
            }
            ClientLink::NotLinked => false,
        }
    }

    fn changed_count(&self, a: &ContractArtifactEnvelope, b: &ContractArtifactEnvelope) -> usize {
        let ea = envelope_entries(a);
        let eb = envelope_entries(b);
        let ma: HashMap<_, _> = ea.into_iter().collect();
        let mb: HashMap<_, _> = eb.into_iter().collect();
        let all: HashSet<&String> = ma.keys().chain(mb.keys()).collect();
        all.iter()
            .filter(|k| ma.get(k.as_str()) != mb.get(k.as_str()))
            .count()
    }

    #[allow(clippy::too_many_arguments)]
    fn make_finding(
        &self,
        ep: &EndpointContract,
        ts_req: &FrontendClientContract,
        wire_path: &str,
        before: &str,
        after: &str,
        hint: &str,
        target_env: &ContractArtifactEnvelope,
    ) -> CrossLanguageFinding {
        let direction = match ep.identity.direction {
            ContractDirection::Request => "REQUEST",
            ContractDirection::Response => "RESPONSE",
        };
        let id = build_finding_id_from_parts(
            &ep.identity.http_method,
            &ep.identity.normalized_route.raw_path,
            &ep.provenance.file,
            direction,
            wire_path,
            before,
            after,
            &ts_req.source_file,
            ts_req.source_line,
            &target_env.snapshot.repository_id,
            &target_env.snapshot.candidate_snapshot,
        );
        let mut evidence: Vec<EvidenceItem> = vec![];
        if let Some(ref sha) = ep.provenance.sha256 {
            evidence.push(EvidenceItem {
                kind: EvidenceKind::JavaSource,
                file: ep.provenance.file.clone(),
                sha256: sha.clone(),
                line: Some(ep.provenance.line),
            });
        }
        if let Some(ref sha) = ts_req.source_sha256 {
            evidence.push(EvidenceItem {
                kind: EvidenceKind::TsSource,
                file: ts_req.source_file.clone(),
                sha256: sha.clone(),
                line: Some(ts_req.source_line),
            });
        }
        if let Some(ref integrity) = target_env.integrity {
            evidence.push(EvidenceItem {
                kind: EvidenceKind::Manifest,
                file: format!(
                    "artifact:{}@{}",
                    target_env.snapshot.repository_id, target_env.snapshot.candidate_snapshot
                ),
                sha256: integrity.sha256.clone(),
                line: None,
            });
        }
        let expectation_kind = if matches!(ts_req.decoder_kind, DecoderKind::Unknown) {
            TsExpectationKind::Unknown
        } else {
            TsExpectationKind::InferredType
        };
        CrossLanguageFinding {
            id,
            endpoint: EndpointLocation {
                method: ep.identity.http_method.clone(),
                path: ep.identity.normalized_route.raw_path.clone(),
                java_file: ep.provenance.file.clone(),
                line: ep.provenance.line,
            },
            wire_path: wire_path.to_string(),
            change: ChangeRecord {
                before: before.to_string(),
                after: after.to_string(),
            },
            typescript_client: TypeScriptClientRef {
                file: ts_req.source_file.clone(),
                line: ts_req.source_line,
                expectation: format!(
                    "{} {}",
                    ep.identity.http_method, ep.identity.normalized_route.raw_path
                ),
                expectation_kind,
            },
            consumers: ts_req
                .consumers
                .iter()
                .map(|c| ConsumerSite {
                    file: c.file.clone(),
                    line: c.line,
                    column: c.column,
                    usage: c.usage.clone(),
                })
                .collect(),
            evidence,
            repair_hint: format!(
                "{} for {} {}",
                hint, ep.identity.http_method, ep.identity.normalized_route.raw_path
            ),
            id_v2: None,
            classification: None,
        }
    }
}

/// Which route rule linked a client to an endpoint. Only `Exact` is a literal route match; the
/// `/api` rules are heuristics and must be labelled as such wherever a link is reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteLinkRule {
    Exact,
    ClientApiPrefixAdded,
    ProviderApiPrefixStripped,
}

impl RouteLinkRule {
    pub fn label(self) -> &'static str {
        match self {
            RouteLinkRule::Exact => "EXACT",
            RouteLinkRule::ClientApiPrefixAdded => "CLIENT_API_PREFIX_ADDED",
            RouteLinkRule::ProviderApiPrefixStripped => "PROVIDER_API_PREFIX_STRIPPED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientLinkBlock {
    TargetServiceMismatch,
    TargetApiVersionMismatch,
    UndeclaredAbsoluteUrl,
    RelativeRouteWithoutTargetService,
}

impl ClientLinkBlock {
    pub fn reason(self) -> &'static str {
        match self {
            ClientLinkBlock::TargetServiceMismatch => "target service mismatch",
            ClientLinkBlock::TargetApiVersionMismatch => "target API version mismatch",
            ClientLinkBlock::UndeclaredAbsoluteUrl => "undeclared absolute service URL",
            ClientLinkBlock::RelativeRouteWithoutTargetService => {
                "relative route requires targetServiceId"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientLink {
    Linked {
        rule: RouteLinkRule,
        unverified_constraint: bool,
    },
    NotLinked,
    Blocked(ClientLinkBlock),
}

/// The comparison engine's client-to-endpoint linkage, exposed so other reports link consumers by
/// exactly the same rules instead of a second matcher.
/// Keep only the most specific matches for one client: a match whose route contains no
/// wildcard segments beats one that needs a wildcard. When every candidate needs a
/// wildcard, all are kept so the existing ambiguity handling still sees them.
fn prefer_non_wildcard_matches(
    mut indices: Vec<usize>,
    endpoints: &[EndpointContract],
) -> Vec<usize> {
    if indices.len() <= 1 {
        return indices;
    }
    let wildcard_count = |index: usize| {
        endpoints[index]
            .identity
            .normalized_route
            .segments
            .iter()
            .filter(|segment| segment.is_wildcard == Some(true))
            .count()
    };
    let best = indices.iter().map(|index| wildcard_count(*index)).min();
    if let Some(best) = best {
        indices.retain(|index| wildcard_count(*index) == best);
    }
    indices
}

pub fn link_client_to_endpoint(
    c: &FrontendClientContract,
    ep: &EndpointContract,
    backend: &ContractArtifactEnvelope,
    require_service_mapping: bool,
) -> ClientLink {
    // Error handlers (4xx / 5xx) are never matched against standard client requests expecting 2xx
    if ep.status_code_family == Some(crate::ir::StatusCodeFamily::Error4xx5xx) {
        return ClientLink::NotLinked;
    }
    if c.http_method.to_uppercase() != ep.identity.http_method.to_uppercase() {
        return ClientLink::NotLinked;
    }
    // A client route whose leading prefix could not be resolved (`/:param/:param/info`)
    // names no path family. A catch-all handler matches it only because both sides are
    // parameters, which is not evidence that the request reaches that handler.
    if route_starts_with_unresolved_prefix(&c.normalized_route)
        && ep
            .identity
            .normalized_route
            .segments
            .iter()
            .any(|segment| segment.is_wildcard == Some(true))
    {
        return ClientLink::NotLinked;
    }
    if let Some(ref svc) = c.target_service_id {
        if *svc != backend.snapshot.service_id {
            return ClientLink::Blocked(ClientLinkBlock::TargetServiceMismatch);
        }
    }
    if let Some(ref ver) = c.target_api_version {
        if backend.snapshot.api_version.as_deref() != Some(ver.as_str()) {
            return ClientLink::Blocked(ClientLinkBlock::TargetApiVersionMismatch);
        }
    }
    let backend_payload = match &backend.payload {
        ArtifactPayload::Backend(p) => p,
        _ => return ClientLink::NotLinked,
    };
    let mut path = c.normalized_route.clone();
    if path.starts_with("http://") || path.starts_with("https://") {
        let matched = backend_payload
            .base_urls
            .iter()
            .map(|b| b.trim_end_matches('/'))
            .filter(|b| path == *b || path.starts_with(&format!("{}/", b)))
            .max_by_key(|b| b.len())
            .map(|s| s.to_string());
        match matched {
            Some(base) => {
                path = if path.len() > base.len() {
                    path[base.len()..].to_string()
                } else {
                    "/".to_string()
                };
            }
            None => return ClientLink::Blocked(ClientLinkBlock::UndeclaredAbsoluteUrl),
        }
    } else if require_service_mapping && c.target_service_id.is_none() {
        return ClientLink::Blocked(ClientLinkBlock::RelativeRouteWithoutTargetService);
    }
    let pfx = backend_payload
        .proxy_prefixes
        .iter()
        .filter(|p| !p.is_empty() && (path == **p || path.starts_with(&format!("{}/", p))))
        .max_by_key(|p| p.len())
        .map(|s| s.to_string());
    if let Some(prefix) = pfx {
        path = if path.len() > prefix.len() {
            path[prefix.len()..].to_string()
        } else {
            "/".to_string()
        };
    }
    let clean = path.split('?').next().unwrap_or(&path).to_string();
    let a = normalize_route_segments(&clean);
    let b = normalize_route_segments(&ep.identity.normalized_route.raw_path);
    let mut rule = RouteLinkRule::Exact;
    let mut result = match_routes(&a, &b);
    if !result.matches && !clean.starts_with("/api") {
        let with_api = format!("/api/{}", clean.trim_start_matches('/'));
        let a_api = normalize_route_segments(&with_api);
        let r2 = match_routes(&a_api, &b);
        if r2.matches {
            result = r2;
            rule = RouteLinkRule::ClientApiPrefixAdded;
        }
    }
    if !result.matches && ep.identity.normalized_route.raw_path.starts_with("/api") {
        let stripped = ep
            .identity
            .normalized_route
            .raw_path
            .trim_start_matches("/api");
        let b_stripped = normalize_route_segments(stripped);
        let r3 = match_routes(&a, &b_stripped);
        if r3.matches {
            result = r3;
            rule = RouteLinkRule::ProviderApiPrefixStripped;
        }
    }
    if !result.matches {
        return ClientLink::NotLinked;
    }
    let unverified_constraint = b.segments.iter().enumerate().any(|(i, seg)| {
        seg.is_wildcard.unwrap_or(false)
            || seg.regex_constraint.as_ref().is_some_and(|rc| {
                a.segments.get(i).and_then(|s| s.regex_constraint.as_ref()) != Some(rc)
            })
    });
    ClientLink::Linked {
        rule,
        unverified_constraint,
    }
}

fn artifact_ref(e: &ContractArtifactEnvelope) -> ArtifactRef {
    ArtifactRef {
        repository_id: e.snapshot.repository_id.clone(),
        service_id: e.snapshot.service_id.clone(),
        api_version: e.snapshot.api_version.clone(),
        snapshot: e.snapshot.candidate_snapshot.clone(),
        digest: e.integrity.as_ref().map(|i| i.sha256.clone()),
    }
}

fn profile_key(e: &ContractArtifactEnvelope, key: &str) -> Option<String> {
    match key {
        "frameworkProfile" => e.profile.framework_profile.clone(),
        "codecProfile" => e.profile.codec_profile.clone(),
        "clientProfile" => e.profile.client_profile.clone(),
        _ => None,
    }
}

/// Base and candidate must be joined on the same route, direction and success/error
/// family. `route_key_for_endpoint` covers service, method and normalized segments.
fn observed_delta_key(ep: &EndpointContract) -> String {
    let direction = match ep.identity.direction {
        ContractDirection::Request => "REQUEST",
        ContractDirection::Response => "RESPONSE",
    };
    let family = if ep.status_code_family == Some(StatusCodeFamily::Error4xx5xx) {
        "ERROR"
    } else {
        "SUCCESS"
    };
    format!("{}|{}|{}", route_key_for_endpoint(ep), direction, family)
}

fn is_void_type(t: &WireType) -> bool {
    match t {
        WireType::Primitive(p) => matches!(p.scalar, crate::ir::PrimitiveScalar::Void),
        WireType::Optional(o) => is_void_type(&o.inner_type),
        _ => false,
    }
}

/// `:param` is the token the TypeScript extractor writes for an interpolation it could not
/// resolve, so such a route is only an approximation of the real URL.
fn route_has_unresolved_placeholder(route: &str) -> bool {
    route.split('/').any(|segment| segment.contains(":param"))
}

/// True when the route's first segment is an unresolved placeholder. The extractor
/// writes a leading `:param` when a base-URL prefix could not be resolved; the real
/// family of paths beyond it is unknown.
fn route_starts_with_unresolved_prefix(route: &str) -> bool {
    route.trim_start_matches('/').starts_with(":param")
}

fn parse_blocker_code(code: &str) -> BlockerCode {
    // Preserve every qualified V1 code. An unknown future extraction warning is
    // unresolved evidence, not an invented fatal tool failure.
    if let Ok(b) = serde_json::from_value(serde_json::Value::String(code.to_owned())) {
        return b;
    }
    if code.starts_with("JAVA_") {
        return BlockerCode::JavaParseError;
    }
    // Any unclassified extraction warning is unresolved evidence, not a fatal engine crash.
    BlockerCode::UnresolvedTsClient
}

/// Compare the service ids a consumer artifact declares against the producer it is being
/// checked against. Contracts without a declared id are relative routes handled by the
/// normal matching rules, so they do not trigger this check.
fn unmatched_target_service_blocker(
    consumer: &ContractArtifactEnvelope,
    producer: &ContractArtifactEnvelope,
) -> Option<AnalysisBlocker> {
    let payload = match &consumer.payload {
        ArtifactPayload::Frontend(p) => p,
        _ => return None,
    };
    if payload.client_contracts.is_empty() {
        return None;
    }
    let declared: std::collections::BTreeSet<&str> = payload
        .client_contracts
        .iter()
        .filter_map(|c| c.target_service_id.as_deref())
        .collect();
    if declared.is_empty() || declared.contains(producer.snapshot.service_id.as_str()) {
        return None;
    }
    let declared_list = declared.into_iter().collect::<Vec<_>>().join(", ");
    Some(AnalysisBlocker {
        code: BlockerCode::UnmatchedTargetServiceId,
        message: format!(
            "{} consumer contract(s) declare target service id(s) [{declared_list}] but the compared backend is service id '{}'; no consumer can link, so an empty finding set is a configuration mismatch, not evidence of compatibility",
            payload.client_contracts.len(),
            producer.snapshot.service_id
        ),
        file: None,
    })
}

fn envelope_entries(e: &ContractArtifactEnvelope) -> Vec<(String, String)> {
    match &e.payload {
        ArtifactPayload::Backend(p) => p
            .endpoints
            .iter()
            .map(|ep| {
                let dir = match ep.identity.direction {
                    ContractDirection::Request => "REQUEST",
                    ContractDirection::Response => "RESPONSE",
                };
                (
                    format!("{}|{}", route_key_for_endpoint(ep), dir),
                    canonical_json(&json!([
                        ep.body,
                        ep.path_parameters,
                        ep.query_parameters,
                        ep.headers
                    ])),
                )
            })
            .collect(),
        ArtifactPayload::Frontend(p) => p
            .client_contracts
            .iter()
            .map(|c| {
                (
                    format!("{}:{}", c.source_file, c.source_line),
                    canonical_json(&json!([
                        c.normalized_route,
                        c.request_body,
                        c.expected_response
                    ])),
                )
            })
            .collect(),
    }
}

pub fn check_contract(input: CheckContractInput) -> Result<CrossLanguageImpactReport> {
    check_contract_refs(
        &input.base,
        &input.candidate,
        &input.targets,
        &input.policy,
        input.trusted_local,
        input.require_service_mapping,
    )
}

pub(crate) fn check_contract_refs(
    base: &ContractArtifactEnvelope,
    candidate: &ContractArtifactEnvelope,
    targets: &[ContractArtifactEnvelope],
    policy: &ArtifactTrustPolicy,
    trusted_local: bool,
    require_service_mapping: bool,
) -> Result<CrossLanguageImpactReport> {
    let ae = Engine::new(require_service_mapping);
    let ab = ae.admit_all(base, candidate, targets, policy, trusted_local);
    if ab
        .iter()
        .any(|b| matches!(b.code, BlockerCode::ToolFailure))
    {
        let repo = SnapshotIdentity {
            repository_id: candidate.snapshot.repository_id.clone(),
            parent_commit: candidate.snapshot.parent_commit.clone(),
            candidate_snapshot: candidate.snapshot.candidate_snapshot.clone(),
        };
        return Ok(make_error_report(
            repo,
            BlockerCode::ToolFailure,
            ab[0].message.clone(),
        ));
    }
    let mut engine = Engine::new(require_service_mapping);
    Ok(engine.compare(base, candidate, targets))
}

fn is_target_applicable(
    backend: &ContractArtifactEnvelope,
    target: &ContractArtifactEnvelope,
    require_service_mapping: bool,
) -> bool {
    if let ArtifactPayload::Frontend(fp) = &target.payload {
        if require_service_mapping {
            return fp.client_contracts.iter().any(|c| {
                c.target_service_id.as_deref() == Some(&backend.snapshot.service_id)
                    || (c.target_service_id.is_none()
                        && (c.normalized_route.starts_with("http://")
                            || c.normalized_route.starts_with("https://")))
            }) || target.snapshot.service_id == backend.snapshot.service_id;
        }
        let calls_with_service: Vec<_> = fp
            .client_contracts
            .iter()
            .filter(|c| c.target_service_id.is_some())
            .collect();
        if !calls_with_service.is_empty()
            && calls_with_service
                .iter()
                .all(|c| c.target_service_id.as_deref() != Some(&backend.snapshot.service_id))
        {
            return false;
        }
        return true;
    }
    true
}

fn get_changed_backend_endpoints<'a>(
    base: &'a crate::envelope::BackendContractPayload,
    cand: &'a crate::envelope::BackendContractPayload,
) -> Vec<&'a EndpointContract> {
    let mut cand_entry_map = HashMap::new();
    for ep in &cand.endpoints {
        let dir = match ep.identity.direction {
            ContractDirection::Request => "REQUEST",
            ContractDirection::Response => "RESPONSE",
        };
        cand_entry_map.insert(format!("{}|{}", route_key_for_endpoint(ep), dir), ep);
    }
    let mut base_entry_map = HashMap::new();
    for ep in &base.endpoints {
        let dir = match ep.identity.direction {
            ContractDirection::Request => "REQUEST",
            ContractDirection::Response => "RESPONSE",
        };
        base_entry_map.insert(format!("{}|{}", route_key_for_endpoint(ep), dir), ep);
    }
    let mut changed = Vec::new();
    for base_ep in &base.endpoints {
        let dir = match base_ep.identity.direction {
            ContractDirection::Request => "REQUEST",
            ContractDirection::Response => "RESPONSE",
        };
        let key = format!("{}|{}", route_key_for_endpoint(base_ep), dir);
        if !cand_entry_map.contains_key(&key) {
            changed.push(base_ep);
        }
    }
    for cand_ep in &cand.endpoints {
        let dir = match cand_ep.identity.direction {
            ContractDirection::Request => "REQUEST",
            ContractDirection::Response => "RESPONSE",
        };
        let key = format!("{}|{}", route_key_for_endpoint(cand_ep), dir);
        if let Some(base_ep) = base_entry_map.get(&key) {
            let base_sig = canonical_json(&json!([
                base_ep.body,
                base_ep.path_parameters,
                base_ep.query_parameters,
                base_ep.headers,
                base_ep.status_code_family
            ]));
            let cand_sig = canonical_json(&json!([
                cand_ep.body,
                cand_ep.path_parameters,
                cand_ep.query_parameters,
                cand_ep.headers,
                cand_ep.status_code_family
            ]));
            if base_sig != cand_sig {
                changed.push(cand_ep);
            }
        } else {
            changed.push(cand_ep);
        }
    }
    changed
}
