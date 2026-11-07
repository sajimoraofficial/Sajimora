import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadPinnedVersions,
  loadTemporalExpectations,
  inspectTemporalWireGateStatus,
  lookupTemporalWireExpectation,
  PinnedVersionsDocument,
  TemporalExpectationsDocument,
} from '../../../src/sajimora/cross-language/JacksonTemporalInspection';

describe('Jackson Temporal Fixtures and Inspection Utility', () => {
  const fixturesDir = path.resolve(__dirname, '../../../../../tests/fixtures/jackson_temporal');

  it('verifies fixture files exist on disk', () => {
    expect(fs.existsSync(path.join(fixturesDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(fixturesDir, 'pinned_versions.json'))).toBe(true);
    expect(fs.existsSync(path.join(fixturesDir, 'temporal_wire_expectations.json'))).toBe(true);
  });

  it('validates pinned_versions.json schema and initial Gate G3 blocker state', () => {
    const pinned = loadPinnedVersions();
    expect(pinned.inspectionDate).toBe('2026-10-17');
    expect(pinned.versionResolutionStatus).toBe('PENDING_CONFIRMATION');
    expect(pinned.blockerForGateG3).toBe(true);
    expect(pinned.actionRequired).toContain('Confirm the Jackson versions');
    expect(pinned.foundVersions.length).toBeGreaterThan(0);

    const fineractBomEntry = pinned.foundVersions.find(v => v.source.includes('org.apache.fineract.dependencies.gradle'));
    expect(fineractBomEntry).toBeDefined();
    expect(fineractBomEntry?.jacksonDatabind).toContain('2.22.3');
  });

  it('validates temporal_wire_expectations.json configurations and entries', () => {
    const expectations = loadTemporalExpectations();
    expect(expectations.spec).toBe('SAJIMORA_JACKSON_TEMPORAL_V1');
    expect(expectations.validationStatus).toBe('NOT_VALIDATED');
    expect(expectations.configurations).toHaveLength(2);

    const disabledConfig = expectations.configurations.find(c => c.configKey === 'timestamps_disabled');
    expect(disabledConfig).toBeDefined();
    expect(disabledConfig?.entries).toHaveLength(6);
    for (const entry of disabledConfig!.entries) {
      expect((entry.wireType as { kind: string; scalar: string }).kind).toBe('PRIMITIVE');
      expect((entry.wireType as { kind: string; scalar: string }).scalar).toBe('string');
    }

    const enabledConfig = expectations.configurations.find(c => c.configKey === 'timestamps_enabled');
    expect(enabledConfig).toBeDefined();
    expect(enabledConfig?.requiresPinnedVersionValidation).toBe(true);
    expect(enabledConfig?.entries).toHaveLength(7);

    const periodEntry = enabledConfig?.entries.find(e => e.javaType === 'java.time.Period');
    expect(periodEntry?.wireType).toBe('UNRESOLVED_JACKSON_CONFIG');

    const instantEntry = enabledConfig?.entries.find(e => e.javaType === 'java.time.Instant');
    expect((instantEntry?.wireType as { kind: string; scalar: string }).scalar).toBe('number');

    const localDateEntry = enabledConfig?.entries.find(e => e.javaType === 'java.time.LocalDate');
    expect((localDateEntry?.wireType as { kind: string }).kind).toBe('ARRAY');
  });

  it('inspectTemporalWireGateStatus fails closed when unconfirmed or not validated', () => {
    const status = inspectTemporalWireGateStatus();
    expect(status.canProceedWithGateG3).toBe(false);
    expect(status.blockerCode).toBe('UNRESOLVED_JACKSON_CONFIG');
    expect(status.versionResolutionStatus).toBe('PENDING_CONFIRMATION');
    expect(status.message).toContain('Gate G3 blocker active');
  });

  it('lookupTemporalWireExpectation retrieves expected wire entries', () => {
    const instantExpectation = lookupTemporalWireExpectation('java.time.Instant', 'timestamps_disabled');
    expect(instantExpectation?.example).toBe('2026-10-17T12:00:00Z');

    const dateExpectation = lookupTemporalWireExpectation('java.util.Date', 'timestamps_enabled');
    expect(dateExpectation?.example).toBe(1761436934000);
  });

  it('inspectTemporalWireGateStatus allows proceeding only when fully confirmed and validated', () => {
    const mockPinned: PinnedVersionsDocument = {
      inspectionDate: '2026-10-17',
      note: 'Mock',
      foundVersions: [],
      versionResolutionStatus: 'CONFIRMED',
      blockerForGateG3: false,
      actionRequired: 'None',
    };
    const mockExpectations: TemporalExpectationsDocument = {
      spec: 'SAJIMORA_JACKSON_TEMPORAL_V1',
      note: 'Mock',
      validationStatus: 'VALIDATED',
      configurations: [],
    };

    const status = inspectTemporalWireGateStatus(mockPinned, mockExpectations);
    expect(status.canProceedWithGateG3).toBe(true);
    expect(status.blockerCode).toBeUndefined();
  });
});
