# Sajimora Envelope V2 Signing Protocol

## UnsignedManifest schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "UnsignedManifest",
  "description": "Unsigned root manifest for Sajimora Envelope V2 contract artifacts",
  "type": "object",
  "required": [
    "envelopeVersion",
    "repositoryId",
    "revision",
    "createdAt",
    "shards",
    "rootTypePool"
  ],
  "properties": {
    "envelopeVersion": {
      "type": "string",
      "const": "SAJIMORA_CONTRACT_ARTIFACT_V2",
      "description": "Version discriminant for Envelope V2 artifacts"
    },
    "repositoryId": {
      "type": "string",
      "minLength": 1,
      "description": "Canonical repository identity (e.g. 'org/repo')"
    },
    "revision": {
      "type": "string",
      "minLength": 1,
      "description": "Immutable commit SHA or snapshot identifier"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 UTC creation timestamp"
    },
    "shards": {
      "type": "array",
      "minItems": 1,
      "maxItems": 5,
      "description": "List of payload shard references (maximum 5 shards)",
      "items": {
        "type": "object",
        "required": [
          "path",
          "sha256",
          "byteLength"
        ],
        "properties": {
          "path": {
            "type": "string",
            "pattern": "^[^/\\\\]+$",
            "description": "Repository-relative filename; MUST NOT contain '/' or '\\' or '..'"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$",
            "description": "Lowercase 64-character hexadecimal SHA-256 digest of shard contents"
          },
          "byteLength": {
            "type": "integer",
            "minimum": 1,
            "maximum": 20971520,
            "description": "Byte length of shard file; MUST be between 1 and 20971520 (20 MiB)"
          }
        },
        "additionalProperties": false
      }
    },
    "rootTypePool": {
      "type": "object",
      "description": "Shared root type definitions pool indexed by type reference"
    }
  },
  "additionalProperties": false
}
```

### SignedManifest Extension

A `SignedManifest` extends `UnsignedManifest` by adding an immutable `signature` block:

```json
{
  "signature": {
    "type": "object",
    "required": [
      "algorithm",
      "publicKeyId",
      "signatureValue"
    ],
    "properties": {
      "algorithm": {
        "type": "string",
        "const": "Ed25519"
      },
      "publicKeyId": {
        "type": "string",
        "pattern": "^sha256:[0-9a-f]{64}$",
        "description": "Public key identifier formatted as 'sha256:<digest_hex>' over DER-encoded SPKI public key bytes"
      },
      "signatureValue": {
        "type": "string",
        "description": "Base64url-encoded Ed25519 signature without padding"
      }
    },
    "additionalProperties": false
  }
}
```

## Sign payload construction
All strings UTF-8 encoded. Length-prefix format: decimal_len ":" field_bytes "\n"

```
sign_payload =
  "SAJIMORA-ED25519-V2-MANIFEST\n"
  + decimal_len(repo_id_utf8) + ":" + repo_id_utf8 + "\n"
  + decimal_len(revision_utf8) + ":" + revision_utf8 + "\n"
  + decimal_len(envelope_version_utf8) + ":" + envelope_version_utf8 + "\n"
  + "sha256:" + manifest_digest_hex_utf8 + "\n"

where:
  canonical_manifest_bytes = RFC8785_JCS(UnsignedManifest)  — lexicographic key order, no whitespace
  manifest_digest = SHA-256(canonical_manifest_bytes)
  manifest_digest_hex = lowercase 64-char hex of manifest_digest
  signature = Ed25519_Sign(private_key, sign_payload)
  signatureValue = base64url_no_padding(signature)
```

### Length-Prefix Encoding Rules
1. `decimal_len` represents the length of `field_bytes` in UTF-8 bytes as an ASCII decimal integer string without leading zeros (except for zero itself: `"0"`).
2. The colon character `:` immediately follows `decimal_len`.
3. The raw UTF-8 field bytes immediately follow the colon.
4. A single newline character `\n` (0x0A) terminates the line.
5. The `manifest_digest_hex_utf8` line uses a fixed `"sha256:"` prefix followed by exactly 64 lowercase hexadecimal characters and terminated with `\n`.

### Canonicalization Rules (RFC 8785 / JCS)
1. Keys are sorted lexicographically by UTF-16 code unit values recursively at every object depth.
2. Arrays preserve element order.
3. Whitespace outside of string literals is omitted (no space after `:` or `,`).
4. Floating-point and integer numbers follow standard JSON representation.
5. Unicode strings are serialized without non-essential escape sequences.

### Verification Algorithm
A compliant validator evaluates manifest admission against a trusted keys map:

1. **Key Recognition**: Extract `signature.publicKeyId`. Verify that it exists in the caller's `trustedKeys` mapping. If unrecognized, terminate with `CRYPTO_UNKNOWN_KEY`.
2. **Cryptographic Integrity**: Extract the `UnsignedManifest` by stripping the `signature` field. Canonicalize via RFC 8785 JCS, compute `manifest_digest = SHA-256(canonical_manifest_bytes)`, format `sign_payload`, and verify the Ed25519 signature against the trusted public key. If verification fails, terminate with `CRYPTO_VERIFICATION_FAILED`.
3. **Shard Path Format**: Ensure all shard paths contain only safe repository-relative filenames without path traversal (`..`), directory separators (`/` or `\`), and are non-empty. If invalid, terminate with `MANIFEST_VALIDATION_FAILED`.
4. **Path Uniqueness**: Ensure shard paths contain no duplicates. If duplicates exist, terminate with `MANIFEST_VALIDATION_FAILED`.
5. **Shard Digest Format**: Ensure each shard `sha256` digest consists of exactly 64 lowercase hexadecimal characters. If invalid, terminate with `MANIFEST_VALIDATION_FAILED`.
6. **Shard Byte Length**: Ensure each shard `byteLength` is an integer between 1 and 20,971,520 (20 MiB inclusive). If out of bounds, terminate with `MANIFEST_VALIDATION_FAILED`.
7. **Shard Count**: Ensure total shards count is between 1 and 5 inclusive. If violated, terminate with `MANIFEST_VALIDATION_FAILED`.
8. **Success**: If all preconditions hold, return `VALID`.
