import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FoundVersionEntry {
  source: string;
  jacksonDatabind: string;
  jacksonDatatypeJsr310: string;
  jacksonCore: string;
}

export interface PinnedVersionsDocument {
  inspectionDate: string;
  note: string;
  foundVersions: FoundVersionEntry[];
  versionResolutionStatus: 'PENDING_CONFIRMATION' | 'CONFIRMED';
  blockerForGateG3: boolean;
  actionRequired: string;
}

export interface TemporalExpectationEntry {
  javaType: string;
  wireType: unknown;
  example: unknown;
  notes?: string;
  requiresValidation?: boolean;
}

export interface TemporalConfiguration {
  configDescription: string;
  configKey: string;
  requiresPinnedVersionValidation?: boolean;
  entries: TemporalExpectationEntry[];
}

export interface TemporalExpectationsDocument {
  spec: string;
  note: string;
  validationStatus: 'NOT_VALIDATED' | 'VALIDATED';
  configurations: TemporalConfiguration[];
}

export interface GateG3InspectionResult {
  canProceedWithGateG3: boolean;
  versionResolutionStatus: string;
  validationStatus: string;
  blockerCode?: string;
  message?: string;
}

const DEFAULT_FIXTURES_DIR = path.resolve(__dirname, '../../../../../tests/fixtures/jackson_temporal');

/**
 * Load and parse pinned_versions.json
 */
export function loadPinnedVersions(filePath?: string): PinnedVersionsDocument {
  const targetPath = filePath ?? path.join(DEFAULT_FIXTURES_DIR, 'pinned_versions.json');
  const raw = fs.readFileSync(targetPath, 'utf8');
  return JSON.parse(raw) as PinnedVersionsDocument;
}

/**
 * Load and parse temporal_wire_expectations.json
 */
export function loadTemporalExpectations(filePath?: string): TemporalExpectationsDocument {
  const targetPath = filePath ?? path.join(DEFAULT_FIXTURES_DIR, 'temporal_wire_expectations.json');
  const raw = fs.readFileSync(targetPath, 'utf8');
  return JSON.parse(raw) as TemporalExpectationsDocument;
}

/**
 * Inspect whether Jackson temporal wire implementation can proceed under Gate G3 and Decision D9.
 * Fail-closed: returns canProceedWithGateG3 = false if versions are not CONFIRMED or expectations are NOT_VALIDATED.
 */
export function inspectTemporalWireGateStatus(
  pinnedDoc?: PinnedVersionsDocument,
  expectationsDoc?: TemporalExpectationsDocument
): GateG3InspectionResult {
  const pinned = pinnedDoc ?? loadPinnedVersions();
  const expectations = expectationsDoc ?? loadTemporalExpectations();

  if (pinned.versionResolutionStatus !== 'CONFIRMED' || pinned.blockerForGateG3) {
    return {
      canProceedWithGateG3: false,
      versionResolutionStatus: pinned.versionResolutionStatus,
      validationStatus: expectations.validationStatus,
      blockerCode: 'UNRESOLVED_JACKSON_CONFIG',
      message: `Gate G3 blocker active: Jackson version resolution status is ${pinned.versionResolutionStatus}. Must be CONFIRMED before implementing temporal wire semantics.`,
    };
  }

  if (expectations.validationStatus !== 'VALIDATED') {
    return {
      canProceedWithGateG3: false,
      versionResolutionStatus: pinned.versionResolutionStatus,
      validationStatus: expectations.validationStatus,
      blockerCode: 'UNRESOLVED_JACKSON_CONFIG',
      message: `Gate G3 blocker active: Temporal expectations status is ${expectations.validationStatus}. Golden validation against pinned runtime is required.`,
    };
  }

  return {
    canProceedWithGateG3: true,
    versionResolutionStatus: pinned.versionResolutionStatus,
    validationStatus: expectations.validationStatus,
  };
}

/**
 * Look up expected wire shape for a given Java temporal type and configuration key.
 */
export function lookupTemporalWireExpectation(
  javaType: string,
  configKey: 'timestamps_disabled' | 'timestamps_enabled',
  expectationsDoc?: TemporalExpectationsDocument
): TemporalExpectationEntry | undefined {
  const doc = expectationsDoc ?? loadTemporalExpectations();
  const config = doc.configurations.find(c => c.configKey === configKey);
  if (!config) return undefined;
  return config.entries.find(e => e.javaType === javaType);
}
