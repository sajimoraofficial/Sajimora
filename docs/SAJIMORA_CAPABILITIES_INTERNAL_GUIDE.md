# SAJIMORA — Master System Architecture & Capability Guide
**Internal Reference & Source of Truth for Engineers, Architects, and AI Agents**  
**Version:** V32 / V33 Production Baseline  
**Target Audience:** Anyone seeking a complete, authoritative understanding of Sajimora's capabilities without needing to reverse-engineer thousands of source files.

---

## 1. Executive Summary: What is Sajimora?

Sajimora is a **deterministic, compiler-grade API change intelligence and mathematical contract verification engine**. 

### The Problem It Solves
* **Compilers (`tsc`, `javac`) only check isolation:** They verify whether code compiles at a single moment in time. They cannot prove whether a code change in commit $R$ silently breaks callers in dependent services or prior revisions $R-1$.
* **Traditional Contract Testing (Pact / PactFlow) has high friction:** Requires developers to manually author and maintain mock-based tests or OpenAPI specs, which drift from reality, slow down CI, and fail to scale in enterprise polyglot monorepos.

### The Sajimora Solution
Sajimora directly analyzes software changes across Git commits (Parent $R-1$ and Candidate $R$), traverses 100% of all consumers across 7 structural dimensions, evaluates type assignability and variance contracts at every caller site, and issues a tamper-proof, deterministic verdict:
* **`PRESERVED` / `LIKELY_PRESERVED`**: Mathematically proven that callers remain compatible.
* **`VIOLATED` / `LIKELY_VIOLATED`**: Proven broken with an exact **SHA-256 Incompatibility Witness** pinpointing the exact file, line number, and broken type relation.
* **`UNKNOWN` / `INCONCLUSIVE`**: Strictly **fails closed** with 100% attributed reason codes whenever ambiguity, circularity, or unresolvable imports occur.

All core proof decisions use **0 LLM calls** (no hallucinations in the verification path), while exposing rich **Model Context Protocol (MCP)** interfaces to safely guide autonomous AI coding agents.

---

## 2. Verified Repository Architecture

The repository is organized into four primary structural directories:

```
sajimora-v32/
├── packages/       ── Core TypeScript analysis, formal proof algebra & impact engines
├── rust/           ── Pure native CLI, contract DTOs, Ed25519 crypto & native MCP server
├── scripts/        ── CLI command drivers, Node MCP server, memory forensics & qualification
└── scratch/        ── Experimental testbeds, empirical benchmarks (zod, ThingsBoard) & logs
```

---

## 3. Deep Dive: `packages/` (TypeScript / Node Analysis Engine)

`packages/` contains five modular packages forming the layered verification pipeline:

### 3.1 `@sajimora/core` (`packages/core`)
* **Role:** The Mathematical Proof Authority and Legal Judge.
* **Key Components:**
  * `VerdictAuthority.ts`: Enforces normative verdict algebra. Checks universe discovery, parse failures, closure completeness, semantic scopes, and caller assignability.
  * `algebra/completeness.ts`: Implements the **Meet-Semilattice Completeness Algebra** with ambiguity poisoning:
    $$\text{DISCOVERY\_COMPLETE} \wedge \text{AMBIGUOUS} \longrightarrow \text{INCOMPLETE}$$
    If a single circular re-export or unresolvable wildcard occurs anywhere in the analyzed scope, completeness is mathematically downgraded, strictly blocking a false `PRESERVED` verdict.
  * `adapters/LanguageAdapterRegistry.ts`: Decoupled, language-neutral core allowing TypeScript, Java, and other languages to plug into the same proof authority.
  * `types/witness.ts`: Defines cryptographic, deterministic incompatibility witnesses.

