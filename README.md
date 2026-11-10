<div align="center">

# ⚡ Sajimora

**Deterministic Cross-Language API Contract Verification & AST Guard for AI Agents & Developers**

*The LLM Proposes. Sajimora Verifies.*

[![Release](https://img.shields.io/badge/release-v0.1.0-blue.svg?style=flat-square)](https://github.com/sajimoraofficial/sajimora/releases)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg?style=flat-square)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-2021_edition-orange.svg?style=flat-square)](https://www.rust-lang.org)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-purple.svg?style=flat-square)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/badge/npm-sajimora-CB3837.svg?style=flat-square&logo=npm)](https://www.npmjs.com/package/sajimora)
[![Speed](https://img.shields.io/badge/AST_latency-%3C90ms-brightgreen.svg?style=flat-square)](#-performance-benchmark-thingsboard-monorepo---15m-loc)

[Website](https://sajimora.com) • [Quickstart](#-quickstart-in-30-seconds) • [AI Agent MCP](#-mcp-server-for-ai-agents) • [CLI Commands](#-cli-commands) • [Architecture](#-architecture) • [Documentation](docs/)

</div>

---

## 📌 Why Sajimora?

When developers or autonomous AI agents modify a backend endpoint or rename a DTO field, compilers verify each repository in isolation. **They cannot prove if changes break consumers across repositories.**

Traditional integration tests require starting Docker containers, spinning up databases, and waiting 10+ minutes.

**Sajimora solves this in under 90 milliseconds:**
* **Extracts AST Contracts Deterministically:** Parses Java (Spring Boot, JAX-RS, Micronaut) and TypeScript/JavaScript (Angular, React, Axios, Fetch, SWR, Nuxt) without compiling code or executing runtimes.
* **Bi-Directional Differential Ratcheting:** Compares parent revision `R - 1` against candidate `R`. Freezes legacy technical debt and blocks only *new* breaking contract violations.
* **AI-First Tooling (MCP):** Connects directly into Cursor, Claude Desktop, and Windsurf, enabling LLMs to test "what-if" API changes before editing code.

```text
[sajimora verify]
┌────────────────────────────────────────────────────────────────────────┐
│                        SAJIMORA VERIFICATION REPORT                   │
├────────────────────────────────────────────────────────────────────────┤
│ Overall Verdict:      LIKELY_VIOLATED                                  │
│ Breaking Consumers:   8 call-sites in 1 file                           │
│ Frozen Legacy Debt:   15 findings (Advisory / Non-Blocking)            │
│ Execution Latency:    85 ms (SQLite B-Tree AST Index)                  │
├────────────────────────────────────────────────────────────────────────┤
│ VIOLATIONS DETECTED:                                                   │
│   • GET /api/user/{id} -> ui/src/user.service.ts:42                   │
│     [Field 'email' was removed from UserDTO, but consumer accesses it] │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart in 30 Seconds

### Option A: Zero-Install via `npx` (Fullstack & Frontend Devs)

No Rust compiler required. The lightweight launcher automatically fetches the optimized native binary for your OS:

```bash
# Run full verification pipeline
npx sajimora run

# Check working tree against contract baseline
npx sajimora verify
```

### Option B: Standalone Native Binary (Pure Java & Backend Devs)

Pre-compiled standalone binaries with **zero runtime dependencies** (no Node.js, no npm, no JVM required):

```bash
# macOS (Apple Silicon & Intel)
curl -fsSL https://raw.githubusercontent.com/sajimoraofficial/sajimora/main/scripts/install.sh | sh

# Linux & CI Runners (GitHub Actions / GitLab CI)
curl -fsSL https://raw.githubusercontent.com/sajimoraofficial/sajimora/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/sajimoraofficial/sajimora/main/scripts/install.ps1 | iex
```

### Option C: Build from Source (Rust Developers)

```bash
cargo install --path rust/crates/sajimora-cli
cargo install --path rust/crates/sajimora-mcp
```

---

## 🤖 MCP Server for AI Agents

Sajimora includes a native **Model Context Protocol (MCP)** server over `stdio`. It gives autonomous AI agents (Cursor, Claude Desktop, Windsurf, Cline) deterministic AST superpowers so they don't hallucinate API routes or miss breaking changes.

### 1-Click IDE Configuration

Add to your **`.cursor/mcp.json`** or **`claude_desktop_config.json`**:

```json
{
  "mcpServers": {
    "sajimora": {
      "command": "sajimora-mcp",
      "args": ["--trusted-local", "--allowed-root", "."]
    }
  }
}
```

### Available MCP Tools

| MCP Tool | Latency | Description |
| :--- | :---: | :--- |
| **`sajimora_what_if`** | **~85 ms** | Simulates a hypothetical change (e.g. `REMOVE_FIELD`, `RENAME_ENDPOINT`) and returns all affected files and call sites before making edits. |
| **`sajimora_verify`** | **~90 ms** | Verifies current working tree modifications against the sealed baseline with differential ratcheting. |
| **`sajimora_query`** | **< 10 ms** | Instant SQLite B-Tree lookup for consumer call sites, HTTP routes, and DTO definitions. |
| **`sajimora_endpoint_impact`** | **~35 ms** | Maps changed files in a Git commit to impacted API routes and external callers. |
| **`sajimora_check_contract`** | **~50 ms** | Cryptographic verification of contract envelopes and admission policies. |
| **`sajimora_heal`** | **~120 ms** | Suggests autonomous AST patch recipes to heal broken consumer call sites after refactoring. |

---

## 💻 CLI Commands

### 1. `sajimora run` — The Complete Pipeline in One Command
Runs the full 6-step lifecycle pipeline: Health check, Contract extraction, Cross-language verification, Git impact analysis, and generates `.sajimora/pipeline-report.json`.

```bash
sajimora run
```

### 2. `sajimora verify` — Differential Contract Ratchet
Verifies local Git changes against the project baseline. Automatically detects modified TypeScript clients and Java endpoints in memory:

```bash
# Advisory developer mode (exit code 0)
sajimora verify

# CI mode (blocks merge with exit code 1 on breaking violations)
sajimora verify --fail-on-violation
```

### 3. `sajimora what-if` — Change Impact Simulation
Predicts what will break *before* modifying code:

```bash
sajimora what-if --target UserDto --field email --action REMOVE_FIELD
```

### 4. `sajimora doctor` — Repository Diagnostics
Validates toolchain health, git readiness, and contract manifest integrity:

```bash
sajimora doctor
```

### 5. `sajimora dashboard` — Visual Contract Health
Displays an interactive terminal health matrix or generates a standalone HTML report:

```bash
# Terminal dashboard
sajimora dashboard

# Generate interactive web report
sajimora dashboard --web
```

---

## 🏗️ Architecture

Sajimora is written from the ground up in modern Rust with multi-threaded Rayon parallelism and Tree-sitter AST engines:

```mermaid
flowchart TD
    subgraph Input["Polyglot Sources"]
        BE["Java Backend (Spring Boot / JAX-RS / Micronaut)"]
        FE["TypeScript Frontend (Angular / React / Axios / Fetch)"]
    end

    subgraph CoreEngine["Pure Native Rust Engine"]
        SI["source-index (Tree-sitter AST Walkers & SQLite B-Tree)"]
        CC["contract-core (Semilattice Algebra & Envelope Crypto)"]
        VF["verifier (Differential Ratchet & Behavioral Gates)"]
    end

    subgraph Interfaces["Distribution Interfaces"]
        CLI["sajimora CLI (One-Command Native Binary)"]
        MCP["sajimora-mcp (JSON-RPC stdio Server for AI Agents)"]
        NPM["npm Launcher (npx sajimora)"]
    end

    BE --> SI
    FE --> SI
    SI --> CC
    CC --> VF
    VF --> CLI
    VF --> MCP
    CLI --> NPM
```

* **`crates/source-index`**: Sub-millisecond AST parser and SQLite B-Tree indexer. Handles monorepos of 1.5M+ lines of code in ~1.2 seconds.
* **`crates/contract-core`**: Defines the variance contract schema and Ed25519 cryptographic signing.
* **`crates/verifier`**: Differential ratcheting engine that separates baseline debt from new breaking regressions.
* **`crates/sajimora-mcp`**: Zero-overhead JSON-RPC stdio server compliant with Anthropic's Model Context Protocol.

---

## ⚡ Performance Benchmark (ThingsBoard Monorepo - 1.5M LOC)

Tested against the enterprise [ThingsBoard](https://github.com/thingsboard/thingsboard) repository (1.5M+ lines of Java + Angular):

| Task | Traditional CI / Compilation | Sajimora Native Engine | Speedup |
| :--- | :---: | :---: | :---: |
| **Full AST Contract Extraction** | 3m 45s (`mvn compile`) | **1.24 s** | **180x faster** |
| **Differential Ratchet Check** | 4m 10s (`mvn test`) | **85 ms** | **2,900x faster** |
| **AI Agent Tool Call (MCP)** | N/A (Manual Grep) | **88 ms** | **Sub-second** |
| **Peak RAM Consumption** | 3.8 GB (JVM) | **< 65 MB** | **98% less RAM** |

---

## 🛡️ CI/CD Integration (GitHub Actions)

Add this 4-line step to your `.github/workflows/ci.yml`:

```yaml
- name: Verify API Contracts
  run: npx sajimora verify --fail-on-violation
```

---

## 📄 License

Sajimora is proprietary software licensed under the **[Sajimora Software License Agreement](LICENSE)**:
* **Evaluation & Beta Testing:** Free for non-commercial personal evaluation, testing, and authorized beta usage.
* **Commercial & Production CI/CD:** Continuous integration, deployment gates, or organizational commercial use requires an active paid commercial subscription or express written authorization from Sajimora.
* **Redistribution Restrictions:** Sublicensing, reselling, hosting, or creating derivative works for commercial exploitation is strictly prohibited.

Bundled third-party open-source components remain licensed under their respective open-source licenses as documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Copyright © 2026 **Sajimora Team** (`dev@sajimora.com`) • [sajimora.com](https://sajimora.com). All rights reserved.
