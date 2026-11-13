//! sajimora-mcp — MCP stdio adapter for Sajimora artifact comparison.
//!
//! Exposes `sajimora_check_contract` (artifact-level) and `sajimora_verify`
//! (repository-level revision gate).
//! Uses the official rmcp Rust SDK (negotiates protocol version automatically).
//!
//! Phase R4 will implement the full MCP server. This module provides the
//! skeleton server structure.
//!
//! Security constraints (plan R4):
//! - Tool input must not override producer policy or supply arbitrary public keys
//! - Filesystem roots, trust policy, and limits are configured at server startup
//! - Diagnostics go to stderr, never stdout (MCP framing on stdout)
//! - Cancellation and stdin EOF shut down cleanly

pub mod apply;
pub mod behavior;
pub mod change_evaluate;
pub mod endpoint_impact;
pub mod heal;
pub mod invariants;
pub mod query;
pub mod run;
pub mod server;
pub mod snippet;
pub mod unit;
pub mod verify;
pub mod what_if;