### 3.2 `@sajimora/analysis` (`packages/analysis`)
* **Role:** Semantic Extraction, Graph Closures, and Cross-Language Contract Bridge.
* **Key Components:**
  * **The 7 Exhaustive Graph Closures** (`src/sajimora/closures/`):
    1. `ValueReferenceClosure`: Function invocations, variable assignments, and JSX elements.
    2. `TypeReferenceClosure`: Type annotations, generic arguments, and type aliases.
    3. `InheritanceClosure`: Transitive class extension hierarchies.
    4. `InterfaceImplClosure`: Explicit interface implementations (distinguishing declared `implements` from coincidental structural matches).
    5. `OverrideClosure`: Method overriding across class inheritance trees.
    6. `ReExportClosure`: Multi-hop barrel files, path aliases (`@core/*`), and cyclic re-export cycle guards.
    7. `AmbientReferenceClosure`: Global ambient declarations (`declare global { ... }`).
  * **Generic Relation & Variance Engine**:
    * Evaluates **parameter contravariance** (narrowing parameters breaks callers).
    * Evaluates **return covariance** (widening return types breaks callers).
    * Evaluates **variance inversion on callbacks** (callback arguments inside function parameters flip variance).
    * Enforces **recursion depth guards** and work budgets to prevent infinite loops on recursive types.
  * **Cross-Language Contract Bridge** (`src/sajimora/cross-language/`):
    * **Java Side:** Statically parses Java Spring REST controllers (`@RestController`, `@GetMapping`, `@PostMapping`), JAX-RS annotations, Jackson serialization rules (`@JsonProperty`, `@JsonIgnore`, getters/setters), and Lombok synthesizers.
    * **TypeScript Side:** Extracts API client usage from `fetch`, `axios`, and Angular `HttpClient` invocations.
    * Bridges Java REST response DTOs with frontend TypeScript consumer expectations to detect API wire shape mismatches without running servers.
  * **SQLite Persistent Indexing (Architecture 5)**:
    * Uses `node:sqlite DatabaseSync` to materialize verification facts into a persistent cache.
    * In warm query mode, verifies queries with **0 `ts.Program` builds, 0 `TypeChecker` calls, and 0 Git snapshot materializations**.
  * **V8 Heap Memory Boundary**:
    * Implements `AnalysisContext.dispose()` to explicitly clear closure retention chains and prevent V8 heap OOM crashes.

### 3.3 `@sajimora/impact-analysis` (`packages/impact-analysis`)
* **Role:** Sub-millisecond Candidate Scope Narrowing & Polyglot Bridging.
* **Key Components:**
  * `OfflineDependencyGraph.ts` & `OfflineImpactEngine.ts`: Inverted static dependency graph performing reverse BFS traversals in sub-5ms without compiler initialization.
  * `V32CandidateScopeAdapter.ts`: Narrows candidate file scope by **90% to 99%** with mathematically proven **zero false negatives** (`falseNegatives: 'NONE'`).
  * `extractors/`: Polyglot framework scanners for Java (Spring Boot REST & entities), Go modules, and Rust `pub use` facades.

### 3.4 `@sajimora/change-intelligence` (`packages/change-intelligence`)
* **Role:** Structural Git Diff Ingestion and Entity Change Modeling (ECM).
* **Key Components:**
  * Analyzes syntactic and semantic diffs between Git commits.
  * Classifies changes into entity modifications, signature shifts, removals, and additions.
  * Tracks historical ledger entries for incremental pipeline runs.

### 3.5 `@sajimora/database` (`packages/database`)
* **Role:** High-performance local persistence layer.
* **Key Components:**
  * SQLite schema management and repository abstractions for storing indexed symbols, closures, and cache manifests.

---

## 4. Deep Dive: `rust/` (Native High-Performance Toolchain)

The `rust/` directory provides a pure native workspace (Rust 2021 edition) that can run in CI/CD and production environments with **zero Node.js and zero JVM dependencies**.

