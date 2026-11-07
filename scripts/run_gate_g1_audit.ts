import * as fs from 'fs';
import * as path from 'path';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { parseJaxRsMethod } from '../packages/analysis/src/sajimora/cross-language/JaxRsMapping';

const parser = new Parser();
parser.setLanguage(Java);

function getFiles(d: string): string[] {
  let res: string[] = [];
  for (const item of fs.readdirSync(d)) {
    const full = path.join(d, item);
    if (fs.statSync(full).isDirectory()) res = res.concat(getFiles(full));
    else if (full.endsWith('.java')) res.push(full);
  }
  return res;
}

const dir = 'artifacts/production-large-repo/holdout/fineract';
const allFiles = getFiles(dir);
const jaxRsRegex = /@(?:(?:javax|jakarta)\.ws\.rs\.)?(Path|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
const targetFiles = allFiles.filter(f => jaxRsRegex.test(fs.readFileSync(f, 'utf8')));

console.log(`Processing ${targetFiles.length} JAX-RS files out of ${allFiles.length} total Java files...`);

let candidates: any[] = [];
let supportedCount = 0;
let explicitlyBlockedCount = 0;
let unresolvedCount = 0;
let blockerCounts: Record<string, number> = {};

for (let i = 0; i < targetFiles.length; i++) {
  const f = targetFiles[i];
  const content = fs.readFileSync(f, 'utf8');
  let tree: any;
  try {
    tree = parser.parse(content);
  } catch (e) {
    continue;
  }

  function walk(node: any, classAnnotations: string = '') {
    let currentClassAnnotations = classAnnotations;
    if (['class_declaration', 'interface_declaration', 'record_declaration'].includes(node.type)) {
      const modifiers = node.namedChildren.find((c: any) => c.type === 'modifiers');
      currentClassAnnotations = modifiers ? modifiers.text : '';
    }
    if (node.type === 'method_declaration') {
      const methodText = node.text;
      const candidate = parseJaxRsMethod(methodText, currentClassAnnotations);
      if (candidate) {
        candidates.push({ file: f, candidate });
        if (candidate.classification === 'SUPPORTED') supportedCount++;
        else if (candidate.classification === 'EXPLICITLY_BLOCKED') explicitlyBlockedCount++;
        else if (candidate.classification === 'UNRESOLVED') unresolvedCount++;

        for (const b of candidate.blockers) {
          blockerCounts[b.code] = (blockerCounts[b.code] || 0) + 1;
        }
      }
    }
    for (const child of node.namedChildren) {
      walk(child, currentClassAnnotations);
    }
  }

  walk(tree.rootNode);
}

const report = {
  holdoutRepository: 'apache/fineract',
  totalJavaFilesScanned: allFiles.length,
  jaxRsJavaFilesFound: targetFiles.length,
  totalCandidatesDiscovered: candidates.length,
  supportedCount,
  supportedPct: ((supportedCount / candidates.length) * 100).toFixed(2) + '%',
  explicitlyBlockedCount,
  explicitlyBlockedPct: ((explicitlyBlockedCount / candidates.length) * 100).toFixed(2) + '%',
  unresolvedCount,
  unresolvedPct: ((unresolvedCount / candidates.length) * 100).toFixed(2) + '%',
  blockerBreakdown: blockerCounts
};

fs.writeFileSync(path.join(dir, 'jaxrs_gate_g1_accounting_report.json'), JSON.stringify(report, null, 2));
console.log('--- GATE G1 FINERACT AUDIT REPORT ---');
console.log(JSON.stringify(report, null, 2));
