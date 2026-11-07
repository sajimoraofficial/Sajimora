/**
 * envelope_canonical.test.ts
 *
 * Verifies canonicalization, sign payload construction, Ed25519 signature
 * validation, and manifest schema verification against Envelope V2 test vectors.
 *
 * All negative vectors assert that the declared expectedVerificationResult
 * matches the exact blocker code emitted by the validator.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export type ManifestVerificationResult =
  | 'VALID'
  | 'CRYPTO_UNKNOWN_KEY'
  | 'CRYPTO_VERIFICATION_FAILED'
  | 'MANIFEST_VALIDATION_FAILED';

export interface EnvelopeV2TestVector {
  description: string;
  publicKeyId: string;
  publicKeyDerHex: string;
  signPayloadHex: string;
  canonicalManifestHex: string;
  manifestDigestHex: string;
  signedManifest: Record<string, any>;
  expectedVerificationResult: ManifestVerificationResult;
}

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) Canonicalization
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys
    .filter(k => obj[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',') + '}';
}

// ---------------------------------------------------------------------------
// Sign payload builder
// ---------------------------------------------------------------------------

export function buildSignPayload(
  repoId: string,
  revision: string,
  envelopeVersion: string,
  manifestDigestHex: string
): Buffer {
  const repoBytes = Buffer.from(repoId, 'utf8');
  const revBytes = Buffer.from(revision, 'utf8');
  const verBytes = Buffer.from(envelopeVersion, 'utf8');

  return Buffer.concat([
    Buffer.from('SAJIMORA-ED25519-V2-MANIFEST\n', 'utf8'),
    Buffer.from(`${repoBytes.length}:`, 'utf8'),
    repoBytes,
    Buffer.from('\n', 'utf8'),
    Buffer.from(`${revBytes.length}:`, 'utf8'),
    revBytes,
    Buffer.from('\n', 'utf8'),
    Buffer.from(`${verBytes.length}:`, 'utf8'),
    verBytes,
    Buffer.from('\n', 'utf8'),
    Buffer.from(`sha256:${manifestDigestHex}\n`, 'utf8'),
  ]);
}

// ---------------------------------------------------------------------------
// Validator implementation
// ---------------------------------------------------------------------------

/**
 * Validates a signed manifest against a set of trusted public keys.
 *
 * Checks (in order):
 * 1. signature.publicKeyId exists in trustedKeys → else return 'CRYPTO_UNKNOWN_KEY'
 * 2. UnsignedManifest (without signature) → compute canonical bytes → compute sign_payload → verify Ed25519 → else return 'CRYPTO_VERIFICATION_FAILED'
 * 3. Shard path format validation (no '..', no '/') → else return 'MANIFEST_VALIDATION_FAILED'
 * 4. No duplicate shard paths → else return 'MANIFEST_VALIDATION_FAILED'
 * 5. shard.sha256 must be 64 lowercase hex chars → else return 'MANIFEST_VALIDATION_FAILED'
 * 6. shard.byteLength must be 1 to 20971520 → else return 'MANIFEST_VALIDATION_FAILED'
 * 7. shard count ≤ 5 → else return 'MANIFEST_VALIDATION_FAILED'
 * → return 'VALID' if all pass
 */