### 4.1 Workspace Crates
1. **`crates/contract-core`**:
   * **Artifact Envelopes (V1 & V2):** Canonical JSON serialization, manifest sharding, and SHA-256 digests.
   * **Ed25519 Cryptographic Trust:** Native signing and verification (`sign_ed25519`, `verify_ed25519_signature`, `ArtifactTrustPolicy`). Enables cryptographically sealed supply-chain governance.
   * **Waiver Ledgers:** Scoped endpoint waivers with approver signatures (`WaiverLedger`, `WaiverEntry`).
   * **Deployment State Replay:** Verifies sequential deployment state ledgers to prevent rollback and replay attacks.
   * **Property Test Synthesis:** Automatically synthesizes executable property-based test suites (`jqwik`, `fast-check`, `JUnit 4/5`) directly from extracted contract schemas!
2. **`crates/sajimora-cli`**:
   * Standalone binary (`sajimora`) providing:
     * `check-contract`: Fast compatibility analysis of base, candidate, and target artifacts.
     * `extract-backend`: Native extraction from Java/Spring codebases.
     * `extract-frontend`: Native extraction from TypeScript/JavaScript client code.
     * `build-telemetry`: Ingests JaCoCo XML code coverage and OpenTelemetry spans into sealed telemetry artifacts.
     * `generate-tests`: Synthesizes property tests.
     * `verify` (aliases: `analyze`, `check`, `ci`): One-command contract verification.
     * `dashboard` / `status`: Interactive terminal or web dashboard.
     * `sign` / `verify-envelope`: Ed25519 artifact signing and validation.
     * `init` / `clean` / `doctor`: Repository setup, health audit, and hook installation.
3. **`crates/sajimora-mcp`**:
   * **Native Model Context Protocol (MCP) Server** built with `rmcp` (Tokio async).
   * Exposes `sajimora_check_contract` over stdio transport to AI agents (Cursor, Claude, Devin).
   * Strict security sandboxing: `--allowed-root` filesystem boundaries, admission policies, and concurrent job throttles.
4. **`crates/source-index`**:
   * Blazing-fast streaming Git source code capture, indexing, and AST tokenization.
5. **`crates/telemetry-core`**:
   * Native JaCoCo XML and OpenTelemetry distributed tracing parser.

---

## 5. Deep Dive: `scripts/` (CLI Drivers, MCP Servers & Forensics)

`scripts/` houses executable command implementations, test runners, and diagnostic suites:

### 5.1 `scripts/sajimora/`
* **MCP Implementations:**
  * `mcpServer.cjs`: High-throughput Node.js stdio MCP server featuring an **in-memory bounded result cache** (16 entries, 32MB max, 5-minute TTL), polyrepo support, and fine-grained pagination (`"detail": "evidence"`).
  * `mcpClient.cjs` / `mcpSummary.cjs`: Reusable client SDKs and compact summary formatters.
* **CLI Command Implementations:**
  * `command.ts`, `cli.ts`, `analyze.ts`: Full command dispatching for TypeScript/Git analysis.
  * `analyzeCrossLanguage.ts` & `analyzeJava.ts`: Cross-language Java $\leftrightarrow$ TypeScript pipelines.
  * `checkContract.ts`: Real contract compatibility engine.
  * `keygen.ts`: Generates Ed25519 keypairs and matching `ArtifactTrustPolicy` files.
  * `twoPanelReport.ts`: Isolates certified formal proofs from advisory blast radius.
* **Memory Forensics (`forensic-audit-a/b/c.ts`):**
  * Proved using staged `WeakRef` tests that standard `ts.createProgram` retains historical closures ($T_5 \to T_4 \to T_3 \dots$).
  * Proved that sharing `lib.d.ts` contaminates `SourceFile.locals` across revisions.
  * Validated Sajimora’s explicit isolation boundaries.
* **Qualification Harnesses:**
  * `qualifyThingsBoardCase.ts` & `qualifyThingsBoardWidgetCase.ts`: Full enterprise qualification against ThingsBoard (large-scale IoT platform).
  * `test-real-zod-commit.ts`: Real-world benchmark against Zod monorepo commits.

