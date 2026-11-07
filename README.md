# Sajimora

> **LLM Proposes. Sajimora Verifies.**  
> Mathematical, tamper-proof API change intelligence and backward compatibility verification for modern codebases.

---

## Overview

When software interfaces or APIs change across commits, standard compilers verify whether code compiles in isolation, but **cannot mathematically prove** whether changes break existing callers across repositories.

**Sajimora** analyzes changes between Git revisions (Parent $R-1$ and Candidate $R$), evaluates variance contracts across 7 structural dimensions, and outputs deterministic compatibility intelligence:

- **`LIKELY_PRESERVED` / `PRESERVED`**: Proven that callers remain compatible.
- **`LIKELY_VIOLATED` / `VIOLATED`**: Proven that at least one caller or consumer is broken, with exact file, line, and rationale.
- **`INCONCLUSIVE` / `UNKNOWN`**: Fail-closed honesty with **100% attributed reason codes** (no mystery unknowns).

---

## Key Features

- **Pure Native Rust Engine**: Zero Node.js and zero JVM requirement at runtime. Standalone native binary compiled with Tree-sitter and Rayon.
- **Polyglot & Cross-Language**:
  - **TypeScript**: Native multi-threaded AST client extraction (Angular HttpClient, Axios, Fetch).
  - **Java**: Native Spring Boot / MVC REST endpoint & DTO type pool extraction.
  - **Cross-Language Differential Ratchet**: Validates backend changes against frontend client contracts, freezing legacy debt.
- **Sub-Second Speed**: Extracts and verifies 1,400+ endpoints across 13,000 files in under 4 seconds with < 50MB RAM.

---

## Installation (Zero Node.js / Zero npm Required)

Sajimora is distributed as a standalone native binary for **Windows, macOS, and Linux**:

### Windows (IntelliJ / Java / .NET Developers)

```powershell
# In PowerShell (Zero install dependencies)
irm https://raw.githubusercontent.com/Jagadeesh-Budda/Sajimora-v0.10/main/scripts/install.ps1 | iex

# Or via Windows Package Manager
winget install sajimora
```

### macOS (Apple Silicon & Intel)

```bash
# Via Homebrew
brew install sajimora/tap/sajimora

# Or via curl
curl -fsSL https://raw.githubusercontent.com/Jagadeesh-Budda/Sajimora-v0.10/main/scripts/install.sh | sh
```

### Linux & CI Runners (GitHub Actions / GitLab CI)

```bash
curl -fsSL https://raw.githubusercontent.com/Jagadeesh-Budda/Sajimora-v0.10/main/scripts/install.sh | sh
```

### Node.js / Fullstack Monorepos (Optional)

If your team already uses npm/pnpm/yarn:

```bash
npx sajimora init --apply
```

### CI Runner / GitHub Action

Add 3 lines to your `.github/workflows/contract-verify.yml`:

```yaml
- name: Verify API Contracts
  uses: Jagadeesh-Budda/Sajimora-v0.10@main
  with:
    fail-on-violation: true
```

---

## AI IDE & Agent Integration (Cursor, Windsurf, Claude Desktop, Roo Code)

Sajimora includes a native **Model Context Protocol (MCP)** server that starts in sub-10ms, allowing AI agents to simulate API changes and check contract compatibility in real-time.

Add this to `.cursor/mcp.json` or `claude_desktop_config.json`:

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

---

## Key CLI Commands

### 1. One-Command Contract Verification (`sajimora verify`)

Verifies your local Git working tree against the project's contract baseline in milliseconds:

```bash
# Advisory check (outputs affected call sites, exit code 0)
sajimora verify

# CI enforcement (blocks with exit code 1 on breaking changes)
sajimora verify --fail-on-violation
```

### 2. Zero-False-Alarm What-If Simulation (`sajimora what-if`)

Predicts exactly which frontend files, methods, and HTML templates break if you rename, delete, or change a backend field—with causal chains and automated patch recipes:

```bash
sajimora what-if --target Device --field label --action rename --new-name deviceLabel
```

### 3. Analyze Latest Commit

```bash
# Analyzes changes between HEAD~1 and HEAD in the current repository
sajimora analyze
```

#### 2. Analyze Specific Commits or Branches

```bash
sajimora analyze --repo /path/to/repo --parent main --candidate feature-branch
```

#### 3. Output Formats

Sajimora supports JSON (default), human-readable ANSI text, and Markdown (ideal for GitHub Actions and PR comments):

```bash
sajimora analyze --format markdown --output compatibility-report.md
```

#### 4. Cross-Language API Verification

Verify Java Spring / JAX-RS backend endpoints against frontend TypeScript consumer contracts:

```bash
# In production CI with cryptographic signature verification:
sajimora analyze --frontend ./artifacts/frontend.json --trust-policy ./trust-policy.json

# In local developer workflow (explicit signature bypass):
sajimora analyze --frontend ./artifacts/frontend.json --trusted-local
```

#### 5. CI / Non-Blocking Advisory vs Strict Gating

By default, Sajimora runs in advisory mode (exit code 0) so developers are alerted without breaking builds. To enforce hard gates in CI:

```bash
# Block CI only on verified contract violations:
sajimora analyze --fail-on-violation

# Strict mode: block on violations (exit 1) and fail-closed on inconclusive proofs (exit 3):
sajimora analyze --strict
```

#### 6. Cryptographic Key & Policy Generation

Generate an Ed25519 keypair and matching `ArtifactTrustPolicy` JSON file:

```bash
sajimora keygen --out-dir ./keys --repo-id my-org/service-repo --service-id api-service
```

#### 7. Automated Pre-Commit Hook

Install pre-commit verification into `.git/hooks` or `.husky`:

```bash
sajimora init-hook
```

---

## Architecture

```
                 Developer Git Commit Change
                             │
                             ▼
               [ PACKAGES / IMPACT-ANALYSIS ]
            Offline Inverted Dependency Graph
          • Reverse BFS graph traversal in sub-5ms
          • 90-99% candidate scope reduction
                             │
                             ▼
                 [ PACKAGES / ANALYSIS ]
            Dual-Snapshot Ingestion & Closures
          • 7 Exhaustive Graph Closures (Value, Type, Override, etc.)
          • Tree-sitter Java AST & WS1 Alias Resolver
          • Enterprise Framework & SPI Descriptor Scanner
                             │
                             ▼
                   [ PACKAGES / CORE ]
             Verdict Authority & Two-Panel Reporter
          • Meet-Semilattice Completeness Algebra
          • Fail-Closed Verification Gates
          • Two-Panel Release Report
```

---

## Internal Architecture & Capabilities Guide

For an exhaustive, folder-by-folder breakdown of Sajimora’s complete capabilities—covering `packages/`, `rust/`, `scripts/`, and `scratch/`—see:
👉 **[Master System Architecture & Capability Guide](docs/SAJIMORA_CAPABILITIES_INTERNAL_GUIDE.md)**


Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

