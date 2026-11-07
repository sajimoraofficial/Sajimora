# Sajimora fixture protocol

Fixtures are evidence inputs, never hidden production rules.

- `synthetic/` contains minimal repository-neutral language fixtures. Each fixture must declare its files, mutation, expected structural facts, expected authority decision, and toolchain constraints.
- `historical/` contains metadata identifying real repositories and immutable revisions. Expected observations must come from an independent oracle; benchmark labels are never visible to production analysis.
- `diagnostics/` records observed stopping points and blockers. Diagnostic records are explicitly non-authoritative and must not contain correctness labels.

Production code must not branch on fixture names, repository names, paths, commit SHAs, case IDs, or expected results.