---

## 6. Deep Dive: `scratch/` (Empirical Evidence & Pilot Labs)

The `scratch/` directory is not mere scrap—it represents the **empirical validation laboratory and proof ledger** of Sajimora:

1. **Large-Scale Enterprise Pilots:**
   * `tb_benchmark/`, `thingsboard-source-profile.json`: Full-scale analysis logs and source profiles of the ThingsBoard production codebase.
   * `polyrepo-real-petclinic/`: Polyrepo cross-repository validation on Spring PetClinic.
2. **AI Agent MCP Pilots:**
   * `agent-mcp-pilot-2026-10-06/`, `agent-mcp-blind-pilot-2026-10-06/`: Head-to-head evaluation of autonomous AI agents using Sajimora MCP tools to detect breaking changes.
   * `mcp-latency-2026-10-06/`: Latency and cache hit rate measurements for LLM tool loops.
3. **Memory & Performance Verification Logs:**
   * Detailed logs of the sub-15ms warm query benchmark and V8 heap stability runs.

---

## 7. Comparative Capability Matrix: Sajimora vs. PactFlow

| Capability | PactFlow (Bi-Directional / BDCT) | Sajimora |
| :--- | :--- | :--- |
| **Analysis Method** | Test execution + mock matching | **Static AST & Variance Algebra** |
| **Developer Overhead** | Requires writing consumer tests or generating Swagger specs | **Zero test-authoring overhead** (analyzes code directly) |
| **Verification Speed** | Seconds to minutes (slow matrix runs in CI) | **Sub-15ms warm indexed queries** |
| **Diagnosis Precision** | High-level route failure in broker | **SHA-256 Incompatibility Witness** (exact file, line & type diff) |
| **Polyglot Monorepos** | Complex broker state & matrix dependencies | **In-process reverse BFS & cross-language AST bridge** |
| **Governance & Trust** | Web broker database records | **Ed25519 Cryptographically Signed Envelopes & Waivers** |
| **AI Agent Support** | Webhook / API integrations | **Dual MCP stdio servers (Rust + Node.js)** |

---

## 8. Essential Developer Workflows

### 8.1 Analyze Current Commit
```bash
npx sajimora analyze
```

### 8.2 Verify Cross-Language Java Spring $\leftrightarrow$ TypeScript Contract
```bash
# Production CI with Ed25519 cryptographic trust verification
sajimora analyze --frontend ./artifacts/frontend.json --trust-policy ./trust-policy.json

# Local development (trusted-local bypass)
sajimora analyze --frontend ./artifacts/frontend.json --trusted-local
```

### 8.3 Enforce Strict CI Gate
```bash
# Block CI on verified violations (exit 1) and fail-closed on inconclusive proofs (exit 3)
sajimora analyze --strict
```

### 8.4 Start the Sajimora Model Context Protocol (MCP) Server for AI Agents
```powershell
# Node.js scoped server with bounded cache
node scripts/sajimora/mcpServer.cjs --allowed-root ./artifacts --trusted-local

# Native Rust MCP server
cargo run --release -p sajimora-mcp -- --allowed-root ./artifacts --trusted-local
```

---

## 9. Summary for Contributors & Reviewers

When working with this codebase:
* **To inspect or modify core proof logic:** Navigate to `packages/core/src/sajimora/algebra/` or `VerdictAuthority.ts`.
* **To add/modify language closures or cross-language rules:** Navigate to `packages/analysis/src/sajimora/closures/` or `cross-language/`.
* **To work on native performance, crypto, or CLI binary:** Navigate to `rust/crates/`.
* **To configure or benchmark AI Agent MCP tooling:** Review `docs/SAJIMORA_MCP.md` and `scripts/sajimora/mcpServer.cjs`.
