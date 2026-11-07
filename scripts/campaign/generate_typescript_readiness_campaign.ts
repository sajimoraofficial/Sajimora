import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Taxonomy = {
  schemaVersion: string;
  campaignId: string;
  caseBudget: number;
  matrixSource: string;
  dimensions: Record<string, string[]>;
  coverageContract: {
    required: string[];
    additionalMatrixItems: Array<{ id: string; name: string }>;
    p0Families: string[];
    highRiskCompositions: string[];
    failClosedFamilies: string[];
    exclusions: Array<{ combination: string; reason: string }>;
    pairwisePolicy: string;
  };
  generation: { seed: string; algorithm: string; feasibility: string; stages: string[] };
};

const DEFAULT_TAXONOMY = path.resolve('scripts/campaign/typescript_readiness_taxonomy_v1.json');
const DEFAULT_OUTPUT = path.resolve('artifacts/typescript_readiness_design_v1.json');

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function installedTypeScriptVersion(): string {
  return require('typescript').version as string;
}

function seededRandom(seedText: string): () => number {
  let state = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sortedPairs(dimensions: Record<string, string[]>) {
  const names = Object.keys(dimensions).sort();
  const required = new Set<string>();
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      for (const left of dimensions[names[a]]) {
        for (const right of dimensions[names[b]]) {
          required.add(`${names[a]}=${left}&${names[b]}=${right}`);
        }
      }
    }
  }
  return required;
}

