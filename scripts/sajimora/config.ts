import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArtifactTrustPolicy } from '@sajimora/analysis';

export interface SajimoraConfig {
  version?: '1';
  contracts?: {
    frontend?: string;
    backend?: string;
  };
  admission?: ArtifactTrustPolicy & {
    allowLocalUnsigned?: boolean;
  };
  hooks?: {
    prePush?: {
      enabled?: boolean;
      mode?: 'in-repo' | 'cross-language';
    };
  };
}

export function loadSajimoraConfig(repoDir: string, explicitPath?: string): SajimoraConfig | null {
  const configPath = explicitPath ? path.resolve(repoDir, explicitPath) : path.join(repoDir, 'sajimora.config.json');
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    if (explicitPath) {
      throw new Error(`Specified configuration file does not exist: ${explicitPath}`);
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as SajimoraConfig;
  } catch (err) {
    throw new Error(`Failed to parse sajimora configuration at ${configPath}: ${(err as Error).message}`);
  }
}
