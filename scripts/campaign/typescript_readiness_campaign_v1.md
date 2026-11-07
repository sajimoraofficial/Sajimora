# TypeScript Readiness Campaign v1

`typescript_readiness_taxonomy_v1.json` is the versioned coverage contract, and `typescript_commercial_readiness_matrix_v1.md` is the authoritative A–AI checklist. The generator emits a deterministic 10,000-row **design ledger**, not executable repository fixtures:

```powershell
node scripts/test-runtime/run-tsx-command.cjs scripts/campaign/generate_typescript_readiness_campaign.ts
```

The generated file is `artifacts/typescript_readiness_design_v1.json`. It includes one row for each of the current **482 matrix items** (section headings, listed variants, and explicit AF/AI composition cases), covers every declared dimension value, reserves rows for every feasible pair across dimensions, and records explicit exclusions. Current v1 pair coverage requires 9,701 rows, leaving 299 rows for additional higher-order diversity within the 10,000-row budget. This establishes representation in the design ledger; it does not mean all combinations are executable or supported.

Each design row is marked `NOT_MATERIALIZED`, and P0 certification status is `NOT_ASSESSED`. Before a row can enter an analyzer baseline, materialization must provide sealed parent/candidate source and configuration bytes, an explicit oracle source (`CONSTRUCTION`, `INDEPENDENT_COMPILER`, or `REVIEWED_FIXTURE`), expected outcome, UNKNOWN classification where applicable, evidence reference, and the complete per-case execution envelope. Compiler checks may establish binding, resolution, and type facts; preservation labels require a construction-backed or reviewed semantic oracle. P0 families must include supported cases that can certify, plus adversarial negatives. Unsupported non-P0 patterns may remain UNKNOWN only with a tested reason. A certified Sajimora result without a valid proof path and matching independent oracle blocks the campaign release gate.

Run staging:

1. Validate the small sealed slice and focused target-scoping tests.
2. Materialize, validate, and seal the complete corpus and all oracles before running Sajimora; then freeze that output as the baseline.
3. Compare one analyzer support change at a time against the frozen cases and oracles.

Report certification, expected UNKNOWN, unexpected UNKNOWN, proof-path violations, false positives, oracle disagreements, and resource outcomes by taxonomy family and composition. The 10,000 design rows do not count as executed cases or as evidence of commercial readiness.
