# Sajimora scoped MCP

This Node stdio server calls the same real `checkContract.ts` engine used by the ThingsBoard qualification. It supplements the existing Rust MCP server, which uses the Rust comparison service. It returns confirmed source-contract breaks, affected consumers, completed scopes, assumptions and unresolved evidence separately.

The [polyrepo continuation](POLYREPO_RESUME.md) adds separate conditional operation findings, explicit extraction gaps when no obligations were captured, and bounded local frontend registry partitions selected with `consumerEndpoint`. These additions do not turn pending obligations into compatible results. Registry partitions currently require trusted local admission.

Start it with Node 20+ after installing the project's locked dependencies:

```powershell
node scripts/sajimora/mcpServer.cjs --allowed-root ./artifacts --trusted-local
```

Client configuration (generic MCP JSON; use the equivalent setting for your client):

```json
{
  "mcpServers": {
    "sajimora": {
      "command": "node",
      "args": [
        "./scripts/sajimora/mcpServer.cjs",
        "--allowed-root", "./artifacts",
        "--trusted-local"
      ]
    }
  }
}
```

Tool: `sajimora_check_contract`

An additional read-only tool, `sajimora_check_verification`, checks locally supplied consumer-operation test evidence without rerunning extraction. It reports finite assertion results and remaining/stale verification gaps independently of contract verdicts. See [Agent verification gaps](AGENT_VERIFICATION_GAPS.md) for the test adapter, identity requirements and limits.

```json
{
  "base": "./artifacts/base.json",
  "candidate": "./artifacts/candidate.json",
  "targets": ["./artifacts/frontend.json"],
  "assessUnchanged": true
}
```

By default, `structuredContent` contains only `BREAK_PROVED` assessments with consumers and witnesses, plus unchanged coverage counts and omitted-detail counts. Pending coverage never becomes compatible. Set `"detail": "full"` to retrieve all assessments, evidence requests and proof records. A confirmed break is a successful tool execution; invalid artifacts and extraction failures return `isError: true`. Use `assessUnchanged` for explicit controls; its default is changed obligations only. Summary formatting reduces output size, not the engine's analysis work.

The Rust MCP adapter also defaults to summary and accepts `detail=full`. Its native report is advisory and does not supply scoped `BREAK_PROVED` statuses; its summary retains `LIKELY_VIOLATED` findings and unresolved counts without upgrading assurance. CLI output is unchanged.

The server compares existing sealed artifacts; generating them remains the source-export CLI workflow. It does not yet expose extraction tools, edit source, run tests, or measure an agent benchmark score. No global client configuration is changed by this implementation.

The Node scoped server now keeps an in-memory result cache (16 entries, 32 MiB total, five-minute TTL). Every request still resolves allowed roots, reads current artifact bytes and enforces size limits. Cache keys include artifact content hashes, current engine source and dependency lockfile hashes, captured trust-policy bytes, and analysis options. Presentation detail is independent: summary/full share the same analysis. Pending coverage stays pending. Cache entries do not certify that source snapshots reflect a deployed system. Locked dependency installation is assumed; restart after replacing installed dependencies.

Use `--no-cache` at server startup for comparison measurements. Results include `_meta.sajimora.cache` and server phase timings. Misses still start a checker process; this implementation is a bounded result cache, not a persistent analysis worker or an extraction cache. Keep the MCP client connection open to retain warm entries. The Rust adapter does not use this Node result cache.

Trust is configured at startup, never by the agent's tool arguments. `--trusted-local` explicitly trusts local producers while still checking artifact integrity. For producer admission use `--trust-policy FILE` instead. Allowed roots are resolved before access, input snapshots are copied into private temporary files, each artifact is bounded to 20 MiB and aggregate inputs to 100 MiB. At most two jobs run concurrently; jobs time out after 120 seconds and support MCP cancellation. Diagnostics stay off protocol stdout.

For pending coverage, use `"detail":"evidence"`, `"endpoint":"/api/invoice"`, `"offset":0`, and `"limit":10` (maximum 20). This returns scoped consumer operations, assumptions and missing evidence without the full proof-record dump. Coverage counts remain global; an empty selection does not establish compatibility. `selection.nextOffset` supports pagination. Exact endpoint IDs are also accepted. This mode is currently available in the Node scoped server.

Reusable Node clients can use `createScopedClient` from `scripts/sajimora/mcpClient.cjs`, call `check(input)` repeatedly, and close once after the review. Supply allowed roots and either trusted-local mode or a trust policy. Forward `report` once rather than duplicating structured and text responses. Recreating the connection for every check discards the server cache.

Integration test:

```powershell
node scripts/sajimora/mcpServer.test.cjs
```

The test uses the official MCP SDK client, invokes real ThingsBoard break/control checks, verifies CLI parity and rejects unauthorized paths and tampered artifacts. Protocol reference: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
