/**
 * @file AsymmetricProjectMapper.ts
 * Computes asymmetric project identity mappings across parent and candidate project graphs.
 * 
 * Accurately tracks:
 * - Matched projects
 * - Added projects
 * - Deleted projects
 * - Project moves / directory renames
 */

import {
  GenericProjectGraph,
  GenericProject,
  AsymmetricProjectMapping
} from '../../../../../../core/src/sajimora/verification';

export class AsymmetricProjectMapper {
  public static mapGraphs(
    parentGraph: GenericProjectGraph,
    candidateGraph: GenericProjectGraph
  ): AsymmetricProjectMapping {
    const matched: Array<{ parentProjectId: string; candidateProjectId: string }> = [];
    const matchedCandidateIds = new Set<string>();
    const matchedParentIds = new Set<string>();

    // Pass 1: Direct root directory / config file match
    for (const parentProj of parentGraph.projects) {
      const directMatch = candidateGraph.projects.find(cp =>
        cp.rootDirectory === parentProj.rootDirectory ||
        (cp.configFile && parentProj.configFile && cp.configFile === parentProj.configFile)
      );

      if (directMatch) {
        matched.push({
          parentProjectId: parentProj.projectId,
          candidateProjectId: directMatch.projectId
        });
        matchedParentIds.add(parentProj.projectId);
        matchedCandidateIds.add(directMatch.projectId);
      }
    }

    // Pass 2: Detect project moves/renames by matching file sets or configuration options
    for (const parentProj of parentGraph.projects) {
      if (matchedParentIds.has(parentProj.projectId)) continue;

      const parentFileBasenames = new Set(parentProj.sourceFiles.map(f => f.split('/').pop()));

      const moveCandidate = candidateGraph.projects.find(cp => {
        if (matchedCandidateIds.has(cp.projectId)) return false;
        const cpFileBasenames = new Set(cp.sourceFiles.map(f => f.split('/').pop()));
        let overlap = 0;
        for (const b of parentFileBasenames) {
          if (cpFileBasenames.has(b)) overlap++;
        }
        return overlap > 0 && overlap >= Math.min(parentFileBasenames.size, cpFileBasenames.size);
      });

      if (moveCandidate) {
        matched.push({
          parentProjectId: parentProj.projectId,
          candidateProjectId: moveCandidate.projectId
        });
        matchedParentIds.add(parentProj.projectId);
        matchedCandidateIds.add(moveCandidate.projectId);
      }
    }

    const added: GenericProject[] = candidateGraph.projects.filter(
      cp => !matchedCandidateIds.has(cp.projectId)
    );

    const deleted: GenericProject[] = parentGraph.projects.filter(
      pp => !matchedParentIds.has(pp.projectId)
    );

    return {
      matched,
      added,
      deleted
    };
  }
}
