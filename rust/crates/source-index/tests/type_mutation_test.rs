//! Teeth tests for the wire-type lattice: a TypeScript type that narrows or
//! contradicts the Java producer must surface as a finding, and a type the
//! extractor cannot model must surface as unresolved evidence, never as a
//! silent match.

use contract_core::admission::{ArtifactTrustPolicy, TrustedProducer};
use contract_core::comparison::{check_contract, CheckContractInput};
use contract_core::envelope::ContractArtifactEnvelope;
use source_index::java_routes::{ConfigInputs, JavaRouteExtractor};
use source_index::ts_routes::TypeScriptRouteExtractor;
use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

const CONTROLLER: &str = r#"
package demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {
    @GetMapping("/api/accounts")
    public AccountDto get() {
        return new AccountDto();
    }
}
"#;

fn java_envelope(dto_field_type: &str) -> ContractArtifactEnvelope {
    let repo_root = tempdir().expect("tempdir");
    let dto = format!(
        "package demo;\n\npublic class AccountDto {{\n    public {dto_field_type} lastName;\n}}\n"
    );
    let sources = vec![
        (
            "src/main/java/demo/AccountController.java".to_string(),
            CONTROLLER.to_string(),
        ),
        ("src/main/java/demo/AccountDto.java".to_string(), dto),
    ];
    JavaRouteExtractor::from_blobs(
        repo_root.path().to_path_buf(),
        sources,
        ConfigInputs::default(),
    )
    .expect("java extractor")
    .build_envelope("backend", None, "HEAD")
    .expect("java envelope")
}

fn ts_envelope(field_type: &str) -> ContractArtifactEnvelope {
    let dir = tempdir().expect("tempdir");
    let src_dir = dir.path().join("src");
    fs::create_dir_all(&src_dir).expect("create src");
    fs::write(
        src_dir.join("account.model.ts"),
        format!("export interface Account {{\n  lastName: {field_type};\n}}\n"),
    )
    .expect("write model");
    fs::write(
        src_dir.join("account.service.ts"),
        r#"
import { Account } from './account.model';

export class AccountService {
  constructor(private http: any) {}
  get(): Observable<Account> { return this.http.get<Account>('/api/accounts'); }
}
"#,
    )
    .expect("write service");
    let repo_root: PathBuf = dir.path().to_path_buf();
    TypeScriptRouteExtractor::new(repo_root, &src_dir)
        .expect("ts extractor")
        .build_envelope("ui", "backend", "HEAD")
        .expect("ts envelope")
}

/// Mirror the production path: artifacts are written to disk, parsed back with
/// their raw JSON retained, and only then expanded. Expanding an in-memory
/// envelope would invalidate the sealed digest instead.
fn round_trip(mut envelope: ContractArtifactEnvelope) -> ContractArtifactEnvelope {
    let json = serde_json::to_vec(&envelope).expect("serialize envelope");
    envelope = contract_core::envelope::parse_envelope(&json).expect("parse envelope");
    contract_core::expansion::expand_type_pool(&mut envelope).expect("expand type pool");
    envelope
}

fn policy() -> ArtifactTrustPolicy {
    let producer = |repository_id: &str, service_id: &str| TrustedProducer {
        repository_id: repository_id.to_string(),
        service_id: service_id.to_string(),
        public_key_pem: None,
        trusted_digests: None,
        public_key_id: None,
        public_key_der_hex: None,
        valid_until: None,
        environments: None,
        signature_format: None,
    };
    ArtifactTrustPolicy {
        producers: vec![
            producer("git-root:native", "backend"),
            producer("git-root:ui", "ui"),
        ],
        require_signatures: false,
        ..Default::default()
    }
}

fn compare(ts_field_type: &str) -> contract_core::report::CrossLanguageImpactReport {
    check_contract(CheckContractInput {
        base: round_trip(java_envelope("String")),
        candidate: round_trip(java_envelope("String")),
        targets: vec![round_trip(ts_envelope(ts_field_type))],
        policy: policy(),
        trusted_local: true,
        require_service_mapping: true,
    })
    .expect("check contract")
}

fn last_name_findings(report: &contract_core::report::CrossLanguageImpactReport) -> usize {
    report
        .findings
        .iter()
        .filter(|f| f.wire_path == "$.lastName")
        .count()
}

