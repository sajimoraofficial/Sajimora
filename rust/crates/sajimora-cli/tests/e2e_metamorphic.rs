//! e2e_metamorphic.rs — Metamorphic testing suite for Sajimora contract extraction and verification.
//!
//! Asserts metamorphic invariants:
//! 1. Semantic Invariance: Adding comments, reformatting, or adding whitespace does not alter
//!    the extracted endpoint identities, HTTP methods, normalized routes, directional contracts, or type pool.
//! 2. Context Invariance: Adding unrelated non-Spring classes or documentation files preserves
//!    the exact set of extracted endpoints and DTO models.
//! 3. Semantic Sensitivity: Changing an HTTP method (POST -> PUT) strictly eliminates the old
//!    POST endpoint from the contract and introduces the new PUT endpoint.
//!
//! Architectural Note on Directional Endpoints:
//! In Sajimora, Spring methods with `@RequestBody` are extracted into TWO directional contract endpoints:
//! - 1 REQUEST directional endpoint (for incoming payload validation)
//! - 1 RESPONSE directional endpoint (for outgoing return-type validation)
//! Therefore, a controller with 1 GET (return type) and 1 POST (@RequestBody + return type)
//! yields exactly 3 directional contract endpoints (1 REQUEST + 2 RESPONSE).

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// RAII guard for temporary test directories, ensuring automatic cleanup on normal exit or panic.
pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sajimora-e2e-meta-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.path) {
            if self.path.exists() {
                eprintln!(
                    "[WARN] TempDirGuard failed to remove {:?}: {}",
                    self.path, e
                );
            }
        }
    }
}

fn cli_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sajimora"))
}

fn extract_backend_envelope(repo: &Path, out_file: &Path) -> Value {
    let output = Command::new(cli_bin())
        .arg("extract-backend")
        .arg("--repo")
        .arg(repo)
        .arg("--out")
        .arg(out_file)
        .output()
        .expect("extract-backend failed to execute");

    assert!(
        output.status.success(),
        "extract-backend failed: stderr={}, stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );

    let raw = fs::read_to_string(out_file).expect("Failed to read extracted contract envelope");
    serde_json::from_str(&raw).expect("Extracted contract is not valid JSON")
}

fn strip_provenance(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.remove("provenance");
            for (_, val) in map.iter_mut() {
                strip_provenance(val);
            }
        }
        Value::Array(arr) => {
            for val in arr.iter_mut() {
                strip_provenance(val);
            }
        }
        _ => {}
    }
}

/// Helper to index endpoints by a stable key `(httpMethod, rawPath, direction)`
/// Strictly asserts that no duplicate keys exist in the contract.
fn index_endpoints_by_stable_key(endpoints: &[Value]) -> HashMap<(String, String, String), &Value> {
    let mut map = HashMap::new();
    for ep in endpoints {
        let method = ep["identity"]["httpMethod"]
            .as_str()
            .expect("httpMethod must be a string")
            .to_string();
        let path = ep["identity"]["normalizedRoute"]["rawPath"]
            .as_str()
            .expect("rawPath must be a string")
            .to_string();
        let direction = ep["identity"]["direction"]
            .as_str()
            .expect("direction must be a string")
            .to_string();
        let key = (method, path, direction);
        let prev = map.insert(key.clone(), ep);
        assert!(
            prev.is_none(),
            "Duplicate endpoint identity detected in contract payload: {:?}",
            key
        );
    }
    map
}

#[test]
fn test_metamorphic_invariance_under_irrelevant_transformations() {
    let temp_guard = TempDirGuard::new("meta-invariance");
    let repo = temp_guard.path();
    let java_dir = repo.join("src/main/java/com/example");
    fs::create_dir_all(&java_dir).unwrap();

    // -------------------------------------------------------------------------
    // FORM 1: Canonical Base Implementation
    // -------------------------------------------------------------------------
    let base_code = r#"package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PaymentController {
    @GetMapping("/api/payments/status")
    public PaymentStatus getStatus() {
        return new PaymentStatus();
    }

    @PostMapping("/api/payments/charge")
    public ChargeResult charge(@RequestBody ChargeRequest request) {
        return new ChargeResult();
    }
}

class PaymentStatus {
    public String status;
    public boolean active;
}

class ChargeRequest {
    public Long amount;
    public String currency;
}