export function validateManifest(
  manifest: any,
  trustedKeys: Map<string, crypto.KeyObject | string | Buffer> | Record<string, crypto.KeyObject | string | Buffer>,
  expectedRepoId?: string,
  expectedRevision?: string
): ManifestVerificationResult {
  if (!manifest || typeof manifest !== 'object') {
    return 'MANIFEST_VALIDATION_FAILED';
  }

  // 1. signature.publicKeyId exists in trustedKeys → else return 'CRYPTO_UNKNOWN_KEY'
  const signature = manifest.signature;
  if (!signature || typeof signature !== 'object' || typeof signature.publicKeyId !== 'string') {
    return 'CRYPTO_UNKNOWN_KEY';
  }

  const keyId = signature.publicKeyId;
  const key = trustedKeys instanceof Map ? trustedKeys.get(keyId) : (trustedKeys as Record<string, any>)[keyId];
  if (!key) {
    return 'CRYPTO_UNKNOWN_KEY';
  }

  // 2. UnsignedManifest (without signature) → compute canonical bytes → compute sign_payload → verify Ed25519 → else return 'CRYPTO_VERIFICATION_FAILED'
  const { signature: _sig, ...unsignedManifest } = manifest;
  const canonicalBytes = Buffer.from(canonicalJson(unsignedManifest), 'utf8');
  const manifestDigestHex = crypto.createHash('sha256').update(canonicalBytes).digest('hex');

  const repoId = typeof manifest.repositoryId === 'string' ? manifest.repositoryId : '';
  const revision = typeof manifest.revision === 'string' ? manifest.revision : '';
  const envelopeVersion = typeof manifest.envelopeVersion === 'string' ? manifest.envelopeVersion : '';

  const signPayload = buildSignPayload(repoId, revision, envelopeVersion, manifestDigestHex);

  let publicKeyObj: crypto.KeyObject;
  try {
    if (key instanceof crypto.KeyObject) {
      publicKeyObj = key;
    } else if (typeof key === 'string') {
      if (key.includes('BEGIN PUBLIC KEY')) {
        publicKeyObj = crypto.createPublicKey(key);
      } else {
        publicKeyObj = crypto.createPublicKey({ key: Buffer.from(key, 'hex'), format: 'der', type: 'spki' });
      }
    } else if (Buffer.isBuffer(key)) {
      publicKeyObj = crypto.createPublicKey({ key, format: 'der', type: 'spki' });
    } else {
      return 'CRYPTO_UNKNOWN_KEY';
    }
  } catch {
    return 'CRYPTO_UNKNOWN_KEY';
  }

  let verified = false;
  try {
    const sigValue = typeof signature.signatureValue === 'string' ? signature.signatureValue : '';
    const sigBuf = Buffer.from(sigValue, 'base64url');
    verified = crypto.verify(null, signPayload, publicKeyObj, sigBuf);
  } catch {
    verified = false;
  }

  if (!verified) {
    return 'CRYPTO_VERIFICATION_FAILED';
  }

  // Expected repository and revision checks if specified
  if (expectedRepoId !== undefined && manifest.repositoryId !== expectedRepoId) {
    return 'MANIFEST_VALIDATION_FAILED';
  }
  if (expectedRevision !== undefined && manifest.revision !== expectedRevision) {
    return 'MANIFEST_VALIDATION_FAILED';
  }

  // 7. shard count ≤ 5 → else return 'MANIFEST_VALIDATION_FAILED'
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0 || manifest.shards.length > 5) {
    return 'MANIFEST_VALIDATION_FAILED';
  }

  const seenPaths = new Set<string>();
  const hex64Regex = /^[0-9a-f]{64}$/;

  for (const shard of manifest.shards) {
    if (!shard || typeof shard !== 'object') {
      return 'MANIFEST_VALIDATION_FAILED';
    }

    // 3. Shard path format validation (no '..', no '/') → else return 'MANIFEST_VALIDATION_FAILED'
    if (
      typeof shard.path !== 'string' ||
      shard.path.length === 0 ||
      shard.path.includes('..') ||
      shard.path.includes('/') ||
      shard.path.includes('\\')
    ) {
      return 'MANIFEST_VALIDATION_FAILED';
    }

    // 4. No duplicate shard paths → else return 'MANIFEST_VALIDATION_FAILED'
    if (seenPaths.has(shard.path)) {
      return 'MANIFEST_VALIDATION_FAILED';
    }
    seenPaths.add(shard.path);

    // 5. shard.sha256 must be 64 lowercase hex chars → else return 'MANIFEST_VALIDATION_FAILED'
    if (typeof shard.sha256 !== 'string' || !hex64Regex.test(shard.sha256)) {
      return 'MANIFEST_VALIDATION_FAILED';
    }

    // 6. shard.byteLength must be 1 to 20971520 → else return 'MANIFEST_VALIDATION_FAILED'
    if (
      typeof shard.byteLength !== 'number' ||
      !Number.isInteger(shard.byteLength) ||
      shard.byteLength < 1 ||
      shard.byteLength > 20971520
    ) {
      return 'MANIFEST_VALIDATION_FAILED';
    }
  }

  return 'VALID';
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Envelope V2 Canonicalization and Signing Test Fixtures', () => {
  const fixturesDir = fs.existsSync(path.resolve(process.cwd(), 'tests/fixtures/envelope_v2'))
    ? path.resolve(process.cwd(), 'tests/fixtures/envelope_v2')
    : path.resolve(__dirname, '../../../../tests/fixtures/envelope_v2');

  function loadVector(filename: string): EnvelopeV2TestVector {
    const filePath = path.join(fixturesDir, filename);
    expect(fs.existsSync(filePath)).toBe(true);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  it('vector_01: happy path matches canonical bytes, digest, sign payload, and verifies VALID', () => {
    const vector = loadVector('vector_01_two_shard_happy_path.json');
    expect(vector.expectedVerificationResult).toBe('VALID');

    // Extract unsigned manifest by omitting the signature key
    const { signature: _sig, ...unsignedManifest } = vector.signedManifest;

    // Re-compute canonical manifest bytes
    const canonicalString = canonicalJson(unsignedManifest);
    const canonicalBytes = Buffer.from(canonicalString, 'utf8');
    const computedCanonicalManifestHex = canonicalBytes.toString('hex');
    expect(computedCanonicalManifestHex).toBe(vector.canonicalManifestHex);

    // Re-compute manifest digest
    const computedManifestDigestHex = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
    expect(computedManifestDigestHex).toBe(vector.manifestDigestHex);

    // Re-compute sign payload
    const signPayload = buildSignPayload(
      unsignedManifest.repositoryId,
      unsignedManifest.revision,
      unsignedManifest.envelopeVersion,
      computedManifestDigestHex
    );
    const computedSignPayloadHex = signPayload.toString('hex');
    expect(computedSignPayloadHex).toBe(vector.signPayloadHex);

    // Build trustedKeys mapping with the vector's public key
    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector.publicKeyId, vector.publicKeyDerHex);

    // Run validateManifest
    const result = validateManifest(
      vector.signedManifest,
      trustedKeys,
      'test-org/test-repo',
      'aabbccddaabbccddaabbccddaabbccddaabbccdd'
    );
    expect(result).toBe('VALID');
  });

  it('vector_02: tampered repo emits CRYPTO_VERIFICATION_FAILED', () => {
    const vector01 = loadVector('vector_01_two_shard_happy_path.json');
    const vector02 = loadVector('vector_02_tampered_repo.json');
    expect(vector02.expectedVerificationResult).toBe('CRYPTO_VERIFICATION_FAILED');

    // Trust the producer's legitimate public key
    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector01.publicKeyId, vector01.publicKeyDerHex);

    const result = validateManifest(vector02.signedManifest, trustedKeys);
    expect(result).toBe(vector02.expectedVerificationResult);
  });

  it('vector_03: unknown key emits CRYPTO_UNKNOWN_KEY', () => {
    const vector01 = loadVector('vector_01_two_shard_happy_path.json');
    const vector03 = loadVector('vector_03_unknown_key.json');
    expect(vector03.expectedVerificationResult).toBe('CRYPTO_UNKNOWN_KEY');

    // Registry only knows legitimate key from vector 01
    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector01.publicKeyId, vector01.publicKeyDerHex);

    const result = validateManifest(vector03.signedManifest, trustedKeys);
    expect(result).toBe(vector03.expectedVerificationResult);
  });

  it('vector_04: duplicate shard path emits MANIFEST_VALIDATION_FAILED', () => {
    const vector = loadVector('vector_04_duplicate_shard_path.json');
    expect(vector.expectedVerificationResult).toBe('MANIFEST_VALIDATION_FAILED');

    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector.publicKeyId, vector.publicKeyDerHex);

    const result = validateManifest(vector.signedManifest, trustedKeys);
    expect(result).toBe(vector.expectedVerificationResult);
  });

  it('vector_05: malformed digest emits MANIFEST_VALIDATION_FAILED', () => {
    const vector = loadVector('vector_05_malformed_digest.json');
    expect(vector.expectedVerificationResult).toBe('MANIFEST_VALIDATION_FAILED');

    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector.publicKeyId, vector.publicKeyDerHex);

    const result = validateManifest(vector.signedManifest, trustedKeys);
    expect(result).toBe(vector.expectedVerificationResult);
  });

  it('vector_06: byteLength exceeding 20 MiB emits MANIFEST_VALIDATION_FAILED', () => {
    const vector = loadVector('vector_06_bytelength_mismatch.json');
    expect(vector.expectedVerificationResult).toBe('MANIFEST_VALIDATION_FAILED');

    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector.publicKeyId, vector.publicKeyDerHex);

    const result = validateManifest(vector.signedManifest, trustedKeys);
    expect(result).toBe(vector.expectedVerificationResult);
  });

  it('validateManifest rejects more than 5 shards with MANIFEST_VALIDATION_FAILED', () => {
    const vector01 = loadVector('vector_01_two_shard_happy_path.json');
    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector01.publicKeyId, vector01.publicKeyDerHex);

    // Create a 6-shard manifest
    const sixShards = Array.from({ length: 6 }, (_, i) => ({
      path: `shard-00${i + 1}.json`,
      sha256: 'a'.repeat(64),
      byteLength: 100,
    }));
    const manifestWith6Shards = {
      ...(vector01.signedManifest as any),
      shards: sixShards,
    };

    // Even if signature wasn't updated, shard count > 5 is rejected by MANIFEST_VALIDATION_FAILED
    // (If crypto check is first, test with valid signature for 6 shards)
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const { signature: _sig, ...unsigned } = manifestWith6Shards;
    const canonical = Buffer.from(canonicalJson(unsigned), 'utf8');
    const digest = crypto.createHash('sha256').update(canonical).digest('hex');
    const payload = buildSignPayload(unsigned.repositoryId, unsigned.revision, unsigned.envelopeVersion, digest);
    const sig = crypto.sign(null, payload, privateKey).toString('base64url');
    const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const keyId = 'sha256:' + crypto.createHash('sha256').update(pubDer).digest('hex');

    const signed6 = {
      ...unsigned,
      signature: {
        algorithm: 'Ed25519',
        publicKeyId: keyId,
        signatureValue: sig,
      },
    };
    const keys = new Map([[keyId, pubDer.toString('hex')]]);
    expect(validateManifest(signed6, keys)).toBe('MANIFEST_VALIDATION_FAILED');
  });

  it('validateManifest rejects path traversal characters in shard paths', () => {
    const vector01 = loadVector('vector_01_two_shard_happy_path.json');
    const badPaths = ['../secrets.json', 'subdir/shard.json', 'subdir\\shard.json', ''];

    for (const badPath of badPaths) {
      const manifest = {
        ...(vector01.signedManifest as any),
        shards: [
          {
            path: badPath,
            sha256: 'a'.repeat(64),
            byteLength: 500,
          },
        ],
      };
      // Sign correctly to ensure path validation is what rejects it
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const { signature: _sig, ...unsigned } = manifest;
      const canonical = Buffer.from(canonicalJson(unsigned), 'utf8');
      const digest = crypto.createHash('sha256').update(canonical).digest('hex');
      const payload = buildSignPayload(unsigned.repositoryId, unsigned.revision, unsigned.envelopeVersion, digest);
      const sig = crypto.sign(null, payload, privateKey).toString('base64url');
      const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      const keyId = 'sha256:' + crypto.createHash('sha256').update(pubDer).digest('hex');

      const signed = {
        ...unsigned,
        signature: {
          algorithm: 'Ed25519',
          publicKeyId: keyId,
          signatureValue: sig,
        },
      };
      const keys = new Map([[keyId, pubDer.toString('hex')]]);
      expect(validateManifest(signed, keys)).toBe('MANIFEST_VALIDATION_FAILED');
    }
  });

  it('validateManifest rejects expectedRepoId or expectedRevision mismatch', () => {
    const vector01 = loadVector('vector_01_two_shard_happy_path.json');
    const trustedKeys = new Map<string, string>();
    trustedKeys.set(vector01.publicKeyId, vector01.publicKeyDerHex);

    expect(
      validateManifest(vector01.signedManifest, trustedKeys, 'wrong-org/wrong-repo', vector01.signedManifest.revision)
    ).toBe('MANIFEST_VALIDATION_FAILED');

    expect(
      validateManifest(vector01.signedManifest, trustedKeys, vector01.signedManifest.repositoryId, '0'.repeat(40))
    ).toBe('MANIFEST_VALIDATION_FAILED');
  });
});
