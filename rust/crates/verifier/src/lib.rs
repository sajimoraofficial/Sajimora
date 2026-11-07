//! verifier — Formal Verification, SMT Constraint Solving, and Invariant Synthesis crate.
//!
//! Exposes:
//! - `solver`: Tier 1 Presburger and linear inequality constraint solver.
//! - `mock_budget`: London School TDD 2-hop mock depth governor.
//! - `cfg`: Method basic-block Control Flow Graph extractor.
//! - `invariants`: Formal metamorphic property engine.

pub mod bisim;
pub mod cfg;
pub mod invariants;
pub mod mock_budget;
pub mod reference_verifier;
pub mod solver;
pub mod symbolic;

pub use reference_verifier::{EquivalenceProof, EquivalenceStatus, ReferenceVerifier};
