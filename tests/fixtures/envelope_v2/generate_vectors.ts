/**
 * generate_vectors.ts
 *
 * Generates test fixtures for Envelope V2 canonicalization and signing verification.
 * Adheres to RFC 8785 (JCS) canonicalization and Ed25519 signing protocol.
 *
 * Usage:
 *   npx tsx tests/fixtures/envelope_v2/generate_vectors.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface ShardDescriptor {
  path: string;
  sha256: string;
  byteLength: number;
}

export interface UnsignedManifest {
  envelopeVersion: string;
  repositoryId: string;
  revision: string;
  createdAt: string;
  shards: ShardDescriptor[];
  rootTypePool: Record<string, unknown>;
}

export interface ManifestSignature {
  algorithm: 'Ed25519';
  publicKeyId: string;
  signatureValue: string;
}

export interface SignedManifest extends UnsignedManifest {
  signature: ManifestSignature;
}

export interface EnvelopeV2TestVector {
  description: string;
  publicKeyId: string;
  publicKeyDerHex: string;
  signPayloadHex: string;
  canonicalManifestHex: string;
  manifestDigestHex: string;
  signedManifest: SignedManifest;
  expectedVerificationResult:
    | 'VALID'
    | 'CRYPTO_UNKNOWN_KEY'
    | 'CRYPTO_VERIFICATION_FAILED'
    | 'MANIFEST_VALIDATION_FAILED';
}

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) Canonicalization
// ---------------------------------------------------------------------------

/**
 * Produce deterministic canonical JSON string per RFC 8785 (JCS).
 * - Recursively sorts object keys lexicographically.
 * - Preserves array ordering.
 * - Emits no whitespace around delimiters.
 */
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
// Sign payload construction
// ---------------------------------------------------------------------------

/**
 * Construct the length-prefixed sign payload buffer.
 *
 * Format:
 *   "SAJIMORA-ED25519-V2-MANIFEST\n"
 *   + decimal_len(repo_id_utf8) + ":" + repo_id_utf8 + "\n"
 *   + decimal_len(revision_utf8) + ":" + revision_utf8 + "\n"
 *   + decimal_len(envelope_version_utf8) + ":" + envelope_version_utf8 + "\n"
 *   + "sha256:" + manifest_digest_hex_utf8 + "\n"
 */
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
// Manifest signing helper
// ---------------------------------------------------------------------------

export function signManifest(
  unsignedManifest: UnsignedManifest,
  privateKey: crypto.KeyObject,
  publicKeyId: string
): {
  canonicalManifestHex: string;
  manifestDigestHex: string;
  signPayloadHex: string;
  signatureValue: string;
  signedManifest: SignedManifest;
} {
  const canonicalManifestBytes = Buffer.from(canonicalJson(unsignedManifest), 'utf8');
  const manifestDigestHex = crypto
    .createHash('sha256')
    .update(canonicalManifestBytes)
    .digest('hex');

  const signPayload = buildSignPayload(
    unsignedManifest.repositoryId,
    unsignedManifest.revision,
    unsignedManifest.envelopeVersion,
    manifestDigestHex
  );

  const signature = crypto.sign(null, signPayload, privateKey);
  const signatureValue = signature.toString('base64url');

  const signedManifest: SignedManifest = {
    ...unsignedManifest,
    signature: {
      algorithm: 'Ed25519',
      publicKeyId,
      signatureValue,
    },
  };

  return {
    canonicalManifestHex: canonicalManifestBytes.toString('hex'),
    manifestDigestHex,
    signPayloadHex: signPayload.toString('hex'),
    signatureValue,
    signedManifest,
  };
}

// ---------------------------------------------------------------------------
// Vector generator
// ---------------------------------------------------------------------------

