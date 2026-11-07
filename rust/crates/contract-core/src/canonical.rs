//! canonical.rs — Canonical JSON serialization (RFC 8785 key-sort, JS-compatible)
//!
//! This module provides `canonical_json()` which EXACTLY reproduces the output of
//! the TypeScript `canonicalJson()` function in ContractArtifactEnvelope.ts.
//!
//! === CRITICAL: JS-COMPATIBLE SORT ORDER ===
//! TypeScript uses `Object.keys(obj).sort()` which sorts by UTF-16 code unit values.
//! For ASCII-only keys this is identical to UTF-8/Unicode scalar ordering.
//! For non-BMP characters (code points >= U+10000), JavaScript stores them as
//! surrogate pairs (two UTF-16 code units). The sort order of surrogate-pair
//! encoded strings differs from Unicode scalar value order.
//!
//! Rust strings are UTF-8. To replicate JS sort order exactly for all inputs,
//! we convert keys to UTF-16 sequences and compare those.
//!
//! === CRITICAL: PRIMITIVE SERIALIZATION ===
//! Primitive values (numbers, strings, booleans, null) are serialized by
//! `JSON.stringify` in TypeScript (V8 engine). Key behaviors:
//!
//! - `NaN`, `Infinity`, `-Infinity` → serialized as `null`
//! - `-0` → serialized as `0` (JS JSON.stringify(-0) === "0")
//! - Numbers: V8 numeric-to-string algorithm (no trailing zeros, scientific
//!   notation for very large/small values)
//! - Strings: escaped using JSON standard rules
//!   (" \ and control chars U+0000–U+001F)
//! - `undefined` values in objects are OMITTED (filtered before serialization)
//! - `null` is kept and serialized as "null"
//!
//! === DIGEST INPUT ===
//! The digest input sets `integrity` to null and DELETES `signature`.
//! The Rust implementation must replicate this by constructing the digest-input
//! value with integrity=null and no signature field, then calling canonical_json.

use anyhow::Result;
use serde_json::Value;

/// Sort two JSON object keys using JavaScript UTF-16 code unit comparison.
/// This matches `Array.prototype.sort` on strings in V8.
fn js_key_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let a_utf16: Vec<u16> = a.encode_utf16().collect();
    let b_utf16: Vec<u16> = b.encode_utf16().collect();
    a_utf16.cmp(&b_utf16)
}

/// Produce a deterministic canonical JSON string compatible with the TypeScript
/// `canonicalJson()` function.
///
/// Rules:
/// - Null, booleans, strings, and numbers: serialized via serde_json (matches JSON.stringify for well-formed values)
/// - Arrays: elements canonicalized in insertion order
/// - Objects: keys sorted by UTF-16 code unit order; keys with null values are included;
///   keys that map to JSON `undefined` cannot appear in serde_json (they are dropped on parse)
/// - NOTE: serde_json does not produce NaN/Infinity (it rejects them at parse time);
///   the TypeScript reference also rejects them via JSON.parse. Both implementations
///   are consistent on well-formed artifact inputs.
pub fn format_ecmascript_number(n: &serde_json::Number) -> String {
    // JSON.parse represents integer tokens as binary64 too.
    match n.as_f64() {
        Some(f) if f.is_finite() => {
            if f == 0.0 {
                "0".to_owned()
            } else {
                ryu_js::Buffer::new().format(f).to_owned()
            }
        }
        _ => "null".to_owned(),
    }
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => format_ecmascript_number(n),
        Value::String(_s) => {
            // serde_json serializes strings with the same escaping rules as JSON.stringify.
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        Value::Array(arr) => {
            let inner: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", inner.join(","))
        }
        Value::Object(map) => {
            // Collect keys and sort by UTF-16 code unit order (JS compatibility).
            let mut keys: Vec<&str> = map.keys().map(|k| k.as_str()).collect();
            keys.sort_by(|a, b| js_key_cmp(a, b));

            let inner: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let v = &map[k];
                    let key_json =
                        serde_json::to_string(k).unwrap_or_else(|_| format!("\"{}\"", k));
                    format!("{}:{}", key_json, canonical_json(v))
                })
                .collect();

            format!("{{{}}}", inner.join(","))
        }
    }
}

/// Compute the SHA-256 hex digest of a canonical JSON value.
/// The result is lowercase hexadecimal (matching TypeScript `createHash('sha256').digest('hex')`).
pub fn compute_canonical_digest(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let canonical = canonical_json(value);
    let hash = Sha256::digest(canonical.as_bytes());
    hex::encode(hash)
}

struct DuplicateKeyChecker;

impl<'de> serde::de::Visitor<'de> for DuplicateKeyChecker {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("any valid JSON value without duplicate keys")
    }

    fn visit_bool<E>(self, _v: bool) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_i64<E>(self, _v: i64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_u64<E>(self, _v: u64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_f64<E>(self, _v: f64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_str<E>(self, _v: &str) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        while let Some(()) = seq.next_element_seed(DuplicateKeyChecker)? {}
        Ok(())
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: serde::de::MapAccess<'de>,
    {
        let mut seen = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate key found in JSON object: {:?}",
                    key
                )));
            }
            map.next_value_seed(DuplicateKeyChecker)?;
        }
        Ok(())
    }
}

impl<'de> serde::de::DeserializeSeed<'de> for DuplicateKeyChecker {
    type Value = ();
    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateKeyChecker)
    }
}