#[test]
fn test_ts_string_to_number_mutation_is_a_finding() {
    let control = compare("string | null");
    assert_eq!(
        last_name_findings(&control),
        0,
        "matching types that accept null must not produce a finding: {:?}",
        control.findings
    );

    let mutated = compare("number | null");
    assert_eq!(
        last_name_findings(&mutated),
        1,
        "`string -> number` must be reported at the field, not swallowed: {:?}",
        mutated.findings
    );
    let finding = mutated
        .findings
        .iter()
        .find(|f| f.wire_path == "$.lastName")
        .expect("finding");
    assert!(
        finding.change.before.contains("number") || finding.change.after.contains("number"),
        "the finding must identify the scalar disagreement: {:?}",
        finding.change
    );
}

#[test]
fn test_null_and_scalar_disagreements_are_both_reported() {
    // A Java reference type accepts null, so `number` disagrees twice: the
    // scalar type and the null obligation. One issue must not mask the other.
    let report = compare("number");
    let findings: Vec<&contract_core::report::CrossLanguageFinding> = report
        .findings
        .iter()
        .filter(|f| f.wire_path == "$.lastName")
        .collect();
    assert!(
        findings
            .iter()
            .any(|f| f.repair_hint.contains("does not accept null")),
        "the null obligation must be reported: {:?}",
        findings
    );
    assert!(
        findings
            .iter()
            .any(|f| f.change.before.contains("number") || f.change.after.contains("number")),
        "the scalar disagreement must be reported: {:?}",
        findings
    );
}

#[test]
fn test_nullable_string_is_accepted_not_unresolved() {
    let report = compare("string | null");
    assert_eq!(
        last_name_findings(&report),
        0,
        "Java String is accepted by `string | null`: {:?}",
        report.findings
    );
    assert!(
        !report
            .completeness
            .as_ref()
            .map(|c| c
                .unresolved_evidence
                .iter()
                .any(|e| e.contains("$.lastName")))
            .unwrap_or(false),
        "a modelled nullable field must be a resolved fact, not unresolved evidence: {:?}",
        report.completeness
    );
}

#[test]
fn test_optional_marker_does_not_claim_null_acceptance() {
    // `string | undefined` says the property may be omitted; it says nothing
    // about null. The Java reference type can send null, so that obligation
    // stays reported rather than being absorbed by the optional arm.
    let optional_only = compare("string | undefined");
    assert_eq!(
        last_name_findings(&optional_only),
        1,
        "an optional arm must not be read as a null arm: {:?}",
        optional_only.findings
    );

    let both = compare("string | null | undefined");
    assert_eq!(
        last_name_findings(&both),
        0,
        "accepting both null and omission covers the Java reference type: {:?}",
        both.findings
    );
}

#[test]
fn test_mixed_union_is_modelled_not_guessed() {
    // The Java field is a reference type, so the consumer's union must accept null
    // as well. With it, either scalar arm covers the producer and nothing is left
    // unresolved: the value set is exact, not guessed.
    let accepted = compare("string | number | null");
    assert_eq!(
        last_name_findings(&accepted),
        0,
        "a union of exact scalars plus null must accept the producer: {:?}",
        accepted.findings
    );
    assert!(
        !accepted
            .completeness
            .as_ref()
            .map(|c| c
                .unresolved_evidence
                .iter()
                .any(|e| e.contains("$.lastName")))
            .unwrap_or(false),
        "a resolvable union is a definite fact, not unresolved evidence: {:?}",
        accepted.completeness
    );

    // Dropping the null arm is a real disagreement. The string arm covers the value, so
    // the disagreement is nullability and must be reported as such once -- not repeated
    // per union branch or per enum value as a value-rejection message.
    let missing_null = compare("string | number");
    assert_eq!(
        last_name_findings(&missing_null),
        1,
        "a union that omits null must not read as accepting the reference type: {:?}",
        missing_null.findings
    );
    let finding = missing_null
        .findings
        .iter()
        .find(|f| f.wire_path == "$.lastName")
        .expect("finding");
    assert_eq!(finding.change.before, "non-null");
    assert_eq!(finding.change.after, "nullable");
    assert!(
        finding.repair_hint.contains("does not accept null"),
        "the finding must name the null obligation: {:?}",
        finding.repair_hint
    );

    // When no arm admits the produced value, the coverage failure is still reported
    // (one issue at the position, with the accepted union as the after-side).
    let uncovered = compare("number | boolean");
    let coverage = uncovered
        .findings
        .iter()
        .find(|f| f.wire_path == "$.lastName" && f.change.after == "UNION")
        .expect("coverage finding");
    assert_eq!(coverage.change.before, "PRIMITIVE");
}
