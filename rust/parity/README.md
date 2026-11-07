# Sajimora Parity Verification

This directory contains cross-language parity qualification scripts comparing the TypeScript reference implementation against the native Rust checker (`sajimora`).

## Running Parity Verification

Build the release or debug Rust binaries first:
```bash
cargo build --manifest-path rust/Cargo.toml --release
```

Run the parity verification suite:
```bash
node scripts/test-runtime/run-tsx-command.cjs rust/parity/run-parity.ts
```

## Parity Scenarios Covered

1. **Identical Backend Contract**: Candidate matches base backend contract. Both TypeScript and Rust engines assert `LIKELY_PRESERVED` (or `INCONCLUSIVE` if unlinked) with 0 findings.
2. **Breaking Change**: Candidate backend removes endpoint referenced by frontend contract. Both engines assert `LIKELY_VIOLATED` with 1 finding.
3. **Incomplete Candidate**: Candidate artifact has `completeness.complete = false`. Both engines upgrade overall verdict to `INCONCLUSIVE`.

## Report semantics qualification

```powershell
node scripts/test-runtime/run-tsx-command.cjs rust/parity/report-semantics.ts
node rust/audit/groceries-pilot/run-pilot.cjs
```

The first command checks every report field across 188 backend/frontend cases:
all primitive scalar pairs in request and response directions, bodyless object/unknown/void consumers, required and
constrained path/query/header obligations, artifact incompleteness, extraction
warnings, and all supported constraint names. Only set ordering (findings,
blockers, evidence and unresolved evidence) is normalized. Finding IDs, source
columns, changes, counts, hints, digests and completeness values are compared.
The second command qualifies four real groceries source cases without adapting
the shared Axios client. Results are saved under audit/groceries-pilot/qualified/.

V1 counts retain these explicit reference semantics: changedEndpoints counts
changed route/direction entries, including parameter/header changes;
linkedEndpoints counts distinct linked source-call/snapshot keys;
affectedConsumers sums consumer entries across findings (a repeated site can be
counted more than once); unresolvedLinks counts unresolved comparison entries,
excluding artifact-level incompleteness messages. It is not a unique-link count.

Primitive changes and accepted constraint names use their serialized wire names,
not Rust Debug variant names. Primitive mismatch IDs have intentionally changed
to match the TypeScript reference. Neither this bounded matrix nor the groceries
pilot qualifies arbitrary codecs, unknown response types, all repositories or
unrestricted release acceptance.