/// Recursively reject JSON with duplicate object keys.
pub fn check_no_duplicate_keys(raw_json: &str) -> Result<()> {
    use serde::de::DeserializeSeed;
    let mut de = serde_json::Deserializer::from_str(raw_json);
    DuplicateKeyChecker
        .deserialize(&mut de)
        .map_err(|e| anyhow::anyhow!("Duplicate key detected: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_null() {
        assert_eq!(canonical_json(&Value::Null), "null");
    }

    #[test]
    fn canonical_bool() {
        assert_eq!(canonical_json(&json!(true)), "true");
        assert_eq!(canonical_json(&json!(false)), "false");
    }

    #[test]
    fn canonical_number_integer() {
        assert_eq!(canonical_json(&json!(42)), "42");
        assert_eq!(canonical_json(&json!(0)), "0");
        assert_eq!(canonical_json(&json!(-0.0)), "0");
        assert_eq!(canonical_json(&json!(-1)), "-1");
    }

    #[test]
    fn canonical_string_basic() {
        assert_eq!(canonical_json(&json!("hello")), "\"hello\"");
    }

    #[test]
    fn canonical_string_escapes() {
        // Tab, newline, carriage return, backslash, double-quote
        assert_eq!(canonical_json(&json!("\t")), r#""\t""#);
        assert_eq!(canonical_json(&json!("\n")), r#""\n""#);
        assert_eq!(canonical_json(&json!("\r")), r#""\r""#);
        assert_eq!(canonical_json(&json!("\\")), r#""\\""#);
        assert_eq!(canonical_json(&json!("\"")), r#""\"""#);
    }

    #[test]
    fn canonical_empty_object() {
        assert_eq!(canonical_json(&json!({})), "{}");
    }

    #[test]
    fn canonical_object_key_sort_ascii() {
        // ASCII keys: UTF-16 order equals lexicographic order
        let v = json!({"b": 2, "a": 1, "c": 3});
        assert_eq!(canonical_json(&v), r#"{"a":1,"b":2,"c":3}"#);
    }

    #[test]
    fn canonical_null_value_retained() {
        // null values are kept, not filtered (only `undefined` is filtered, and
        // serde_json cannot represent undefined)
        let v = json!({"key": null});
        assert_eq!(canonical_json(&v), r#"{"key":null}"#);
    }

    #[test]
    fn canonical_array_order_preserved() {
        let v = json!([3, 1, 2]);
        assert_eq!(canonical_json(&v), "[3,1,2]");
    }

    #[test]
    fn canonical_nested_object() {
        let v = json!({"z": {"b": 1, "a": 2}, "a": 3});
        assert_eq!(canonical_json(&v), r#"{"a":3,"z":{"a":2,"b":1}}"#);
    }

    #[test]
    fn utf16_sort_order_non_ascii() {
        // "\u00e9" (e with accent, U+00E9, one UTF-16 code unit 0x00E9)
        // "\u0041" is "A" (0x0041)
        // UTF-16 order: "A" (0x41) < "e" (0x65) < "é" (0xE9)
        let v = json!({"é": 3, "A": 1, "e": 2});
        let result = canonical_json(&v);
        assert_eq!(result, r#"{"A":1,"e":2,"é":3}"#);
    }

    #[test]
    fn utf16_sort_order_surrogate_pair_vs_bmp_e000() {
        // RFC 8785 §3.2.3: keys sort by UTF-16 code units, NOT by code point.
        // "😀" is U+1F600, stored as the surrogate pair [0xD83D, 0xDE00].
        // 0xD83D < 0xE000, so UTF-16 order places the emoji BEFORE the BMP
        // private-use character U+E000 — the reverse of code-point order
        // (U+1F600 > U+E000). A byte/code-point sort would produce a
        // different canonical string and thus a different digest.
        let v = json!({"\u{e000}": 2, "😀": 1});
        assert_eq!(canonical_json(&v), "{\"😀\":1,\"\":2}");
    }

    #[test]
    fn rfc8785_full_key_order_vector() {
        // Decisive UTF-16 ordering across control, ASCII, Latin-1, currency,
        // CJK, and non-BMP keys:
        //   "\r"(000D) < "1"(0031) < "ü"(00FC) < "€"(20AC) < "情"(60C5)
        //   < "笑"(7B11) < "表"(8868) < "😀"(D83D DE00) < U+E000 private use.
        // Also pins the §3.2.2.2 short-form escaping of the carriage-return
        // key and the non-escaping of printable non-ASCII keys.
        let v = json!({
            "表": 7, "😀": 8, "\u{e000}": 9, "€": 4, "情": 5,
            "笑": 6, "\r": 1, "1": 2, "ü": 3
        });
        let expected = concat!(
            "{\"\\r\":1,\"1\":2,\"ü\":3,\"€\":4,\"情\":5,",
            "\"笑\":6,\"表\":7,\"😀\":8,\"\":9}"
        );
        assert_eq!(canonical_json(&v), expected);
    }

    #[test]
    fn ecmascript_numeric_boundaries() {
        assert_eq!(canonical_json(&json!(1e20)), "100000000000000000000");
        assert_eq!(canonical_json(&json!(-1e20)), "-100000000000000000000");
        assert_eq!(canonical_json(&json!(1e21)), "1e+21");
        assert_eq!(canonical_json(&json!(1e-6)), "0.000001");
        assert_eq!(canonical_json(&json!(1e-7)), "1e-7");
    }

    #[test]
    fn duplicate_keys_rejected() {
        let valid = r#"{"a": 1, "b": 2, "c": {"d": 3}}"#;
        assert!(check_no_duplicate_keys(valid).is_ok());

        let duplicate = r#"{"a": 1, "a": 2}"#;
        assert!(check_no_duplicate_keys(duplicate).is_err());

        let nested_duplicate = r#"{"nested": {"x": 10, "x": 20}}"#;
        assert!(check_no_duplicate_keys(nested_duplicate).is_err());
    }
}