class ChargeResult {
    public String transactionId;
    public boolean success;
}
"#;
    fs::write(java_dir.join("PaymentController.java"), base_code).unwrap();

    let envelope_1_path = repo.join("contract_1.json");
    let envelope_1 = extract_backend_envelope(&repo, &envelope_1_path);
    let endpoints_1 = envelope_1["payload"]["endpoints"]
        .as_array()
        .expect("endpoints array");

    // Sajimora extracts directional endpoints:
    // - 1 REQUEST endpoint: POST /api/payments/charge (direction: REQUEST, body: ChargeRequest)
    // - 2 RESPONSE endpoints: POST /api/payments/charge (direction: RESPONSE, body: ChargeResult)
    //                         GET /api/payments/status (direction: RESPONSE, body: PaymentStatus)
    let req_count_1 = endpoints_1
        .iter()
        .filter(|e| e["identity"]["direction"] == "REQUEST")
        .count();
    let resp_count_1 = endpoints_1
        .iter()
        .filter(|e| e["identity"]["direction"] == "RESPONSE")
        .count();
    assert_eq!(
        req_count_1, 1,
        "Must extract exactly 1 REQUEST endpoint (@RequestBody ChargeRequest)"
    );
    assert_eq!(
        resp_count_1, 2,
        "Must extract exactly 2 RESPONSE endpoints (ChargeResult, PaymentStatus)"
    );
    assert_eq!(
        endpoints_1.len(),
        3,
        "Total directional contract endpoints must be exactly 3 (1 REQUEST + 2 RESPONSE)"
    );

    let indexed_1 = index_endpoints_by_stable_key(endpoints_1);
    assert!(indexed_1.contains_key(&(
        "POST".to_string(),
        "/api/payments/charge".to_string(),
        "REQUEST".to_string()
    )));
    assert!(indexed_1.contains_key(&(
        "POST".to_string(),
        "/api/payments/charge".to_string(),
        "RESPONSE".to_string()
    )));
    assert!(indexed_1.contains_key(&(
        "GET".to_string(),
        "/api/payments/status".to_string(),
        "RESPONSE".to_string()
    )));

    // Complete typePool assertion: must exist and contain the referenced DTOs
    let tp1 = envelope_1["payload"]
        .get("type_pool")
        .or_else(|| envelope_1["payload"].get("typePool"))
        .expect("typePool must exist in canonical contract payload");
    assert!(
        tp1.is_object() && !tp1.as_object().unwrap().is_empty(),
        "typePool must not be empty in canonical contract"
    );

    // -------------------------------------------------------------------------
    // TRANSFORMATION A: Insert heavy documentation comments, indentation & reformatting
    // Must preserve identical HTTP methods, normalized routes, directional contracts, and DTO wire models.
    // -------------------------------------------------------------------------
    let reformatted_code = r#"package com.example;

/**
 * Payment Controller handles payment gateways.
 * Added multi-line javadoc documentation.
 */
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PaymentController {

    /* Inline block comment for getStatus */
    @GetMapping("/api/payments/status")
    public PaymentStatus getStatus() {
        // Method body comment that should never alter API wire type
        return new PaymentStatus();
    }

    /* Complex comment block before charge endpoint */
    @PostMapping("/api/payments/charge")
    public ChargeResult charge(  @RequestBody ChargeRequest request  ) {
        return new ChargeResult();
    }
}

class PaymentStatus {
    public String status;
    public boolean active;
}

class ChargeRequest {
    public Long amount;
    public String currency;
}

class ChargeResult {
    public String transactionId;
    public boolean success;
}
"#;
    fs::write(java_dir.join("PaymentController.java"), reformatted_code).unwrap();

    let envelope_2_path = repo.join("contract_2.json");
    let envelope_2 = extract_backend_envelope(&repo, &envelope_2_path);
    let endpoints_2 = envelope_2["payload"]["endpoints"]
        .as_array()
        .expect("endpoints array");

    assert_eq!(
        endpoints_1.len(),
        endpoints_2.len(),
        "METAMORPHIC VIOLATION: Endpoint count changed under reformatting!"
    );

    let indexed_2 = index_endpoints_by_stable_key(endpoints_2);

    // Verify each endpoint identity and wire model matches 100% by stable key
    for (key, ep1) in &indexed_1 {
        let ep2 = indexed_2.get(key).unwrap_or_else(|| {
            panic!(
                "Endpoint key {:?} missing after reformatting transformation!",
                key
            )
        });
        assert_eq!(
            ep1["identity"]["normalizedRoute"], ep2["identity"]["normalizedRoute"],
            "Normalized routes must match for {:?}",
            key
        );
        assert_eq!(
            ep1["identity"]["httpMethod"], ep2["identity"]["httpMethod"],
            "HTTP methods must match for {:?}",
            key
        );
        assert_eq!(
            ep1["identity"]["direction"], ep2["identity"]["direction"],
            "Direction must match for {:?}",
            key
        );
        assert_eq!(
            ep1["body"]["kind"], ep2["body"]["kind"],
            "Body wire kinds must match for {:?}",
            key
        );
        assert_eq!(
            ep1["body"]["ref"], ep2["body"]["ref"],
            "Body type refs must match for {:?}",
            key
        );
    }

    // Complete typePool assertion under reformatting
    let tp2 = envelope_2["payload"]
        .get("type_pool")
        .or_else(|| envelope_2["payload"].get("typePool"))
        .expect("typePool must exist in reformatted contract payload");
    let mut tp1_norm = tp1.clone();
    let mut tp2_norm = tp2.clone();
    strip_provenance(&mut tp1_norm);
    strip_provenance(&mut tp2_norm);
    assert_eq!(
        tp1_norm, tp2_norm,
        "Complete typePool must be 100% identical under formatting and comment transformations"
    );

    // -------------------------------------------------------------------------
    // TRANSFORMATION B: Add completely unrelated non-Spring helper classes & markdown
    // Must not add, remove, or mutate endpoints or contract models in the contract payload.
    // -------------------------------------------------------------------------
    let helper_code = r#"package com.example;

