import { ProofObligation } from '../types/obligation';
import { ProofResult } from '../types/verdict';

export type LanguageCapability =
  | 'DECLARATION_DIFF'
  | 'VALUE_REFERENCE_DISCOVERY'
  | 'TYPE_REFERENCE_DISCOVERY'
  | 'RE_EXPORT_DISCOVERY'
  | 'INHERITANCE_DISCOVERY'
  | 'OVERRIDE_DISCOVERY'
  | 'IMPLEMENTATION_DISCOVERY'
  | 'SOURCE_COMPATIBILITY';

export interface LanguageAdapterDescriptor {
  id: string;
  version: string;
  capabilities: readonly LanguageCapability[];
}

export interface LanguageContractIR<TPayload = unknown> {
  schemaVersion: 'SAJIMORA_CONTRACT_IR_V1';
  languageId: string;
  adapterId: string;
  adapterVersion: string;
  payloadSchemaVersion: string;
  declarationKind: string;
  display: string;
  payload: TPayload;
}

export interface AdapterAnalysisInput {
  snapshotRoot: string;
  obligations: ProofObligation[];
}

export interface AdapterAnalysisOutput {
  results: Array<{ obligation: ProofObligation; proof: ProofResult }>;
}

export interface AdapterDetectionInput {
  trackedFiles: readonly string[];
  readTextFile(path: string): string | undefined;
}

export interface AdapterSupport {
  status: 'SUPPORTED' | 'UNSUPPORTED' | 'AMBIGUOUS';
  evidence: AdapterSelectionEvidence[];
  unsupportedBoundary?: string;
}

export interface LanguageAnalysisAdapter {
  readonly descriptor: LanguageAdapterDescriptor;
  canAnalyze(input: AdapterDetectionInput): AdapterSupport;
  analyze(input: AdapterAnalysisInput): AdapterAnalysisOutput;
  toolchain(input: AdapterDetectionInput): ToolchainIdentity;
}

export interface AdapterSelectionEvidence {
  kind: 'CONFIGURATION' | 'SOURCE_EXTENSION' | 'PACKAGE_METADATA' | 'CONFLICT';
  value: string;
}

export interface AdapterSelectionResult {
  mode: 'auto' | 'explicit';
  adapter: LanguageAnalysisAdapter;
  evidence: AdapterSelectionEvidence[];
}

export interface ToolchainIdentity {
  compiler: { name: string; version: string };
  repositoryDeclaredVersion: string | null;
  mismatch: 'MATCH' | 'MISMATCH' | 'UNDETERMINED';
}
