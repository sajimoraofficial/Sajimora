//! replay.rs — Deployment replay and rollback prevention (spec §3.3).
//!
//! Admission requires proving that a candidate deployment is advancing, not a
//! resurrected historic state. The authoritative state is an out-of-band,
//! caller-supplied [`DeploymentStateLedger`] (same trust philosophy as
//! [`crate::admission::ArtifactTrustPolicy`]): a contract cannot authenticate
//! its own liveness.
//!
//! Enforced invariants:
//! 1. **Identity binding** — the ledger must belong to the artifact's
//!    repository and service.
//! 2. **Monotonic deployment sequence** — the envelope's `deploymentId` is a
//!    u64 sequence that must be `>=` the latest recorded sequence; anything
//!    lower is a rollback/replay attempt (`StaleDeployment`).
//! 3. **Same-sequence pinning** — re-admitting the same sequence is only valid
//!    for the exact same candidate snapshot (idempotent re-admission); a
//!    different snapshot under a used sequence is a replay (`StaleDeployment`).
//! 4. **Lineage descent** — when the artifact carries real commit SHAs, the
//!    candidate must either redeploy the recorded head or descend directly
//!    from it (`parentCommit == latestCommit`); otherwise
//!    `BaselineDescentUnproven`. Placeholder snapshots (`HEAD`, `HEAD~1`,
//!    non-SHA forms) cannot prove ancestry, so the lineage check is skipped —
//!    the monotonic-sequence invariant still applies. Deep DAG ancestry
//!    requires an external deployment record and is intentionally out of
//!    scope for the offline artifact layer.

use crate::admission::AdmissionError;
use crate::envelope::ContractArtifactEnvelope;
use serde::{Deserialize, Serialize};

pub const DEPLOYMENT_STATE_SCHEMA: &str = "SAJIMORA_DEPLOYMENT_STATE_V1";

/// Caller-supplied record of the latest admitted deployment for one
/// repository/service/environment triple.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentStateLedger {
    pub schema_version: String,
    pub repository_id: String,
    pub service_id: String,
    pub environment: String,
    /// Highest deployment sequence admitted so far. Deployment ids must be
    /// u64-parseable sequences to participate in replay checking.
    pub latest_deployment_seq: u64,
    /// Candidate snapshot of the latest admitted deployment.
    pub latest_commit: String,
    /// Audit-only timestamp of the last ledger advance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl DeploymentStateLedger {
    pub fn initial(repository_id: &str, service_id: &str, environment: &str) -> Self {
        Self {
            schema_version: DEPLOYMENT_STATE_SCHEMA.to_string(),
            repository_id: repository_id.to_string(),
            service_id: service_id.to_string(),
            environment: environment.to_string(),
            latest_deployment_seq: 0,
            latest_commit: String::new(),
            updated_at: None,
        }
    }

    /// Advance the ledger after a successful admission at `seq` for `commit`.
    /// Sequence must be strictly greater than the recorded one for an advance;
    /// equal is accepted as an idempotent no-op only when `commit` matches.
    pub fn record(&mut self, seq: u64, commit: &str) -> Result<(), AdmissionError> {
        if seq < self.latest_deployment_seq {
            return Err(AdmissionError::StaleDeployment {
                got: seq,
                latest: self.latest_deployment_seq,
            });
        }
        if seq == self.latest_deployment_seq && commit != self.latest_commit {
            return Err(AdmissionError::StaleDeployment {
                got: seq,
                latest: self.latest_deployment_seq,
            });
        }
        if seq > self.latest_deployment_seq {
            self.latest_deployment_seq = seq;
            self.latest_commit = commit.to_string();
        }
        Ok(())
    }
}

/// A deployment id participates in replay checking only when it is a u64
/// sequence. Non-numeric ids cannot prove monotonic advancement.
pub fn parse_deployment_seq(deployment_id: &str) -> Option<u64> {
    deployment_id.parse::<u64>().ok()
}

