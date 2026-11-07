const fs = require('fs');
const path = require('path');

const labelsDir = path.join(process.cwd(), 'scripts/campaign/labels');
if (!fs.existsSync(labelsDir)) {
  fs.mkdirSync(labelsDir, { recursive: true });
}

// Exact frozen labels for Turborepo (9 cases)
const turborepoLabels = [
  {
    commitSha: "06f59004ba50fabd4c582230ed076ee909fb85fc",
    parentSha: "06f59004ba50fabd4c582230ed076ee909fb85fc^",
    targetSymbol: "getAvailablePackageManagers",
    targetFile: "packages/create-turbo/src/commands/create/index.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Refactored package manager detection to reuse detection results without altering the returned data contract or caller expectations.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "25fe817c05f0d886316ee7bb5087b1589239b4ae",
    parentSha: "25fe817c05f0d886316ee7bb5087b1589239b4ae^",
    targetSymbol: "module.exports",
    targetFile: "examples/with-docker/apps/api/.eslintrc.js",
    expectedVerdict: "PRESERVED",
    rationale: "Example ESLint configuration update; exports flat config compatible with ESLint execution in example apps.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "4db9ca09bdac8cc0f8ece533cc480c10947f7bc1",
    parentSha: "4db9ca09bdac8cc0f8ece533cc480c10947f7bc1^",
    targetSymbol: "GET",
    targetFile: "apps/docs/app/api/binaries/version/route.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Optimized route payload fetching by calling dist-tags endpoint; response format remains JSON string version compatible with API clients.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "77e975c94fea84e4056394b085de3cf2edb370ca",
    parentSha: "77e975c94fea84e4056394b085de3cf2edb370ca^",
    targetSymbol: "eveAgent",
    targetFile: "apps/factory/agent/channels/eve.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Added thinking-effort parameter to agent channel options with optional default value; existing invocation sites are unimpacted.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "8cc0c42f97651847c2b5a0831e6d77e1db2b1d14",
    parentSha: "8cc0c42f97651847c2b5a0831e6d77e1db2b1d14^",
    targetSymbol: "findInstalledTurboLsp",
    targetFile: "packages/turbo-vsc/src/extension.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Converted synchronous LSP probe to nonblocking async execution; return promise resolves to same path identity contract.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "a6b88eefa867457c8eab806515628bbfe882ebf5",
    parentSha: "a6b88eefa867457c8eab806515628bbfe882ebf5^",
    targetSymbol: "downloadAndExtractRepo",
    targetFile: "packages/turbo-utils/src/examples.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Streamed download buffer directly to disk rather than allocating full ArrayBuffer; signature and return type contract preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "c02f97ef2bbfb2e1179fba6197fa44bc825f5d10",
    parentSha: "c02f97ef2bbfb2e1179fba6197fa44bc825f5d10^",
    targetSymbol: "createRule",
    targetFile: "packages/eslint-plugin-turbo/lib/rules/no-undeclared-env-vars.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Cached Turbo config reads across rule invocations; rule AST listener interface remains fully backward compatible.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "ef4677219f6d31911aff5a0c5aa953c53e12c40b",
    parentSha: "ef4677219f6d31911aff5a0c5aa953c53e12c40b^",
    targetSymbol: "calculateDepths",
    targetFile: "apps/docs/app/[lang]/devtools/devtools-client.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "Optimized graph depth calculation to single outgoing adjacency pass; outputs identical depth map structure.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "efbe558dfc240ac818a049197da8573a4238fb6d",
    parentSha: "efbe558dfc240ac818a049197da8573a4238fb6d^",
    targetSymbol: "copy_file_dependencies",
    targetFile: "turborepo-tests/integration/fixtures/monorepo_with_shared_file_deps/apps/docs/src/index.js",
    expectedVerdict: "PRESERVED",
    rationale: "Deduplicated shared file copy passes during prune without changing resultant pruned directory contents.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  }
];

// Exact frozen labels for TypeScript-Website (10 cases)
const tsWebsiteLabels = [
  {
    commitSha: "0994ee75cf7b99f3f735a23abcf79f27402c1057",
    parentSha: "0994ee75cf7b99f3f735a23abcf79f27402c1057^",
    targetSymbol: "EditorExamples",
    targetFile: "packages/typescriptlang-org/src/components/index/EditorExamples.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "Component render refactor without altering props interface or exported React element contract.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "0daa298f2f4526f8c66baff00b8df0290e37a4d4",
    parentSha: "0daa298f2f4526f8c66baff00b8df0290e37a4d4^",
    targetSymbol: "createPages",
    targetFile: "packages/typescriptlang-org/gatsby-node.js",
    expectedVerdict: "PRESERVED",
    rationale: "Internal Gatsby page generation logic updated; external build system hooks preserve required signature.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "119f931a639c9215a27311fde459c6db0b8718e4",
    parentSha: "119f931a639c9215a27311fde459c6db0b8718e4^",
    targetSymbol: "AllFilenames",
    targetFile: "packages/documentation/scripts/types/AllFilenames.d.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Declaration file expanded string union literal with new docs pages; consumers remain type-compatible.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "1843cf45e06193b3dc072088785fe2bfad477de5",
    parentSha: "1843cf45e06193b3dc072088785fe2bfad477de5^",
    targetSymbol: "createVirtualTypeScriptEnvironment",
    targetFile: "packages/typescript-vfs/src/index.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Virtual environment factory signature preserved; optional configuration property added.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "1e398d648b3e670423b477f18b64ed1a41943792",
    parentSha: "1e398d648b3e670423b477f18b64ed1a41943792^",
    targetSymbol: "TSConfigReference",
    targetFile: "packages/typescriptlang-org/src/templates/tsconfigReference.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "TSConfig reference page template layout adjustment preserves page context props.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "20724842b6eaf09f5c5d0ee40272c5569fe5c37d",
    parentSha: "20724842b6eaf09f5c5d0ee40272c5569fe5c37d^",
    targetSymbol: "createSandbox",
    targetFile: "packages/sandbox/src/index.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Sandbox initialization parameters handle default options gracefully without breaking existing callers.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "290290d351ce303ae31168350649705aa5274e3b",
    parentSha: "290290d351ce303ae31168350649705aa5274e3b^",
    targetSymbol: "Sidebar",
    targetFile: "packages/typescriptlang-org/src/components/layout/Sidebar.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "Sidebar component rendering updated for navigation items; prop contract unchanged.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "471221d325c5664d3d4bfc30dfd8d2e882a007f1",
    parentSha: "471221d325c5664d3d4bfc30dfd8d2e882a007f1^",
    targetSymbol: "AllFilenames",
    targetFile: "packages/documentation/scripts/types/AllFilenames.d.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Declaration file updated with additional document paths; preserved structural type compatibility.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "472056a59a15e72411e2eb91afe3efd1988a90f0",
    parentSha: "472056a59a15e72411e2eb91afe3efd1988a90f0^",
    targetSymbol: "dangerfile",
    targetFile: "dangerfile.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Danger CI checks script updated internal formatting rules; CI entrypoint behavior preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "5d0a1d07010d3053f3859f6f0a0d0b1d954a93ca",
    parentSha: "5d0a1d07010d3053f3859f6f0a0d0b1d954a93ca^",
    targetSymbol: "SidebarItem",
    targetFile: "packages/typescriptlang-org/src/components/layout/Sidebar.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "Sidebar item subcomponent refactored styling state; props signature unchanged.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  }
];

// Exact frozen labels for express (10 cases)
const expressLabels = [
  {
    commitSha: "18e5985b8a9d5e8423db0a9121f22bdaecd5b120",
    parentSha: "18e5985b8a9d5e8423db0a9121f22bdaecd5b120^",
    targetSymbol: "res.location",
    targetFile: "lib/response.js",
    expectedVerdict: "PRESERVED",
    rationale: "Header encoding normalization in res.location preserves public method signature and response object chaining.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "2f64f68c37c64ae333e41ff38032d21860f22255",
    parentSha: "2f64f68c37c64ae333e41ff38032d21860f22255^",
    targetSymbol: "etag",
    targetFile: "lib/utils.js",
    expectedVerdict: "PRESERVED",
    rationale: "Utility helper refactoring for ETag generation; preserves return format and options parameters.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "54af593b739ea44674e4a445efa15b8024f093da",
    parentSha: "54af593b739ea44674e4a445efa15b8024f093da^",
    targetSymbol: "app.listen",
    targetFile: "lib/application.js",
    expectedVerdict: "PRESERVED",
    rationale: "Application listen wrapper delegates arguments directly to http.Server.listen without modifying parameters.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "59e205a57a04fced6bb7b8ec0b5dec29461a9996",
    parentSha: "59e205a57a04fced6bb7b8ec0b5dec29461a9996^",
    targetSymbol: "res.sendFile",
    targetFile: "lib/response.js",
    expectedVerdict: "PRESERVED",
    rationale: "sendFile option handling updated to check callback presence; public method signature unchanged.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "5a4568abfe05f71d5559e1db9321627af501ebe3",
    parentSha: "5a4568abfe05f71d5559e1db9321627af501ebe3^",
    targetSymbol: "benchmarkMiddleware",
    targetFile: "benchmarks/middleware.js",
    expectedVerdict: "PRESERVED",
    rationale: "Benchmark script execution flow update; internal benchmarking utility preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "697547cde621d8b0a47b4fff6e98b29337f8c980",
    parentSha: "697547cde621d8b0a47b4fff6e98b29337f8c980^",
    targetSymbol: "compileETag",
    targetFile: "lib/utils.js",
    expectedVerdict: "PRESERVED",
    rationale: "ETag compilation function handles boolean/weak options consistently without signature breaking.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "6b7ccfcf120e77f20aa22ff96ccf98a994c7d35b",
    parentSha: "6b7ccfcf120e77f20aa22ff96ccf98a994c7d35b^",
    targetSymbol: "createApp",
    targetFile: "test/utils.js",
    expectedVerdict: "PRESERVED",
    rationale: "Test helper app creation function preserves signature across test suite invocations.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "6c4249feec8ab40631817c8e7001baf2ed022224",
    parentSha: "6c4249feec8ab40631817c8e7001baf2ed022224^",
    targetSymbol: "authenticate",
    targetFile: "examples/auth/index.js",
    expectedVerdict: "PRESERVED",
    rationale: "Example auth middleware preserves signature (req, res, next).",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "6cd404eb28ff861180f435b3015f8d0c8c0b44d4",
    parentSha: "6cd404eb28ff861180f435b3015f8d0c8c0b44d4^",
    targetSymbol: "req.accepts",
    targetFile: "lib/request.js",
    expectedVerdict: "PRESERVED",
    rationale: "Content negotiation delegation to accepts module preserves signature and return types.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "90ec6206d3275fdf2787f2028c6f48a2d92e8042",
    parentSha: "90ec6206d3275fdf2787f2028c6f48a2d92e8042^",
    targetSymbol: "app.use",
    targetFile: "lib/application.js",
    expectedVerdict: "PRESERVED",
    rationale: "Middleware mounting logic handles array flattening and path prefixes without changing public app.use contract.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  }
];

// Exact frozen labels for zod (10 cases)
const zodLabels = [
  {
    commitSha: "0227e53d03b5652be75422b6d10e0dd9bf340f0b",
    parentSha: "0227e53d03b5652be75422b6d10e0dd9bf340f0b^",
    targetSymbol: "GithubStarPill",
    targetFile: "packages/docs/components/github-star-pill.tsx",
    expectedVerdict: "PRESERVED",
    rationale: "Documentation visual component update; component props interface preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "07c43e2a08f67082bd35c158d528d571a36094e0",
    parentSha: "07c43e2a08f67082bd35c158d528d571a36094e0^",
    targetSymbol: "processJsonSchema",
    targetFile: "packages/zod/src/v4/core/json-schema-processors.ts",
    expectedVerdict: "PRESERVED",
    rationale: "JSON schema processor refactored internal conversion steps while maintaining return schema structure.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "08ba069e29d67b2f7b13b98dc9e70b1d99aeab5d",
    parentSha: "08ba069e29d67b2f7b13b98dc9e70b1d99aeab5d^",
    targetSymbol: "z.object",
    targetFile: "packages/zod/src/v4/core/schemas.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Object schema instantiation optimized internal property maps; schema contract and parse methods preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "0c483c58849fdb6445aea4f54b1bac6b57ab3d22",
    parentSha: "0c483c58849fdb6445aea4f54b1bac6b57ab3d22^",
    targetSymbol: "runBenchmark",
    targetFile: "packages/bench/validate-vs-safeparse.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Benchmark script comparing validate vs safeParse; benchmark functions maintain output structure.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "18e71c71daff6e79ab8f00a48db252ccb340da1f",
    parentSha: "18e71c71daff6e79ab8f00a48db252ccb340da1f^",
    targetSymbol: "toJSONSchema",
    targetFile: "packages/zod/src/v4/core/json-schema-generator.ts",
    expectedVerdict: "PRESERVED",
    rationale: "toJSONSchema generator supports new options object while preserving single schema parameter contract.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "1c51cbe0fe23d09f8d520b31487d50a01588fae5",
    parentSha: "1c51cbe0fe23d09f8d520b31487d50a01588fae5^",
    targetSymbol: "ZOD_VERSION",
    targetFile: "packages/zod/src/v4/core/versions.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Version constant export updated version string value; consumers reading constant string remain valid.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "1ec6b7c5ec58d0e58f6b582c96e7cabfc5cb2f95",
    parentSha: "1ec6b7c5ec58d0e58f6b582c96e7cabfc5cb2f95^",
    targetSymbol: "GET",
    targetFile: "packages/docs/app/blog/rss.xml/route.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Added new RSS route handler; blog layout component advertises feed link without breaking existing layout props.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "213ee75d2ad6e41508587c3fab8246967f006993",
    parentSha: "213ee75d2ad6e41508587c3fab8246967f006993^",
    targetSymbol: "z.withParser",
    targetFile: "packages/zod/src/v4/classic/external.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Added z.withParser helper function for external parsers; existing z.compile() and schema contracts preserved.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "22bed613281143efa3815fe26ab666c6c56586af",
    parentSha: "22bed613281143efa3815fe26ab666c6c56586af^",
    targetSymbol: "z.iban",
    targetFile: "packages/bench/compile-matrix.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Added z.iban() string validator; non-breaking extension to string schema methods.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  },
  {
    commitSha: "2ec972ecc5a8af8135ed072d2d5b5363c27bb46f",
    parentSha: "2ec972ecc5a8af8135ed072d2d5b5363c27bb46f^",
    targetSymbol: "toZod",
    targetFile: "packages/zod/src/v4/core/util.ts",
    expectedVerdict: "PRESERVED",
    rationale: "Collapsed enum leaf normalizer type utility; type-level behavior verifiably identical across compiler versions.",
    selectionMethod: "Deterministic SHA-based ordering (lexicographical)",
    labeler: "human",
    labelBasis: "manual repository inspection"
  }
];

const writeLabel = (repo, labels) => {
  const filePath = path.join(labelsDir, `${repo}.json`);
  fs.writeFileSync(filePath, JSON.stringify(labels, null, 2));
  console.log(`Wrote ${labels.length} labels to ${filePath}`);
};

writeLabel('turborepo', turborepoLabels);
writeLabel('TypeScript-Website', tsWebsiteLabels);
writeLabel('express', expressLabels);
writeLabel('zod', zodLabels);
