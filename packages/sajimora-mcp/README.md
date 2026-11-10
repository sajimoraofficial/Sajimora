# sajimora-mcp

> **Model Context Protocol (MCP) Server for Sajimora**  
> Deterministic cross-language API contract verification and AST guard for Java Spring Boot and TypeScript/Angular/React.

[![npm version](https://img.shields.io/npm/v/sajimora-mcp.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/sajimora-mcp)
[![MCP Protocol](https://img.shields.io/badge/MCP-1.0-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![License: Sajimora Community](https://img.shields.io/badge/License-Sajimora_Community-green.svg?style=flat-square)](LICENSE)

`sajimora-mcp` is the official Model Context Protocol (MCP) server for **Sajimora**. It connects AI coding agents (Claude Desktop, Cursor, Windsurf, Roo Code, Continue.dev, Zed) directly to Sajimora's sub-millisecond native Rust contract verification engine.

---

## ⚡ Quick Start

No manual binary installation or compilation required. `sajimora-mcp` automatically provisions the matching precompiled high-performance Rust binary for your operating system (Windows x64, macOS Apple Silicon / Intel, Linux x64) on first launch.

### 1. Claude Desktop

Add to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sajimora": {
      "command": "npx",
      "args": ["-y", "sajimora-mcp", "--allowed-root", "."]
    }
  }
}
```

### 2. Cursor

1. Open **Cursor Settings** (`Cmd+,` or `Ctrl+,`).
2. Navigate to **Features** > **MCP**.
3. Click **+ Add New MCP Server**.
4. Configure:
   - **Name**: `sajimora`
   - **Type**: `command`
   - **Command**: `npx -y sajimora-mcp --allowed-root .`

### 3. Smithery (Automated Agent Installation)

To install Sajimora for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@sajimoraofficial/sajimora):

```bash
npx -y @smithery/cli install sajimora --client claude
```

---

## 🛠️ MCP Tools Exposed

When configured, AI agents gain access to the following deterministic verification and refactoring tools:

| Tool | Purpose |
| :--- | :--- |
| `sajimora_check_contract` | Run full differential contract verification between a candidate branch and baseline. |
| `sajimora_verify` | Rapidly verify changes against frozen `.sajimora/` baseline contracts. |
| `sajimora_heal` | Automatically compute and preview atomic refactoring patches to heal broken call sites. |
| `sajimora_gen_invariants` | Synthesize structural AST invariants and cross-language differential ratchets. |
| `sajimora_gen_unit` | Generate consumer unit tests and contract stubs matching live backend endpoints. |
| `sajimora_verify_behavior` | Verify behavioral semantics and boundary invariants across API endpoints. |
| `sajimora_endpoint_impact` | Perform exhaustive call-graph impact analysis for candidate API modifications. |
| `sajimora_change_evaluate` | Score candidate Git diffs for contract regression risk before staging. |
| `sajimora_query` | Query the canonical AST endpoint graph and dependency shapes. |
| `sajimora_what_if` | Simulate endpoint signature changes without touching the codebase. |

---

## 🛡️ Agent Evidence Guarantee

Unlike traditional LLM-based code reviewers that hallucinate or miss obscure client calls, Sajimora provides a **Mathematical AST Guarantee**:
- **Zero Hallucinations**: Every finding is backed by canonical AST traversal and type lattice resolution.
- **Exhaustive Repo Coverage**: 100% of consumer call sites are proven either Safe or Broken.
- **Sub-5ms Latency**: Native Rust AST parsers execute across hundreds of files in single-digit milliseconds.

---

## ⚙️ Server CLI Options

```text
Usage: sajimora-mcp [OPTIONS]

Options:
      --allowed-root <ALLOWED_ROOTS>
          Allowed filesystem roots for repository analysis (default: .)
      --trust-policy <TRUST_POLICY>
          Path to trust policy JSON file
      --trusted-local
          Enable trusted-local mode for rapid development (skips signature checks)
      --max-concurrent-jobs <MAX_CONCURRENT_JOBS>
          Maximum concurrent check jobs (default: 4)
  -h, --help
          Print help
  -V, --version
          Print version
```

---

## 📄 License

Sajimora Community License. Free for individuals, students, and freelancers. See [LICENSE](LICENSE) for commercial terms and details.
