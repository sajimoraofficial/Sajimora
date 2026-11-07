//! Strict 2-Hop Mock Depth Governor (London School TDD & Law of Demeter).
//!
//! Enforces:
//! - Hop 1 (Direct collaborator injected via constructor/@Autowired): ALLOWED TO MOCK
//! - Hop 2 (Immediate entity/DTO getter or accessor): ALLOWED TO STUB
//! - Hop 3+ (Transitive collaborator chain): STRICT ABSTENTION (MOCK_BUDGET_EXCEEDED)
//!
//! Complies with Decision 2 in `SAJIMORA_AUTONOMOUS_TEST_SYNTHESIS_PLAN.md`.

use serde::{Deserialize, Serialize};

pub const MAX_MOCK_DEPTH: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MockDecision {
    /// Permitted mock or stub within the 2-hop budget.
    Allowed { hop_depth: usize },
    /// Refusal to synthesize fragile deep mock hierarchy.
    Abstain(MockBudgetExceeded),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MockBudgetExceeded {
    pub call_chain: Vec<String>,
    pub depth: usize,
    pub max_allowed: usize,
    pub reason: String,
}

pub struct MockBudgetGovernor {
    pub max_depth: usize,
}

impl Default for MockBudgetGovernor {
    fn default() -> Self {
        Self {
            max_depth: MAX_MOCK_DEPTH,
        }
    }
}

impl MockBudgetGovernor {
    pub fn new(max_depth: usize) -> Self {
        Self { max_depth }
    }

    /// Evaluates a chain of method call receivers/accessors.
    ///
    /// For example:
    /// - `["userRepository", "findById"]` -> depth = 1 (Allowed)
    /// - `["userRepository", "findById", "getStatus"]` -> depth = 2 (Allowed)
    /// - `["userRepository", "findById", "getPaymentGateway", "fetchBalance"]` -> depth = 3 (Abstain)
    pub fn check_call_chain(&self, chain: &[String]) -> MockDecision {
        // A direct method call on a service dependency has depth = 1
        // Each further chained invocation increases depth by 1
        let depth = if chain.is_empty() { 0 } else { chain.len() - 1 };

        if depth <= self.max_depth {
            MockDecision::Allowed { hop_depth: depth }
        } else {
            MockDecision::Abstain(MockBudgetExceeded {
                call_chain: chain.to_vec(),
                depth,
                max_allowed: self.max_depth,
                reason: format!(
                    "Chained call depth {} exceeds mock budget (max {}). Law of Demeter violation requires an integration test rather than an isolated unit mock.",
                    depth, self.max_depth
                ),
            })
        }
    }
}
