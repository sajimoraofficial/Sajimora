# Polyrepo milestone resumed, October 6, 2026

This work continues the source-contract polyrepo product. The separate test-verification direction is paused.

## Conditional operation findings

Scoped assessments now retain branch-specific `conditionalFindings`. A nullable baseline number becoming a string can identify the exact `.toFixed()` consumer without pretending that every baseline payload was safe. Each finding has source identity, receiver path, new and baseline receiver categories, explicit execution/emission preconditions and `universalCompatibility:false`. Unknown baseline categories, guarded operations, unchanged categories and pre-existing rejected categories are excluded. The original `BREAK_PROVED` rule and completed/pending counts are unchanged.

CLI JSON, customer text and default MCP summary expose these findings separately from confirmed breaks. Zero extracted obligations also carries incomplete extraction/qualification counts and specific bounded evidence requests. Missing generated controller interfaces no longer silently disappear without a route blocker.

## Bounded local frontend registry

Prepare an integrity-verified frontend artifact for demand-based lookup:

```powershell
node scripts/test-runtime/run-tsx-command.cjs scripts/sajimora/partitionFrontendArtifact.ts INPUT.json NEW_REGISTRY_DIRECTORY --trusted-local
```

The preparation step accepts at most 128 MiB and refuses an existing output directory. Each derived envelope remains below 20 MiB. Contracts, response operations, profiles and package declaration hashes are retained. Source-owned diagnostics and dependency request importer lists are scoped to each partition; original inventory counts and source artifact/byte hashes remain explicit. No partition asserts a complete repository inventory. Original signatures are not copied onto new seals; registry admission currently requires trusted local mode.

Pass `registry.json` in the MCP `targets` array and select a `consumerEndpoint`, for example `/api/widgetTypeFqns`. The registry captures every source client in its inventory, while a check loads matching concrete/symbolic route partitions. Completely unbound routes remain unassessed and are counted separately. Parameter and wildcard routes are conservatively matched. The tool preserves allowed-root checks, per-file limits, aggregate limits, content hashes and cache invalidation. Coverage applies to the selected partitions, not omitted consumers. A missing selection is an error, not compatibility.

Exact declaration archives can be fetched into an isolated cache from already captured requests:

```powershell
node scripts/sajimora/fetchRequestedDeclarations.cjs ARTIFACT.json CACHE_DIRECTORY @angular/common rxjs typescript @angular/core
```

Only explicitly requested names with one captured version/integrity are admitted. Bytes are bounded and verified against the exact integrity before publication. No package installation or lifecycle code runs. Existing exporter `--dependency-cache CACHE_DIRECTORY` consumes the archives offline. Other dependencies can remain unresolved; no global completeness upgrade is made.

## Results and limits

The deep fixture now has one default-visible conditional finding at `frontend/money.ts:1`; it still has zero universal breaks and one pending obligation. Fresh source extraction of ThingsBoard's widget service, with four requested archives, captures `widgetsBundleFqn.push(fqn)` at line 272 and completes the seeded changed obligation with one confirmed source-contract break. This fixes the missing-operation result of the empty-cache preparation run.

The historical 81.95 MB frontend artifact partitions into 262 route buckets, preserving all 761 client records. Endpoint lookup selects one 548,634-byte partition. Completely unbound route records remain explicitly outside that lookup. Preparing the full registry took 37.4 seconds and approximately 1.28 GiB peak RSS; fresh scoped widget registry preparation took 0.36 seconds and approximately 106 MiB RSS. Those are preparation measurements, not whole-repository extraction performance. The scoped widget extraction still took approximately 82 seconds, under concurrent validation load. The 5–10-second source cold-start target and below-500-MB whole-source preparation target are not established.

An independent real Petclinic producer migration and separate Angular repository now have executable runtime controls. The natural producer change preserves the old array endpoint and adds a page-shaped v2 endpoint. Unsafe adoption of v2 by the old consumer is a seeded variant, not an upstream production regression. Actual Spring MVC/Jackson response captures and the pinned Angular iterable differ reproduce the array/page difference. Sajimora still cannot assess its owner endpoint: generated API mappings are absent from the source snapshot, with additional route/profile/template qualification gaps. This is retained as an engine limitation, not a passed compatibility case or a benchmark win. Generic evidence derived from the same incomplete extraction also lacks the owner endpoint. No fresh agent score/cost comparison was performed.

Reports: `rust/audit/polyrepo-resume-2026-10-06/RESULTS.md` and `rust/audit/polyrepo-real-petclinic-2026-10-06/RESULTS.md`. Tests: `scripts/sajimora/polyrepoResume.test.cjs`, `benchmarks/polyrepo/petclinic-runtime.cjs`, `benchmarks/polyrepo/petclinic-check.cjs`, the cross-language suite and existing MCP integration.
