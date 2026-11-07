# Sajimora Native Rust Engine — Release & Cutover Guide

## Release Overview

| Property | Value |
|---|---|
| Engine Version | 0.1.0 |
| Rust Toolchain | rustc 1.80+ / cargo |
| Architecture Target | Multi-platform (`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`) |
| Native Dependencies | System/runtime libraries; no Node.js runtime required. |
| Project License | SEE LICENSE IN LICENSE (Sajimora Software License Agreement) |

---

## Release Binary Manifest & Cryptographic Checksums

Target release binaries compiled under `rust/target/release/`:

| Binary | Size | SHA-256 Checksum (Hex) | Purpose |
|---|---|---|---|
| `sajimora.exe` | ~1.71 MiB | `77A8433449CD4927D2E4E91E86B39C39A294DA164EAF2EE7192342133DF9A9F3` | Native standalone CLI artifact comparison tool |
| `sajimora-mcp.exe` | ~3.59 MiB | `C10C152E88B69E360C16BEFFBDBD4FCCB6FBBF5CB2D333ABF4321911D1BF8E76` | Model Context Protocol (MCP) stdio server |

---

## Security & Operational Boundary

1. **Intended Role**:
   - The native Rust engine is an **advisory artifact comparison engine** operating on sealed contract envelopes (`SAJIMORA_CONTRACT_ARTIFACT_V1`).
   - It performs cryptographic digest validation, authorization checks against trusted producers/keys, wire type inclusion, and compatibility report generation.
2. **Extraction Responsibility**:
   - Extraction of Java/Spring MVC contracts and TypeScript HTTP consumers remains the responsibility of the compiler-backed TypeScript extractors (`packages/analysis/src/sajimora/cross-language/`).
   - Rust does not directly compile or parse Java/TS source files.
3. **Verdict Policy**:
   - Precedence: `ANALYSIS_ERROR` > `LIKELY_VIOLATED` > `INCONCLUSIVE` > `LIKELY_PRESERVED`.
   - Incomplete extractions automatically upgrade `LIKELY_PRESERVED` to `INCONCLUSIVE`.
   - Native CLI and MCP outputs are **advisory impact assessments**; verdicts should inform code reviewers and CI pipelines rather than acting as opaque, unconditional hard-blockers.
4. **Hardened Admission & Validation**:
   - Envelope schemas reject undeclared fields (`#[serde(deny_unknown_fields)]`).
   - Canonical JSON respects ECMAScript numeric representations (including boundary numbers like `1e20`).
   - Enforces supported profiles (`SPRING_MVC`, `JACKSON_DEFAULT_V1`, `STATIC_FETCH_V1`, `MULTI_CLIENT_V1`).
   - MCP filesystem containment uses component-aware hierarchy checks preventing sibling directory traversal.
   - Enforces aggregate artifact memory bounds (100 MB max aggregate payload).

---

## Usage Instructions

### Native CLI (`sajimora.exe`)
```powershell
sajimora.exe check-contract `
  --base path/to/backend-base.contract.json `
  --candidate path/to/backend-candidate.contract.json `
  --target path/to/frontend.contract.json `
  --trusted-local `
  --out report.json
```

- When `--out` is specified, the report is written atomically and stdout remains clean.
- On valid runs with any advisory verdict, the CLI exits with code `0`.
- On admission failures (tampered digest, unverified signature, unknown schema properties, unsupported profiles) or invalid arguments, the CLI exits with nonzero code `1`.

### Native MCP Server (`sajimora-mcp.exe`)
Configure the server in your MCP client (e.g., Claude Desktop, Antigravity, or Cursor settings):
```json
{
  "mcpServers": {
    "sajimora": {
      "command": "/path/to/sajimora/rust/target/release/sajimora-mcp",
      "args": [
        "--allowed-root", "/path/to/target-repo",
        "--trusted-local"
      ]
    }
  }
}
```

---

## Cutover & Rollback Strategy

### Cutover Plan
1. Ensure the release binaries are built and checksummed:
   ```powershell
   cargo build --manifest-path rust/Cargo.toml --release --locked
   ```
2. Run automated validation:
   ```powershell
   node rust/packaging/smoke-test.cjs
   node scripts/test-runtime/run-tsx-command.cjs rust/packaging/test-export-to-rust-flow.ts
   node scripts/test-runtime/run-tsx-command.cjs rust/parity/run-parity.ts
   ```
3. Update CI/CD tasks to point to `rust/target/release/sajimora.exe` for artifact comparison steps while keeping TypeScript extraction scripts (`scripts/sajimora/exportContract.ts` and `scripts/sajimora/exportFrontendContract.ts`).

### Rollback Plan
If an unexpected edge case or contract incompatibility arises in production:
1. Revert the comparison step to the qualified reference TypeScript implementation:
   ```powershell
   node scripts/test-runtime/run-tsx-command.cjs scripts/sajimora/checkContract.ts `
     --base path/to/base.json `
     --candidate path/to/candidate.json `
     --target path/to/target.json `
     --trusted-local `
     --out report.json
   ```
2. The TypeScript implementation remains available for rollback. Its qualified tests cover selected scenarios; review incomplete extraction and unsupported obligations manually.

Strict service mapping is enabled by default. V1 frontend artifacts do not prove
required or constrained query/header/path parameter supply; these obligations
produce INCONCLUSIVE while retaining any definite body violations. Changed endpoint
counts include parameter/header changes. Windows output uses same-directory
MoveFileExW replacement without a backup/missing-file window; no cross-volume
copy fallback or power-loss durability guarantee is claimed.

Number formatting uses pinned [ryu-js](https://github.com/boa-dev/ryu-js), including
binary64 conversion of integer tokens to match JSON.parse semantics. Windows
replacement follows [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

For the local validation binaries in this manifest, Windows compiler file locks
required disabling LTO and incremental compilation. Reproduce that build with:

```powershell
$env:CARGO_PROFILE_RELEASE_LTO = 'false'
$env:CARGO_INCREMENTAL = '0'
cargo build --manifest-path rust/Cargo.toml --release --locked --offline -j 1
```

The workspace default remains thin LTO. Changing build settings can change hashes
and sizes; regenerate the manifest after any build. These binaries are for local
qualification; dependency/license review and independent release acceptance remain
required before distribution.

## Current supervised beta qualification

Report semantics are qualified against the TS reference in 188 constructed
backend/frontend cases and four real groceries source-change cases. See
[../parity/README.md](../parity/README.md) and
[../audit/groceries-pilot/PILOT_RESULTS.md](../audit/groceries-pilot/PILOT_RESULTS.md).
Counts and primitive finding IDs have intentionally changed to align documented
reference meanings; rebaseline stored primitive-mismatch IDs after upgrading.

The groceries extraction remains incomplete: 91 endpoints, 43 source calls and
three typed responses. Page/wildcard responses, custom/profile-dependent Jackson,
dynamic URLs, untyped JS and full consumer traversal are not qualified. Native
reports retain that uncertainty. Baseline nullability findings have a source
review and must not be treated as independently observed runtime failures.

These Windows EXEs passed standalone execution and report replacement with empty
PATH; no global PATH installation or live HTTP/database test is implied. Use the
supported artifact scope for supervised beta. Packaging is implemented; final
release acceptance, runtime codec/pagination qualification and distribution
dependency/license review remain open.
