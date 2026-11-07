'use strict';
const fs=require('node:fs'),p=require('node:path');
const root=p.resolve(__dirname,'../..'),resume=p.join(root,'rust/audit/polyrepo-resume-2026-10-06'),pet=p.join(root,'rust/audit/polyrepo-real-petclinic-2026-10-06'),read=file=>JSON.parse(fs.readFileSync(file));
const integrated=read(p.join(resume,'integration.json')),runtime=read(p.join(pet,'runtime-controls.json')),mcp=read(p.join(pet,'mcp-result.json'));
fs.writeFileSync(p.join(resume,'RESULTS.md'),`# Polyrepo source-contract continuation — October 6, 2026

## Implemented and verified

1. Deep-flow branch qualification: default MCP returns ${integrated.conditional.findings.length} conditional operation finding at frontend/money.ts:1 for a new string receiver reaching value.toFixed(2). Universal coverage remains ${integrated.conditional.coverage.completed} completed / ${integrated.conditional.coverage.breaks} proved breaks / ${integrated.conditional.coverage.pending} pending. Unknown baseline categories, guarded operations, unchanged categories and pre-existing rejected categories do not become new conditional findings. Customer text and sanitized JSON expose the same distinction.
2. Large artifact ingestion: the actual historical 81.95 MB frontend artifact becomes an integrity-bound local registry with 262 partitions, retaining 761 client records. The widget route loads ${integrated.registry.selectedBytes.toLocaleString('en-US')} bytes and one consumer instead of the whole artifact. Unbound routes and omitted consumers remain explicitly unassessed. Every partition preserves the 20 MiB limit; aggregate, root and hash checks remain enforced. New seals do not inherit original signatures; trusted local admission is required. Full registry preparation took 37.42 seconds and 1,370,435,584-byte lifetime peak RSS (about 1.28 GiB). This preparation memory is substantial and does not establish below-500-MB operation.
3. Fresh dependency/source integration: an isolated empty cache received only four exact, requested, integrity-verified archives: Angular common/core 20.3.28, RxJS 7.8.2 and TypeScript 5.9.3. No installation or lifecycle execution. Fresh extraction of the original widget service recovered widgetsBundleFqn.push(fqn) at line 272. The seeded array-to-object check now reports ${integrated.freshWidget.coverage.breaks} confirmed break, ${integrated.freshWidget.coverage.completed} completed changed obligation and ${integrated.freshWidget.coverage.pending} pending in that selected scope. Other source facts remain incomplete.

## Measured integration

| Prepared-evidence check | First check | Same-session warm check | Structured response |
|---|---:|---:|---:|
| Fresh widget registry + real checker | ${(integrated.freshWidget.coldMs/1000).toFixed(2)} s | ${(integrated.freshWidget.warmMs/1000).toFixed(2)} s | ${integrated.freshWidget.responseBytes} bytes |
| Historical whole-artifact registry, selected route | ${(integrated.registry.callMs/1000).toFixed(2)} s | Not separately sampled | ${integrated.registry.responseBytes} bytes |

One local integration sequence; server startup, source extraction, archive acquisition, partition preparation and parent/model work are excluded. OS caches were not cleared. Concurrent regression/typechecking load is uncontrolled. This is not an agent-cost result or an average latency estimate. The scoped widget source extraction itself took approximately 82 seconds. A small fresh widget registry took 0.36 seconds and about 106 MiB peak RSS to prepare. The complete 5–10-second source cold-start target remains unmet/unestablished.

## Independent migration validation

The real Petclinic REST owner-pagination migration and separate Angular consumer now have runtime controls: old endpoint passes before/after; a seeded unsafe adoption of the new page-shaped endpoint fails the actual Angular iterable differ; an explicit content adapter passes the finite display case. Sajimora still completes zero owner assessments because generated interface mappings are missing, with route, Spring profile and template qualification gaps. See ../polyrepo-real-petclinic-2026-10-06/RESULTS.md. This is a useful failure case, not a product advantage or a new engine-proved break.

## Validation and reproducibility

Cross-language regression: 32 Vitest files / 347 tests, plus standalone suites. Existing official-SDK ThingsBoard integration retains one break, zero unchanged-control breaks, and 25 obligations / 6 completed / 19 pending. Additional official-SDK resume tests verify conditional output, unchanged control, registry selection, source/integrity failures, finite archive acquisition controls and fresh widget finding/cache parity. Final command results are retained in regression.log, mcp-regression.log, integration.log and typecheck.log. Runtime witnesses are independently reproduced by benchmarks/polyrepo/runtime-controls.cjs. No repository-wide compatibility or agent uplift is claimed.

Reproduce integration with node scripts/sajimora/polyrepoResume.test.cjs. Usage: ../../../docs/POLYREPO_RESUME.md. Historical scores and original source artifacts were not relabeled. Existing F0/advisory verdict rules remain separate; inherited-mapping uncertainty is now explicitly reported rather than silently skipped. The separate test-verification product remains paused.
`);
fs.writeFileSync(p.join(pet,'RESULTS.md'),`# Independent real polyrepo migration — Petclinic

Producer: https://github.com/spring-petclinic/spring-petclinic-rest. Natural owner pagination migration: https://github.com/spring-petclinic/spring-petclinic-rest/pull/328. Parent ${runtime.producerBase}; candidate ${runtime.producerCandidate}. Separate consumer: https://github.com/spring-petclinic/spring-petclinic-angular at ${runtime.consumerRevision}. Producer Apache-2.0 headers and consumer license remain with the captured source. Internal calibration only; no external publication.

| Runtime cell | Result |
|---|---|
| Old producer / old array endpoint / old consumer behavior | Pass, two owners |
| New producer / old array endpoint / old consumer behavior | Pass, identical old-endpoint response |
| New page endpoint / unadapted old consumer behavior | Fail: NG0900, object is not an iterable |
| New page endpoint / explicit content adapter | Pass, two owners in the returned page |

The natural producer migration is backward-compatible at the old endpoint. The failing variant explicitly seeds unsafe consumer adoption of v2; it is not an upstream production regression. Actual upstream Spring MVC/controller/mapper/Jackson tests generated the responses, with ClinicService mocked. The actual consumer initialization method body and locked Angular 22.2.1 DefaultIterableDiffer execute against those captures. HTTP Observable/finalize scheduling is mocked and no browser/full Angular application build was run. The content adapter validates a finite display case, not complete pagination UX or all release states.

Independent oracle import contains no Sajimora engine. Runtime control phase: ${(runtime.elapsedMs/1000).toFixed(2)} seconds, ${(runtime.peakRss/1048576).toFixed(2)} MiB process peak RSS, ${(runtime.heap/1048576).toFixed(2)} MiB sampled heap. These numbers exclude cloning, Maven compilation/dependency download/test execution and model work. Two candidate MVC tests and the matching parent MVC test passed; test-only response capture hooks are the only tracked modifications in the isolated producer fixtures. Production exports use immutable commit snapshots. Consumer remains clean.

## Sajimora result

Zero completed owner assessments, zero proved breaks and zero conditional findings. Extracted producer inventory contains only eight root-controller method variants and misses owner API declarations generated by OpenAPI. The frontend route and response/template qualification are incomplete. Spring configuration/profile facts also remain unresolved. Current MCP reports extraction.complete=false and ${mcp.extraction.blockerCount} source qualification blockers grouped into bounded evidence requests; zero extracted obligations is explicitly not compatibility. New generic inherited-interface route blockers identify the missing mappings rather than silently overlooking them.

Prepared artifacts: MCP startup ${(mcp.startupMs/1000).toFixed(2)} seconds, first check ${(mcp.firstMs/1000).toFixed(2)} seconds, warm check ${(mcp.warmMs/1000).toFixed(2)} seconds, ${mcp.responseBytes} structured bytes. One sequence, OS cache not cleared; excludes extraction/build/runtime preparation. No fresh agent comparison or agent token/cost score. Generic evidence derived from these same source artifacts also lacks the owner endpoint; a direct source/runtime evidence service could provide more information. No Sajimora advantage is established here.

Reproduce runtime: node benchmarks/polyrepo/petclinic-runtime.cjs after reproducing MVC captures and exact locked runtime archives. Reproduce SDK check: node benchmarks/polyrepo/petclinic-check.cjs. Fixture paths: scratch/polyrepo-real-petclinic/{producer,producer-base,consumer}; response hooks in OwnerRestControllerTests write target/polyrepo-old-owners.json and target/polyrepo-page-owners.json. Controller test commands use a workspace Maven cache, select testGetAllOwnersSuccess and testGetOwnersPageSuccess, and preserve upstream assertions. Raw source artifacts, response identity, source/template hashes, controls and MCP measurements are beside this report.

Remaining product work exposed: capture generated API declarations with build provenance, qualify inherited Spring mappings and context paths, then qualify the consumer's route, response transforms and actual template iterable binding. Do not loosen contracts, treat annotations as validation, or call this pending case compatible.
`);
console.log('Polyrepo continuation and independent migration reports written.');