function readMatrixItems(matrixPath: string, additional: Array<{ id: string; name: string }>) {
  const lines = fs.readFileSync(matrixPath, 'utf8').split(/\r?\n/);
  const items: Array<{ id: string; name: string; parentId: string | null }> = [];
  let currentId: string | null = null;
  let variantIndex = 0;
  for (const line of lines) {
    const heading = line.match(/^###\s+([A-Z]{1,2}\d+)\.\s+(.+)\s*$/);
    if (heading) {
      currentId = heading[1];
      variantIndex = 0;
      items.push({ id: currentId, name: heading[2].trim(), parentId: null });
      continue;
    }
    if (/^#{1,2}\s/.test(line)) currentId = null;
    const bullet = currentId ? line.match(/^\s{0,8}-\s+(.+?)\s*$/) : null;
    if (bullet) {
      variantIndex++;
      items.push({ id: `${currentId}.v${String(variantIndex).padStart(2, '0')}`, name: bullet[1].trim(), parentId: currentId });
    }
  }
  items.push(...additional.map(item => ({ ...item, parentId: item.id.split('.')[0] })));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate taxonomy item id: ${item.id}`);
    seen.add(item.id);
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function generateDesign(taxonomy: Taxonomy, contractPath: string, matrixPath: string, count = taxonomy.caseBudget) {
  const dimensionNames = Object.keys(taxonomy.dimensions).sort();
  const taxonomyItems = readMatrixItems(matrixPath, taxonomy.coverageContract.additionalMatrixItems);
  const random = seededRandom(taxonomy.generation.seed);
  const values = Object.fromEntries(dimensionNames.map(name => [name, taxonomy.dimensions[name]]));
  const pairSeeds: Array<{ left: string; leftValue: string; right: string; rightValue: string }> = [];
  for (let a = 0; a < dimensionNames.length; a++) {
    for (let b = a + 1; b < dimensionNames.length; b++) {
      const left = dimensionNames[a];
      const right = dimensionNames[b];
      for (const leftValue of values[left]) for (const rightValue of values[right]) {
        pairSeeds.push({ left, leftValue, right, rightValue });
      }
    }
  }
  if (pairSeeds.length > count) throw new Error(`coverage contract needs at least ${pairSeeds.length} cases, budget is ${count}`);
  const cases = Array.from({ length: count }, (_, index) => {
    const assignment: Record<string, string> = {};
    for (const name of dimensionNames) {
      const options = values[name];
      assignment[name] = options[Math.floor(random() * options.length)];
    }
    // Reserve one deterministic row for each cross-dimension value pair. Remaining
    // rows diversify higher-order compositions without sacrificing pair coverage.
    if (index < pairSeeds.length) {
      const seed = pairSeeds[index];
      assignment[seed.left] = seed.leftValue;
      assignment[seed.right] = seed.rightValue;
    }
    const caseId = `TSR-${String(index + 1).padStart(5, '0')}`;
    const failClosedFamily = index < taxonomy.coverageContract.failClosedFamilies.length
      ? taxonomy.coverageContract.failClosedFamilies[index]
      : null;
    const design = {
      caseId,
      caseKind: failClosedFamily ? 'FAIL_CLOSED_DESIGN' : 'COVERAGE_DESIGN',
      taxonomyItem: taxonomyItems[index % taxonomyItems.length],
      assignment,
      failClosedFamily,
      // A design row is not a sealed executable case until source/config bytes and oracle evidence exist.
      materialization: 'NOT_MATERIALIZED',
      oracle: { source: null, expectedVerdict: null, unknownClassification: null, evidenceRef: null },
      executionEnvelope: {
        typescriptVersion: null,
        lockfileSha256: null,
        effectiveCompilerOptions: null,
        moduleResolution: null,
        projectGraph: null,
        packageConditions: null,
        generatorVersion: taxonomy.schemaVersion,
        fixtureHashes: null,
        timeBudgetMs: null,
        memoryBudgetBytes: null
      }
    };
    return { ...design, designSha256: stableHash(design) };
  });

  const requiredPairs = sortedPairs(taxonomy.dimensions);
  const observedPairs = new Set<string>();
  for (const scenario of cases) {
    const assigned = scenario.assignment;
    for (let a = 0; a < dimensionNames.length; a++) {
      for (let b = a + 1; b < dimensionNames.length; b++) {
        const left = dimensionNames[a];
        const right = dimensionNames[b];
        observedPairs.add(`${left}=${assigned[left]}&${right}=${assigned[right]}`);
      }
    }
  }
  const uncoveredPairs = [...requiredPairs].filter(pair => !observedPairs.has(pair)).sort();
  const observedTaxonomyValues = Object.fromEntries(dimensionNames.map(name => [name,
    [...new Set(cases.map(scenario => scenario.assignment[name]))].sort()]));
  const missingValues = Object.fromEntries(dimensionNames.map(name => [name,
    values[name].filter(value => !observedTaxonomyValues[name].includes(value))]));
  const countsByComposition = Object.fromEntries(taxonomy.coverageContract.highRiskCompositions.map(composition => [composition,
    cases.filter(scenario => scenario.assignment.composition === composition).length]));
  const observedTaxonomyItems = new Set(cases.map(scenario => scenario.taxonomyItem.id));
  const missingTaxonomyItems = taxonomyItems.filter(item => !observedTaxonomyItems.has(item.id)).map(item => item.id);

  return {
    schemaVersion: 'SAJIMORA_TYPESCRIPT_READINESS_DESIGN_V1',
    campaignId: taxonomy.campaignId,
    status: 'DESIGN_ONLY_FIXTURES_AND_ORACLES_REQUIRED',
    contractSha256: hashFile(contractPath),
    matrixSha256: hashFile(matrixPath),
    generator: { version: taxonomy.schemaVersion, seed: taxonomy.generation.seed, algorithm: taxonomy.generation.algorithm },
    campaignEnvironment: {
      typescriptVersion: installedTypeScriptVersion(),
      lockfileSha256: hashFile(path.resolve('package-lock.json')),
      generatorVersion: taxonomy.schemaVersion,
      fixtureState: 'NOT_MATERIALIZED',
      perCaseCompilerOptionsResolutionProjectGraphPackageConditionsAndBudgets: 'REQUIRED_BEFORE_EXECUTION'
    },
    coverage: {
      requiredPairCount: requiredPairs.size,
      observedPairCount: requiredPairs.size - uncoveredPairs.length,
      uncoveredPairs,
      missingValues,
      taxonomyItemCount: taxonomyItems.length,
      representedTaxonomyItemCount: taxonomyItems.length - missingTaxonomyItems.length,
      missingTaxonomyItems,
      highRiskCompositionCounts: countsByComposition,
      exclusions: taxonomy.coverageContract.exclusions,
      p0Families: taxonomy.coverageContract.p0Families,
      p0CertificationStatus: 'NOT_ASSESSED_FIXTURES_AND_VERDICTS_NOT_MATERIALIZED'
    },
    execution: { plannedCaseCount: cases.length, materializedCaseCount: 0, oracleCompleteCaseCount: 0 },
    cases
  };
}

export function generateTypeScriptReadinessDesign(taxonomyPath = DEFAULT_TAXONOMY, outputPath = DEFAULT_OUTPUT, count?: number) {
  const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8')) as Taxonomy;
  const matrixPath = path.resolve(path.dirname(taxonomyPath), taxonomy.matrixSource.replace(/^scripts\/campaign\//, ''));
  const result = generateDesign(taxonomy, taxonomyPath, matrixPath, count ?? taxonomy.caseBudget);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module || /generate_typescript_readiness_campaign\.ts$/.test(process.argv[1] ?? '')) {
  const count = process.argv[2] ? Number(process.argv[2]) : undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new Error('case count must be a positive integer');
  const output = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT;
  const result = generateTypeScriptReadinessDesign(DEFAULT_TAXONOMY, output, count);
  console.log(JSON.stringify({ output, plannedCaseCount: result.execution.plannedCaseCount,
    status: result.status, requiredPairCount: result.coverage.requiredPairCount,
    uncoveredPairCount: result.coverage.uncoveredPairs.length,
    taxonomyItemCount: result.coverage.taxonomyItemCount,
    missingTaxonomyItems: result.coverage.missingTaxonomyItems.length,
    missingValues: result.coverage.missingValues }, null, 2));
  if (result.coverage.uncoveredPairs.length || result.coverage.missingTaxonomyItems.length || Object.values(result.coverage.missingValues).some(items => items.length)) process.exitCode = 1;
}