fn looks_like_commit_sha(value: &str) -> bool {
    value.len() >= 7 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Enforce replay/rollback invariants for an envelope against the ledger.
///
/// `expected_environment` binds the ledger to the deployment environment being
/// gated (spec §3.2/§3.3): when supplied it must match `ledger.environment`.
pub fn check_replay(
    envelope: &ContractArtifactEnvelope,
    ledger: &DeploymentStateLedger,
    expected_environment: Option<&str>,
) -> Result<(), AdmissionError> {
    // 1. Identity binding.
    if ledger.repository_id != envelope.snapshot.repository_id
        || ledger.service_id != envelope.snapshot.service_id
    {
        return Err(AdmissionError::DeploymentStateInvalid(format!(
            "deployment state ledger belongs to {}/{} but artifact asserts {}/{}",
            ledger.repository_id,
            ledger.service_id,
            envelope.snapshot.repository_id,
            envelope.snapshot.service_id
        )));
    }
    if let Some(expected) = expected_environment {
        if ledger.environment != expected {
            return Err(AdmissionError::DeploymentStateInvalid(format!(
                "deployment state ledger covers environment {:?} but gate expects {:?}",
                ledger.environment, expected
            )));
        }
    }
    if ledger.schema_version != DEPLOYMENT_STATE_SCHEMA {
        return Err(AdmissionError::DeploymentStateInvalid(format!(
            "unsupported deployment state schema {:?}; expected {:?}",
            ledger.schema_version, DEPLOYMENT_STATE_SCHEMA
        )));
    }

    // 2. The envelope must carry a monotonic deployment id.
    let deployment_id = envelope
        .snapshot
        .deployment_id
        .as_deref()
        .ok_or(AdmissionError::ReplayProofMissing)?;
    let seq = parse_deployment_seq(deployment_id).ok_or(AdmissionError::ReplayProofMissing)?;

    // 3. Monotonic sequence + same-sequence pinning.
    if seq < ledger.latest_deployment_seq {
        return Err(AdmissionError::StaleDeployment {
            got: seq,
            latest: ledger.latest_deployment_seq,
        });
    }
    if seq == ledger.latest_deployment_seq
        && envelope.snapshot.candidate_snapshot != ledger.latest_commit
    {
        return Err(AdmissionError::StaleDeployment {
            got: seq,
            latest: ledger.latest_deployment_seq,
        });
    }

    // 4. Lineage descent — only enforceable with real commit SHAs.
    let lineage_checkable = looks_like_commit_sha(&ledger.latest_commit)
        && (looks_like_commit_sha(&envelope.snapshot.parent_commit)
            || looks_like_commit_sha(&envelope.snapshot.candidate_snapshot));
    if lineage_checkable && seq > ledger.latest_deployment_seq {
        let advances_from_head = envelope.snapshot.candidate_snapshot == ledger.latest_commit
            || envelope.snapshot.parent_commit == ledger.latest_commit;
        if !advances_from_head {
            return Err(AdmissionError::BaselineDescentUnproven {
                expected_parent: ledger.latest_commit.clone(),
                got_parent: envelope.snapshot.parent_commit.clone(),
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{
        ArtifactCompleteness, ArtifactKind, ArtifactPayload, ArtifactSnapshotRef,
        BackendContractPayload, ContractArtifactEnvelope, ExtractionProfile,
    };
    use crate::report::SCHEMA_VERSION;

    fn envelope_with(
        repo: &str,
        service: &str,
        deployment_id: Option<&str>,
        parent: &str,
        candidate: &str,
    ) -> ContractArtifactEnvelope {
        ContractArtifactEnvelope {
            envelope_version: crate::envelope::ARTIFACT_ENVELOPE_VERSION.to_string(),
            report_schema_version: SCHEMA_VERSION.to_string(),
            kind: ArtifactKind::BackendContract,
            snapshot: ArtifactSnapshotRef {
                repository_id: repo.to_string(),
                service_id: service.to_string(),
                api_version: None,
                parent_commit: parent.to_string(),
                candidate_snapshot: candidate.to_string(),
                deployment_id: deployment_id.map(|s| s.to_string()),
                environment: None,
            },
            profile: ExtractionProfile {
                tool_version: "32.9.0".to_string(),
                framework_profile: None,
                codec_profile: None,
                client_profile: None,
                config_fingerprint: None,
            },
            completeness: ArtifactCompleteness {
                complete: true,
                unresolved_endpoints: vec![],
                blockers: vec![],
            },
            integrity: None,
            signature: None,
            issued_at_unix: None,
            payload: ArtifactPayload::Backend(BackendContractPayload {
                serialization_assumptions: None,
                base_urls: vec![],
                proxy_prefixes: vec![],
                endpoints: vec![],
                type_pool: None,
                path_pool: None,
            }),
            raw_value: None,
        }
    }

    fn ledger(commit: &str, seq: u64) -> DeploymentStateLedger {
        DeploymentStateLedger {
            schema_version: DEPLOYMENT_STATE_SCHEMA.to_string(),
            repository_id: "github.com/example/repo".to_string(),
            service_id: "my-service".to_string(),
            environment: "prod".to_string(),
            latest_deployment_seq: seq,
            latest_commit: commit.to_string(),
            updated_at: None,
        }
    }

    #[test]
    fn advancing_sequence_from_recorded_head_is_admitted() {
        let envelope = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("41"),
            "0123456789abcdef0123456789abcdef01234567",
            "89abcdef0123456789abcdef0123456789abcdef",
        );
        let state = ledger("0123456789abcdef0123456789abcdef01234567", 40);
        assert!(check_replay(&envelope, &state, Some("prod")).is_ok());
    }

    #[test]
    fn lower_sequence_is_rejected_as_stale() {
        let envelope = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("39"),
            "0123456789abcdef0123456789abcdef01234567",
            "89abcdef0123456789abcdef0123456789abcdef",
        );
        let state = ledger("0123456789abcdef0123456789abcdef01234567", 40);
        assert_eq!(
            check_replay(&envelope, &state, None).unwrap_err(),
            AdmissionError::StaleDeployment {
                got: 39,
                latest: 40
            }
        );
    }

    #[test]
    fn same_sequence_requires_identical_snapshot() {
        let same = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("40"),
            "0123456789abcdef0123456789abcdef01234567",
            "0123456789abcdef0123456789abcdef01234567",
        );
        let state = ledger("0123456789abcdef0123456789abcdef01234567", 40);
        assert!(check_replay(&same, &state, None).is_ok());

        let swapped = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("40"),
            "0123456789abcdef0123456789abcdef01234567",
            "89abcdef0123456789abcdef0123456789abcdef",
        );
        assert_eq!(
            check_replay(&swapped, &state, None).unwrap_err(),
            AdmissionError::StaleDeployment {
                got: 40,
                latest: 40
            }
        );
    }

    #[test]
    fn missing_or_nonnumeric_deployment_id_is_replay_proof_missing() {
        let state = ledger("", 0);
        let none = envelope_with("github.com/example/repo", "my-service", None, "abc", "def");
        assert_eq!(
            check_replay(&none, &state, None).unwrap_err(),
            AdmissionError::ReplayProofMissing
        );
        let symbolic = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("release-42"),
            "abc",
            "def",
        );
        assert_eq!(
            check_replay(&symbolic, &state, None).unwrap_err(),
            AdmissionError::ReplayProofMissing
        );
    }

    #[test]
    fn ledger_identity_mismatch_fails_closed() {
        let envelope = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("41"),
            "abc",
            "def",
        );

        // Repository identity mismatch.
        let mut other_repo = ledger("", 0);
        other_repo.repository_id = "github.com/other/repo".to_string();
        assert!(matches!(
            check_replay(&envelope, &other_repo, None),
            Err(AdmissionError::DeploymentStateInvalid(_))
        ));

        // Unsupported schema version.
        let mut old_schema = ledger("", 0);
        old_schema.schema_version = "SAJIMORA_DEPLOYMENT_STATE_V0".to_string();
        assert!(matches!(
            check_replay(&envelope, &old_schema, None),
            Err(AdmissionError::DeploymentStateInvalid(_))
        ));

        // Environment binding mismatch.
        let env_ledger = ledger("", 0);
        assert!(matches!(
            check_replay(&envelope, &env_ledger, Some("staging")),
            Err(AdmissionError::DeploymentStateInvalid(_))
        ));
    }

    #[test]
    fn lineage_descent_enforced_for_real_shas_and_skipped_for_placeholders() {
        let head = "0123456789abcdef0123456789abcdef01234567";
        let other = "fedcba9876543210fedcba9876543210fedcba98";

        // Real SHAs, unrelated parent: descent unproven.
        let orphan = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("41"),
            other,
            "89abcdef0123456789abcdef0123456789abcdef",
        );
        let state = ledger(head, 40);
        assert_eq!(
            check_replay(&orphan, &state, None).unwrap_err(),
            AdmissionError::BaselineDescentUnproven {
                expected_parent: head.to_string(),
                got_parent: other.to_string(),
            }
        );

        // Placeholder snapshot forms cannot prove ancestry: only the
        // monotonic-sequence invariant applies.
        let placeholder = envelope_with(
            "github.com/example/repo",
            "my-service",
            Some("41"),
            "HEAD~1",
            "HEAD",
        );
        assert!(check_replay(&placeholder, &state, None).is_ok());
    }

    #[test]
    fn record_advances_monotonically() {
        let mut state = DeploymentStateLedger::initial("r", "s", "prod");
        state.record(1, "aaa111").unwrap();
        assert_eq!(state.latest_deployment_seq, 1);
        state.record(1, "aaa111").unwrap(); // idempotent
        assert_eq!(state.latest_commit, "aaa111");
        assert!(state.record(1, "bbb222").is_err());
        assert!(state.record(0, "ccc333").is_err());
        state.record(2, "bbb222").unwrap();
        assert_eq!(state.latest_commit, "bbb222");
    }
}
