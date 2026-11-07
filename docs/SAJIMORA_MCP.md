# Sajimora Native MCP Server

`sajimora-mcp` is a high-performance native Rust Model Context Protocol (MCP) stdio server. It starts in **sub-10ms** and gives AI coding assistants (Cursor, Claude Desktop, Roo Code, Cline, Windsurf) direct mathematical access to cross-language contract verification, what-if breaking change simulations, and test self-healing.

---

## Quickstart for AI IDEs & Agents

### Cursor / Windsurf Configuration

Add this to your project's `.cursor/mcp.json` or global `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sajimora": {
      "command": "sajimora-mcp",
      "args": [
        "--trusted-local",
        "--allowed-root",
        "."
      ]
    }
  }
}
```

---

## Exposed MCP Tools

| Tool | Purpose | Latency |
| :--- | :--- | :--- |
| **`sajimora_what_if`** | Zero-false-alarm what-if simulation for proposed API edits with root causes, causal chains, automated patch recipes, and HTML template scanning. | ~13 ms |
| **`sajimora_verify`** | One-command repository gate checking Git changes against baseline contract without running full tests. | ~200 ms |
| **`sajimora_check_contract`** | Formal contract compatibility verification between base, candidate, and target frontend artifacts. | ~150 ms |
| **`sajimora_heal`** | Autonomous AST test call-site self-healing engine. Automatically updates broken test invocations when method signatures change. | ~45 ms |
| **`sajimora_gen_invariants`** | Metamorphic invariant test synthesizer (jqwik / JUnit 5) generating mathematical property tests. | ~60 ms |
| **`sajimora_gen_unit`** | Bounded symbolic unit test synthesizer using Tier 1 SMT solver. | ~50 ms |
| **`sajimora_verify_behavior`** | Bisimulation behavioral equivalence gate proving mathematical equivalence of business calculations across Git commits. | ~35 ms |
| **`sajimora_endpoint_impact`** | Deep dependency graph consumer impact analysis. | ~25 ms |

---

## Server Flags

- `--trusted-local`: Enables trusted local producer mode for development without Ed25519 signatures.
- `--allowed-root <PATH>`: Filesystem path boundaries the server is permitted to access.
- `--trust-policy <PATH>`: Path to production cryptographic trust policy JSON.
- `--max-concurrent-jobs <N>`: Maximum parallel solver jobs (default: 4).
