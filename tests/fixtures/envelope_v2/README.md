# Envelope V2 Test Fixtures & Canonicalization

This directory contains canonicalization and cryptographic signing test fixtures for the **Sajimora Envelope V2** specification.

## Overview

Envelope V2 introduces multi-shard contract IR distribution and asymmetric Ed25519 manifest signing. Before any shard is ingested or parsed, the client verifies the root signed manifest.

### Structure of Fixtures

Each fixture file defines a self-contained test vector with manifest metadata, pre-computed hashes/payloads, and expected verification outcome:

| File | Description | Expected Result |
| :--- | :--- | :--- |
| `vector_01_two_shard_happy_path.json` | Happy path: 2-shard manifest, valid Ed25519 signature | `VALID` |
| `vector_02_tampered_repo.json` | Tampered repository ID in signed manifest (signature forged/mismatched) | `CRYPTO_VERIFICATION_FAILED` |
| `vector_03_unknown_key.json` | Public key ID is not present in trusted keys registry (`sha256:000...`) | `CRYPTO_UNKNOWN_KEY` |
| `vector_04_duplicate_shard_path.json` | Manifest contains duplicate shard paths (`shard-001.json`) | `MANIFEST_VALIDATION_FAILED` |
| `vector_05_malformed_digest.json` | Shard SHA-256 digest is malformed (`xyz`, not 64 hex characters) | `MANIFEST_VALIDATION_FAILED` |
| `vector_06_bytelength_mismatch.json` | Shard `byteLength` exceeds maximum 20 MiB limit (`9999999999`) | `MANIFEST_VALIDATION_FAILED` |

## Signing Protocol Summary

The full specification is defined in [`signing_spec.md`](./signing_spec.md).

### 1. Canonical Manifest Bytes (RFC 8785 / JCS)
The `UnsignedManifest` (excluding the `signature` field) is canonicalized following RFC 8785:
- Object keys are sorted lexicographically (UTF-16 code unit order) recursively.
- Delimiters contain no extraneous whitespace (`{"a":1,"b":2}`).
- Arrays preserve element insertion order.

### 2. Sign Payload Format
Strings are UTF-8 encoded with length-prefix encoding:
```
sign_payload =
  "SAJIMORA-ED25519-V2-MANIFEST\n"
  + decimal_len(repo_id_utf8) + ":" + repo_id_utf8 + "\n"
  + decimal_len(revision_utf8) + ":" + revision_utf8 + "\n"
  + decimal_len(envelope_version_utf8) + ":" + envelope_version_utf8 + "\n"
  + "sha256:" + manifest_digest_hex_utf8 + "\n"
```

### 3. Ed25519 Signature
The sign payload buffer is signed using the producer's Ed25519 private key:
- Algorithm: Ed25519 (PureEd25519 / RFC 8032)
- Value: Base64URL encoded without padding (`sig.toString('base64url')`)
- Public Key ID: `sha256:` prefix + 64 lowercase hex characters of the SHA-256 digest of the DER-encoded SPKI public key bytes.

## Regeneating Test Vectors

To regenerate all fixtures:

```bash
npx tsx tests/fixtures/envelope_v2/generate_vectors.ts
```

## Running Verification Tests

Verification tests are located in:
`packages/analysis/tests/sajimora/cross-language/envelope_canonical.test.ts`

Run via:
```bash
npx vitest run packages/analysis/tests/sajimora/cross-language/envelope_canonical.test.ts
```
or via the cross-language test suite:
```bash
npm run test:cross-language
```
