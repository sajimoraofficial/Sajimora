import { ToolchainIdentity } from '../adapters/types';

export interface RevisionIdentity {
  repositoryId: string;
  commitSha: string;
  parentSelection?: { strategy: 'EXPLICIT_PARENT'; selectedParentSha: string };
}

export interface ProjectIdentity {
  projectId: string;
  configFile: string | null;
  rootFiles: string[];
  references: string[];
}

export interface ProgramDiagnosticEvidence {
  category: 'ERROR' | 'WARNING' | 'SUGGESTION' | 'MESSAGE';
  code: number;
  file: string | null;
  line: number | null;
  character: number | null;
  message: string;
}

export interface SnapshotAnalysisUniverse {
  revision: RevisionIdentity;
  languageId: string;
  adapterId: string;
  adapterVersion: string;
  toolchain: ToolchainIdentity;
  projects: ProjectIdentity[];
  includedFiles: string[];
  excludedFiles: Array<{ file: string; reason: string }>;
  parseFailures: ProgramDiagnosticEvidence[];
  unreadableFiles: string[];
  dependencyProvenance: Array<{ file: string; origin: 'REPOSITORY_SOURCE' | 'TYPESCRIPT_BUNDLED_LIB' | 'EXTERNAL_DECLARATION' }>;
  discoveryStatus: 'DISCOVERY_COMPLETE' | 'DISCOVERY_INCOMPLETE';
  dependencyStore?: { lockfile: string; lockfileHash: string; status: 'LOCKFILE_MATCHED_READ_ONLY' };
}

export interface ConfigurationChange {
  projectId: string;
  option: string;
  parent: unknown;
  candidate: unknown;
  supported: boolean;
}

export interface ConfigurationRelation {
  status: 'EQUIVALENT' | 'CHANGED_SUPPORTED' | 'CHANGED_UNSUPPORTED' | 'UNRESOLVED';
  changes: ConfigurationChange[];
}

export interface DualAnalysisUniverse {
  parent: SnapshotAnalysisUniverse;
  candidate: SnapshotAnalysisUniverse;
  configurationRelation: ConfigurationRelation;
}
