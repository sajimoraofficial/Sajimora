/**
 * @file coverage_query_registry_v1.ts
 * Master Registry for Sajimora TypeScript Semantic Coverage Specification v1 (911 Queries)
 * 
 * Aggregates all 6 tiers:
 *   Tier 1: Core Type Safety & OOP       (380 queries)
 *   Tier 2: Resolution & Topology        (225 queries)
 *   Tier 3: Type System Depth            (125 queries)
 *   Tier 4: Framework & Modern TS         (90 queries)
 *   Tier 5: Behavioral & Dynamic          (70 queries)
 *   Tier 6: Edge Cases & Exotic           (21 queries)
 *   Total:                               (911 queries)
 */

import { CoverageQuery } from './coverage_types';
import { getTier1Queries } from './coverage_tier1_queries';
import { getTier2Queries } from './coverage_tier2_queries';
import { getTier3Queries } from './coverage_tier3_queries';
import { getTier4Queries } from './coverage_tier4_queries';
import { getTier5Queries } from './coverage_tier5_queries';
import { getTier6Queries } from './coverage_tier6_queries';

export * from './coverage_types';

let cachedAllQueries: CoverageQuery[] | null = null;

export function getAllCoverageQueries(): CoverageQuery[] {
  if (cachedAllQueries) {
    return cachedAllQueries;
  }

  const t1 = getTier1Queries();
  const t2 = getTier2Queries();
  const t3 = getTier3Queries();
  const t4 = getTier4Queries();
  const t5 = getTier5Queries();
  const t6 = getTier6Queries();

  const rawAll = [...t1, ...t2, ...t3, ...t4, ...t5, ...t6];

  if (rawAll.length !== 911) {
    console.warn(`[CoverageRegistry] Query count mismatch: expected 911, found ${rawAll.length} (T1:${t1.length}, T2:${t2.length}, T3:${t3.length}, T4:${t4.length}, T5:${t5.length}, T6:${t6.length})`);
  }

  // RC001: Byte-identical parent and candidate snapshots are invariance controls.
  // By mathematical definition of backward compatibility, zero semantic change
  // means no obligations exist, yielding NOT_APPLICABLE.
  const all = rawAll.map(q => {
    const parentEntries = Object.entries(q.parentFiles || {}).sort(([a], [b]) => a.localeCompare(b));
    const candidateEntries = Object.entries(q.candidateFiles || {}).sort(([a], [b]) => a.localeCompare(b));
    const isIdentical = parentEntries.length === candidateEntries.length &&
      parentEntries.every(([k, v], i) => k === candidateEntries[i][0] && v === candidateEntries[i][1]);

    if (isIdentical && q.expectedVerdict === 'PRESERVED') {
      return { ...q, expectedVerdict: 'NOT_APPLICABLE' as const };
    }
    return q;
  });

  cachedAllQueries = all;
  return all;
}

export function getQueriesByTier(tier: number): CoverageQuery[] {
  return getAllCoverageQueries().filter(q => q.tier === tier);
}

export function getQueriesByLevel(level: string): CoverageQuery[] {
  return getAllCoverageQueries().filter(q => q.level === level);
}

export function getQueriesByFamily(family: string): CoverageQuery[] {
  return getAllCoverageQueries().filter(q => q.family === family);
}

export function getQueryById(id: string): CoverageQuery | undefined {
  return getAllCoverageQueries().find(q => q.id === id);
}

export function getCoverageStats() {
  const all = getAllCoverageQueries();
  const tierCounts: Record<number, number> = {};
  const levelCounts: Record<string, number> = {};
  const verdictCounts: Record<string, number> = {};

  for (const q of all) {
    tierCounts[q.tier] = (tierCounts[q.tier] || 0) + 1;
    levelCounts[q.level] = (levelCounts[q.level] || 0) + 1;
    verdictCounts[q.expectedVerdict] = (verdictCounts[q.expectedVerdict] || 0) + 1;
  }

  return {
    total: all.length,
    tierCounts,
    levelCounts,
    verdictCounts
  };
}
