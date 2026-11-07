//! advisory.rs — Evidence-admission advisories (spec §2).
//!
//! Advisories are distinct from blockers: a blocker fails the analysis, while
//! an advisory records that admission evidence was evaluated against an
//! auditable policy limit and the pass must not be read as unconditional.
//! Per spec §2, calendar-freshness judgments live exclusively in the Evidence
//! Admission Gate; the pure comparison engine never emits them.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Serde code tag for [`EvidenceAdvisory::ContractAgeThresholdExceeded`].
pub const EVIDENCE_ADVISORY_CONTRACT_AGE: &str = "CONTRACT_AGE_THRESHOLD_EXCEEDED";

/// Non-fatal evidence-admission advisories.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceAdvisory {
    /// The candidate artifact's declared issuance age exceeded the policy's
    /// `maxContractAgeDays` at the caller-supplied evaluation time (spec §2).
    /// A calendar window is an auditable policy threshold, not physical proof
    /// of obsolescence; when `refreshed_by_deployment_record` is true a valid
    /// deployment liveness record re-affirms the artifact and
    /// `LIKELY_PRESERVED` is not withheld.
    ContractAgeThresholdExceeded {
        #[serde(rename = "ageDays")]
        age_days: u64,
        #[serde(rename = "thresholdDays")]
        threshold_days: u32,
        #[serde(rename = "issuedAtUnix")]
        issued_at_unix: u64,
        #[serde(rename = "evaluationTimeUnix")]
        evaluation_time_unix: u64,
        #[serde(rename = "refreshedByDeploymentRecord")]
        refreshed_by_deployment_record: bool,
    },
}

impl fmt::Display for EvidenceAdvisory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvidenceAdvisory::ContractAgeThresholdExceeded {
                age_days,
                threshold_days,
                refreshed_by_deployment_record,
                ..
            } => write!(
                f,
                "ContractAgeThresholdExceeded: contract age {}d exceeds policy threshold {}d{}",
                age_days,
                threshold_days,
                if *refreshed_by_deployment_record {
                    " — refreshed by deployment liveness record"
                } else {
                    " — LIKELY_PRESERVED withheld"
                }
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisory_serializes_with_screaming_code_tag() {
        let advisory = EvidenceAdvisory::ContractAgeThresholdExceeded {
            age_days: 31,
            threshold_days: 30,
            issued_at_unix: 1_700_000_000,
            evaluation_time_unix: 1_726_800_000,
            refreshed_by_deployment_record: false,
        };
        let json = serde_json::to_value(&advisory).unwrap();
        assert_eq!(json["code"], "CONTRACT_AGE_THRESHOLD_EXCEEDED");
        assert_eq!(json["ageDays"], 31);
        assert_eq!(json["thresholdDays"], 30);
        assert_eq!(json["refreshedByDeploymentRecord"], false);
        let round: EvidenceAdvisory = serde_json::from_value(json).unwrap();
        assert_eq!(round, advisory);
        assert!(advisory.to_string().contains("31d"));
        assert!(advisory.to_string().contains("withheld"));
    }

    #[test]
    fn refreshed_advisory_reports_liveness() {
        let advisory = EvidenceAdvisory::ContractAgeThresholdExceeded {
            age_days: 31,
            threshold_days: 30,
            issued_at_unix: 1_700_000_000,
            evaluation_time_unix: 1_726_800_000,
            refreshed_by_deployment_record: true,
        };
        assert!(advisory.to_string().contains("refreshed"));
    }
}
