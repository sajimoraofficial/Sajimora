import { GitObjectReader, GitRepository } from '../../packages/analysis/src/sajimora/snapshots';
import { TypeScriptProjectGraphBuilder } from '../../packages/analysis/src/sajimora/languages/typescript/production/TypeScriptProjectGraphBuilder';
import { buildSealedChangeInventory } from '../../packages/analysis/src/sajimora/languages/typescript/production/SealedChangeInventory';
import { buildSealedProjectClosure } from '../../packages/analysis/src/sajimora/languages/typescript/production/SealedProjectClosure';
import { verifySealedProjectClosure } from '../../packages/analysis/src/sajimora/languages/typescript/production/SealedProjectClosureVerifier';
import { toGenericSnapshot } from './productionCommand';

const [repositoryPath, parentSha, candidateSha] = process.argv.slice(2);
if (!repositoryPath || !parentSha || !candidateSha) {
  throw new Error('Usage: diagnoseSelectiveProjects <repository-path> <parent-sha> <candidate-sha>');
}
const started = Date.now();
const repository = new GitRepository(repositoryPath);
repository.validate();
const reader = new GitObjectReader(repository);
const parent = toGenericSnapshot(reader, parentSha);
const candidate = toGenericSnapshot(reader, candidateSha);
const parentGraph = TypeScriptProjectGraphBuilder.buildProjectGraph(parent);
const candidateGraph = TypeScriptProjectGraphBuilder.buildProjectGraph(candidate);
const inventory = buildSealedChangeInventory({ repositoryId: repository.repositoryId(),
  parentSnapshot: parent, candidateSnapshot: candidate }, parentGraph, candidateGraph);
const inspect = (snapshot: typeof parent, graph: typeof parentGraph) => {
  const proposal = buildSealedProjectClosure(snapshot, graph, inventory.changedSourcePaths);
  const checked = verifySealedProjectClosure(snapshot, graph, inventory.changedSourcePaths, proposal);
  const blockerKinds = Object.fromEntries([...new Set(checked.blockers.map(blocker => blocker.split(':')[0]))]
    .sort().map(kind => [kind, checked.blockers.filter(blocker => blocker.startsWith(`${kind}:`)).length]));
  const blockerSamples = Object.fromEntries(Object.keys(blockerKinds).map(kind =>
    [kind, checked.blockers.filter(blocker => blocker.startsWith(`${kind}:`)).slice(0, 3)]));
  return { totalProjects: graph.projects.length, proposedProjects: proposal.selectedProjectIds.length,
    status: checked.status, blockerCount: checked.blockers.length, blockerKinds, blockerSamples };
};
console.log(JSON.stringify({ changedFiles: inventory.changedFiles.length,
  changedSources: inventory.changedSourcePaths.length,
  inventoryBlockers: inventory.blockers.slice(0, 20),
  parent: inspect(parent, parentGraph), candidate: inspect(candidate, candidateGraph),
  durationMs: Date.now() - started, rssBytes: process.memoryUsage().rss }, null, 2));