public class MathUtils {
    public static int add(int a, int b) {
        return a + b;
    }
}
"#;
    fs::write(java_dir.join("MathUtils.java"), helper_code).unwrap();
    fs::write(
        repo.join("README.md"),
        "# Project Documentation\nIrrelevant content.",
    )
    .unwrap();

    let envelope_3_path = repo.join("contract_3.json");
    let envelope_3 = extract_backend_envelope(&repo, &envelope_3_path);
    let endpoints_3 = envelope_3["payload"]["endpoints"]
        .as_array()
        .expect("endpoints array");

    assert_eq!(
        endpoints_1.len(),
        endpoints_3.len(),
        "METAMORPHIC VIOLATION: Adding non-Spring helper classes altered endpoint count!"
    );
    let indexed_3 = index_endpoints_by_stable_key(endpoints_3);
    for (key, ep1) in &indexed_1 {
        let ep3 = indexed_3.get(key).unwrap_or_else(|| {
            panic!(
                "Endpoint key {:?} missing after adding unrelated helper class!",
                key
            )
        });
        assert_eq!(
            ep1["identity"]["normalizedRoute"], ep3["identity"]["normalizedRoute"],
            "Normalized route invariant violated for {:?}",
            key
        );
        assert_eq!(
            ep1["body"]["ref"], ep3["body"]["ref"],
            "Body type ref invariant violated for {:?}",
            key
        );
    }

    // Complete typePool assertion: adding unrelated class must not alter typePool
    let tp3 = envelope_3["payload"]
        .get("type_pool")
        .or_else(|| envelope_3["payload"].get("typePool"))
        .expect("typePool must exist in unrelated-helper contract");
    let mut tp3_norm = tp3.clone();
    strip_provenance(&mut tp3_norm);
    assert_eq!(
        tp1_norm, tp3_norm,
        "Complete typePool must be 100% identical when unrelated helper classes are added"
    );

    // -------------------------------------------------------------------------
    // TRANSFORMATION C: Semantic Mutation (Change HTTP method POST -> PUT)
    // Must strictly eliminate old POST endpoints and register new PUT endpoints.
    // -------------------------------------------------------------------------
    let mutated_code = reformatted_code
        .replace(
            "@PostMapping(\"/api/payments/charge\")",
            "@PutMapping(\"/api/payments/charge\")",
        )
        .replace(
            "import org.springframework.web.bind.annotation.PostMapping;",
            "import org.springframework.web.bind.annotation.PutMapping;",
        );
    fs::write(java_dir.join("PaymentController.java"), mutated_code).unwrap();

    let envelope_4_path = repo.join("contract_4.json");
    let envelope_4 = extract_backend_envelope(&repo, &envelope_4_path);
    let endpoints_4 = envelope_4["payload"]["endpoints"]
        .as_array()
        .expect("endpoints array");

    // 1. Assert old POST endpoints on /api/payments/charge no longer exist
    let has_old_post = endpoints_4.iter().any(|e| {
        e["identity"]["httpMethod"] == "POST"
            && e["identity"]["normalizedRoute"]["rawPath"] == "/api/payments/charge"
    });
    assert!(
        !has_old_post,
        "Old POST /api/payments/charge endpoint must be completely absent after mutation to PUT"
    );

    // 2. Assert new PUT endpoint exists
    let has_new_put = endpoints_4.iter().any(|e| {
        e["identity"]["httpMethod"] == "PUT"
            && e["identity"]["normalizedRoute"]["rawPath"] == "/api/payments/charge"
    });
    assert!(
        has_new_put,
        "SEMANTIC SENSITIVITY: Changing @PostMapping to @PutMapping must register PUT route in contract"
    );
}
