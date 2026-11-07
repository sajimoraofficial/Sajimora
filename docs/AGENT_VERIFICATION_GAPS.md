# Consumer-operation test evidence

Sajimora can now connect a captured API-change obligation to explicitly recorded local test cases. The Node MCP tool `sajimora_check_verification` reads a small plan and test-run records. It does not re-extract the repository or execute code. Existing F0, advisory and scoped compatibility verdicts retain their own semantics.

The useful question is: **Did supplied tests exercise and assert this affected consumer operation for this reviewed input and source revision?** A green test suite or line-coverage report alone cannot answer it.

| Result | Meaning |
|---|---|
| `OBSERVED_ASSERTION_PASS` | The recorder observed the operation return and configured equality assertions pass for one exact injected input |
| `OBSERVED_FAILURE` | The operation threw or a configured assertion failed for that case |
| `EXERCISED_WITHOUT_ASSERTION` | The operation returned, but no passing behavioral assertion was recorded |
| `NO_MATCHING_EXECUTION` | No current matching execution was supplied; this does not prove no test exists |
| `CONFLICTING_OBSERVATIONS` | Matching runs contain both passing and failing observations |
| `STALE_PLAN` | The plan differs from caller-supplied current review identities and must be regenerated |

Every result retains `universalCompatibility:false`. An observed failure is not automatically a newly introduced regression. Baseline/candidate comparison, actual producer conformance and execution preconditions require separate evidence. Source-contract results never become compatible because these test cases passed.

## Recording real tests

Use `scripts/sajimora/verificationEvidence.cjs`. `planFromAssessment(report, obligationId, context, cases)` builds a plan from an existing scoped assessment and explicit caller-selected input cases. It includes source-bound consumer sites and input hashes; it does not invent representative or exhaustive cases. `createPlan` also supports already selected obligations. Context includes producer and consumer revisions, environment ID and SHA-256 of the actual test harness. `proofKey` binds the captured contract generation.

`createRecorder(plan, runId)` exposes `record` and `finish`. In a local test:

```js
await recorder.record({
  obligationId, caseId, testId,
  input: responseBody,
  sourceBytes: actualConsumerSource,
  invoke: body => actualConsumerCallback(body),
  assertions: [{target: 'INPUT_AFTER', expected: ['existing', 'new']}]
});
```

`RETURN` assertions compare the actual callback return; `INPUT_AFTER` assertions compare the mutated input. The recorder runs `node:assert/strict` equality checks itself. Expected values must be independently meaningful for the reviewed behavior. The caller is responsible for wiring the real callback faithfully; a mocked or unrelated callback cannot establish production execution. Capture asynchronous work by awaiting it inside `invoke`; detached tasks are outside the observation. Record a separate immutable run after completion. Inputs/oracle values and error messages are omitted from run records; their hashes and built-in error classes are retained. Plans and recordings are bounded finite JSON, not signed execution attestations.

This first adapter works with Node-based test callbacks, including code called from Jest/Vitest or `node:test`; no automatic test-runner instrumentation, assertion-coverage inference, Java/JUnit adapter or deployed HTTP tracing is implemented.

## MCP and CLI

Start the existing scoped MCP server with allowed roots and `--trusted-local`. Test evidence currently has no producer trust-policy admission; the tool rejects that startup mode for verification requests rather than silently trusting test records.

Call `sajimora_check_verification` with:

```json
{
  "plan": "./artifacts/verification-gap/plan.json",
  "runs": ["./artifacts/verification-gap/baseline-run.json"],
  "current": {
    "proofKey": "<current contract proof key>",
    "producerRevision": "<current producer revision>",
    "consumerRevision": "<current consumer revision>",
    "environmentId": "<test environment/profile>",
    "testHarnessSha256": "<current harness content hash>"
  },
  "limit": 10,
  "offset": 0
}
```

Supply identities from the current review, not blindly copied historical runs. The tool checks these against the plan and run records; it does not independently inspect a Git checkout to certify that the caller supplied its latest revision. A fresh plan changes identity when consumer source, input cases or harness identities change. Stale runs cannot contribute a pass. Source hashes establish byte identity, not authenticity; local admission and trustworthy harness wiring remain necessary.

Results put gaps/failures before passes. `selection.nextOffset` paginates cases, maximum 20 per response, while global coverage remains unchanged. Paths are realpath checked against allowed roots; each file is bounded to 20 MiB and aggregate input to 100 MiB. The tool never imports or runs a supplied test program.

CLI:

```powershell
node scripts/sajimora/checkVerification.cjs --plan rust/audit/verification-gap-2026-10-06/plan.json --run rust/audit/verification-gap-2026-10-06/baseline-run.json --current rust/audit/verification-gap-2026-10-06/current.json --trusted-local
```

## Qualification

Run `node scripts/sajimora/verificationEvidence.test.cjs` for admission, provenance, finite cases, conflicts, tampering and stale identities. Run `node benchmarks/envelope-preparation/verification-pilot.cjs` for the actual frozen ThingsBoard callback and official SDK transport checks. Existing MCP contract integration remains covered by `node scripts/sajimora/mcpServer.test.cjs`.

The pilot uses a known array-to-object seed, actual callback source and mocked transport. It proves the tool distinguishes a passing baseline case from a missing candidate check, then records candidate `TypeError`. It does not establish production completeness, increased agent benchmark scores, uniqueness or buyer demand. Results are in `rust/audit/verification-gap-2026-10-06`.
