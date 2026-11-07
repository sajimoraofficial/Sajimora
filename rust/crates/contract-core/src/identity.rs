//! identity.rs — Snapshot identity and assurance types from CrossLanguageContracts.ts.

use serde::{Deserialize, Serialize};

/// Uniquely identifies a repository + analysis snapshot pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIdentity {
    pub repository_id: String,
    pub parent_commit: String,
    pub candidate_snapshot: String,
}