export function generateAllVectors(outputDirectory?: string): {
  vector01: EnvelopeV2TestVector;
  vector02: EnvelopeV2TestVector;
  vector03: EnvelopeV2TestVector;
  vector04: EnvelopeV2TestVector;
  vector05: EnvelopeV2TestVector;
  vector06: EnvelopeV2TestVector;
} {
  // 1. Generate test Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyDerHex = publicKeyDer.toString('hex');
  const publicKeyId = 'sha256:' + crypto.createHash('sha256').update(publicKeyDer).digest('hex');

  // 2. Base UnsignedManifest for vector_01
  const unsignedManifest01: UnsignedManifest = {
    envelopeVersion: 'SAJIMORA_CONTRACT_ARTIFACT_V2',
    repositoryId: 'test-org/test-repo',
    revision: 'aabbccddaabbccddaabbccddaabbccddaabbccdd',
    createdAt: '2026-10-17T12:00:00Z',
    shards: [
      {
        path: 'shard-001.json',
        sha256: 'a'.repeat(64),
        byteLength: 1024,
      },
      {
        path: 'shard-002.json',
        sha256: 'b'.repeat(64),
        byteLength: 512,
      },
    ],
    rootTypePool: {},
  };

  // 10. Vector 01: Happy path
  const signed01 = signManifest(unsignedManifest01, privateKey, publicKeyId);
  const vector01: EnvelopeV2TestVector = {
    description: 'Happy path: 2-shard manifest, valid Ed25519 signature',
    publicKeyId,
    publicKeyDerHex,
    signPayloadHex: signed01.signPayloadHex,
    canonicalManifestHex: signed01.canonicalManifestHex,
    manifestDigestHex: signed01.manifestDigestHex,
    signedManifest: signed01.signedManifest,
    expectedVerificationResult: 'VALID',
  };

  // 11. Vector 02: Tampered repo
  // Same as vector_01 but change repositoryId in signedManifest to "attacker/repo"
  // Signature was computed on "test-org/test-repo", so verification fails.
  const vector02: EnvelopeV2TestVector = {
    description: 'Tampered repositoryId: signature signed for test-org/test-repo, manifest claims attacker/repo',
    publicKeyId,
    publicKeyDerHex,
    signPayloadHex: signed01.signPayloadHex,
    canonicalManifestHex: signed01.canonicalManifestHex,
    manifestDigestHex: signed01.manifestDigestHex,
    signedManifest: {
      ...signed01.signedManifest,
      repositoryId: 'attacker/repo',
    },
    expectedVerificationResult: 'CRYPTO_VERIFICATION_FAILED',
  };

  // 12. Vector 03: Unknown key
  // Same signature but change publicKeyId to "sha256:" + "0".repeat(64)
  const unknownKeyId = 'sha256:' + '0'.repeat(64);
  const vector03: EnvelopeV2TestVector = {
    description: 'Unknown public key: publicKeyId is not present in trustedKeys',
    publicKeyId: unknownKeyId,
    publicKeyDerHex,
    signPayloadHex: signed01.signPayloadHex,
    canonicalManifestHex: signed01.canonicalManifestHex,
    manifestDigestHex: signed01.manifestDigestHex,
    signedManifest: {
      ...signed01.signedManifest,
      signature: {
        ...signed01.signedManifest.signature,
        publicKeyId: unknownKeyId,
      },
    },
    expectedVerificationResult: 'CRYPTO_UNKNOWN_KEY',
  };

  // 13. Vector 04: Duplicate shard path
  // Same but set both shards to path "shard-001.json" — signed with valid signature
  const unsignedManifest04: UnsignedManifest = {
    ...unsignedManifest01,
    shards: [
      {
        path: 'shard-001.json',
        sha256: 'a'.repeat(64),
        byteLength: 1024,
      },
      {
        path: 'shard-001.json',
        sha256: 'b'.repeat(64),
        byteLength: 512,
      },
    ],
  };
  const signed04 = signManifest(unsignedManifest04, privateKey, publicKeyId);
  const vector04: EnvelopeV2TestVector = {
    description: 'Duplicate shard path: manifest contains multiple shards with identical path',
    publicKeyId,
    publicKeyDerHex,
    signPayloadHex: signed04.signPayloadHex,
    canonicalManifestHex: signed04.canonicalManifestHex,
    manifestDigestHex: signed04.manifestDigestHex,
    signedManifest: signed04.signedManifest,
    expectedVerificationResult: 'MANIFEST_VALIDATION_FAILED',
  };

  // 14. Vector 05: Malformed digest
  // Same but set shard-001 sha256 to "xyz" (not 64 hex chars) — signed with valid signature
  const unsignedManifest05: UnsignedManifest = {
    ...unsignedManifest01,
    shards: [
      {
        path: 'shard-001.json',
        sha256: 'xyz',
        byteLength: 1024,
      },
      {
        path: 'shard-002.json',
        sha256: 'b'.repeat(64),
        byteLength: 512,
      },
    ],
  };
  const signed05 = signManifest(unsignedManifest05, privateKey, publicKeyId);
  const vector05: EnvelopeV2TestVector = {
    description: 'Malformed shard digest: shard sha256 is not 64 hex characters',
    publicKeyId,
    publicKeyDerHex,
    signPayloadHex: signed05.signPayloadHex,
    canonicalManifestHex: signed05.canonicalManifestHex,
    manifestDigestHex: signed05.manifestDigestHex,
    signedManifest: signed05.signedManifest,
    expectedVerificationResult: 'MANIFEST_VALIDATION_FAILED',
  };

  // 15. Vector 06: ByteLength mismatch (exceeds 20 MiB)
  // Valid signature, but byteLength: 9999999999 (exceeds 20 MiB = 20971520)
  const unsignedManifest06: UnsignedManifest = {
    ...unsignedManifest01,
    shards: [
      {
        path: 'shard-001.json',
        sha256: 'a'.repeat(64),
        byteLength: 9999999999,
      },
      {
        path: 'shard-002.json',
        sha256: 'b'.repeat(64),
        byteLength: 512,
      },
    ],
  };
  const signed06 = signManifest(unsignedManifest06, privateKey, publicKeyId);
  const vector06: EnvelopeV2TestVector = {
    description: 'Byte length exceeds limit: shard byteLength exceeds 20 MiB maximum',
    publicKeyId,
    publicKeyDerHex,
    signPayloadHex: signed06.signPayloadHex,
    canonicalManifestHex: signed06.canonicalManifestHex,
    manifestDigestHex: signed06.manifestDigestHex,
    signedManifest: signed06.signedManifest,
    expectedVerificationResult: 'MANIFEST_VALIDATION_FAILED',
  };

  if (outputDirectory) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const writeVector = (filename: string, data: EnvelopeV2TestVector) => {
      const target = path.join(outputDirectory, filename);
      fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
      console.log(`Wrote vector fixture: ${target}`);
    };

    writeVector('vector_01_two_shard_happy_path.json', vector01);
    writeVector('vector_02_tampered_repo.json', vector02);
    writeVector('vector_03_unknown_key.json', vector03);
    writeVector('vector_04_duplicate_shard_path.json', vector04);
    writeVector('vector_05_malformed_digest.json', vector05);
    writeVector('vector_06_bytelength_mismatch.json', vector06);
  }

  return { vector01, vector02, vector03, vector04, vector05, vector06 };
}

// ---------------------------------------------------------------------------
// Main execution when run directly
// ---------------------------------------------------------------------------

const resolvedDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.resolve(process.cwd(), 'tests/fixtures/envelope_v2');

generateAllVectors(resolvedDir);
