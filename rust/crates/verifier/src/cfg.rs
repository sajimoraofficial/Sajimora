//! Control Flow Graph (CFG) extraction for Java method bodies.
//!
//! Maps basic blocks, branch conditions (if/else, loops), and return points.

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Terminator {
    Return(Option<String>),
    Branch {
        condition: String,
        then_block: usize,
        else_block: usize,
    },
    Jump(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasicBlock {
    pub id: usize,
    pub statements: Vec<String>,
    pub terminator: Terminator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlFlowGraph {
    pub method_name: String,
    pub entry: usize,
    pub blocks: Vec<BasicBlock>,
}

impl ControlFlowGraph {
    pub fn new(method_name: String) -> Self {
        Self {
            method_name,
            entry: 0,
            blocks: Vec::new(),
        }
    }

    /// Extracts path condition strings along all acyclic execution paths.
    pub fn extract_branch_conditions(&self) -> Vec<String> {
        let mut conditions = Vec::new();
        for block in &self.blocks {
            if let Terminator::Branch { condition, .. } = &block.terminator {
                conditions.push(condition.clone());
            }
        }
        conditions
    }
}

/// Constructs a CFG from a Java method declaration AST node.
pub fn build_java_cfg(source: &str, method_node: Node) -> Option<ControlFlowGraph> {
    let name_node = method_node.child_by_field_name("name")?;
    let method_name = source[name_node.start_byte()..name_node.end_byte()].to_string();

    let body_node = method_node.child_by_field_name("body")?;
    let mut cfg = ControlFlowGraph::new(method_name);

    let mut current_statements = Vec::new();
    let mut cursor = body_node.walk();

    for child in body_node.children(&mut cursor) {
        match child.kind() {
            "if_statement" => {
                let cond_node = child.child_by_field_name("condition");
                let cond_text = cond_node
                    .map(|c| source[c.start_byte()..c.end_byte()].to_string())
                    .unwrap_or_else(|| "true".to_string());

                let block_id = cfg.blocks.len();
                cfg.blocks.push(BasicBlock {
                    id: block_id,
                    statements: std::mem::take(&mut current_statements),
                    terminator: Terminator::Branch {
                        condition: cond_text,
                        then_block: block_id + 1,
                        else_block: block_id + 2,
                    },
                });
            }
            "return_statement" => {
                let ret_text = source[child.start_byte()..child.end_byte()].to_string();
                current_statements.push(ret_text.clone());
                let block_id = cfg.blocks.len();
                cfg.blocks.push(BasicBlock {
                    id: block_id,
                    statements: std::mem::take(&mut current_statements),
                    terminator: Terminator::Return(Some(ret_text)),
                });
            }
            "expression_statement" => {
                let stmt_text = source[child.start_byte()..child.end_byte()].to_string();
                current_statements.push(stmt_text);
            }
            _ => {}
        }
    }

    if !current_statements.is_empty() || cfg.blocks.is_empty() {
        let block_id = cfg.blocks.len();
        cfg.blocks.push(BasicBlock {
            id: block_id,
            statements: current_statements,
            terminator: Terminator::Return(None),
        });
    }

    Some(cfg)
}
