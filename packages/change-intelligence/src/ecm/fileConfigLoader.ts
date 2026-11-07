/**
 * SAJIMORA V32 — Local Repository ECM File Config Loader
 * Subordinate to sajimora_v32_foundation_spec.md §8 (OQ-2).
 *
 * Reads .sajimora-ecm.json from repository root if present.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RawEcmParams } from './validator';

export function loadRepositoryEcmConfig(workspaceRoot: string): Partial<RawEcmParams> | null {
  try {
    const configPath = path.join(workspaceRoot, '.sajimora-ecm.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const rawContent = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawContent);

    return {
      expectedFiles: parsed.expectedFiles || [],
      expectedSymbols: parsed.expectedSymbols || [],
      expectedEdges: parsed.expectedEdges || [],
      expectedBehavioralObligations: parsed.expectedBehavioralObligations || [],
      expectedInvariantTransitions: parsed.expectedInvariantTransitions || [],
      changeBoundary: parsed.changeBoundary || null,
      ecmSource: 'STRUCTURED_INPUT',
    };
  } catch (err) {
    return null;
  }
}
