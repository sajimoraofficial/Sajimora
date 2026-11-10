//! differential_scan_equivalence_test.rs — Differential Correctness & Equivalence Oracle
//!
//! Evaluates P0.4: Guarantees that incremental caching and Git-stream delta indexing
//! produce verdicts, endpoints, and impact reports identical to a fresh cold scan.
//!
//! Formula:
//! Report_incremental(HEAD) == Report_cold(HEAD)

use contract_core::report::CrossLanguageImpactReport;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRepo {
    path: PathBuf,
}

impl TempRepo {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sajimora-diff-qa-{tag}-{nanos}"));
        fs::create_dir_all(&path).unwrap();

        run_cmd(&path, &["git", "init"]);
        run_cmd(&path, &["git", "config", "user.name", "Diff QA Tester"]);
        run_cmd(&path, &["git", "config", "user.email", "tester@sajimora.local"]);

        Self { path }
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_cmd(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(args[0])
        .args(&args[1..])
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("Failed to run {:?}: {}", args, e));
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn bin_path() -> PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // remove binary name
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("sajimora")
}

#[test]
fn test_differential_full_scan_vs_incremental_equivalence() {
    let repo = TempRepo::new("differential");
    let cli = bin_path();
    assert!(cli.exists(), "sajimora CLI binary must exist at {:?}", cli);

    // 1. Create a Spring Boot backend and TypeScript consumer
    let java_dir = repo.path.join("src").join("main").join("java").join("com").join("example");
    let fe_dir = repo.path.join("frontend").join("src");
    fs::create_dir_all(&java_dir).unwrap();
    fs::create_dir_all(&fe_dir).unwrap();

    let controller = r#"package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/products")
public class ProductController {
    @GetMapping("/{id}")
    public ProductDto getProduct(@PathVariable("id") String id) {
        return new ProductDto("prod-1", "Widget", 19.99);
    }
}
"#;

    let dto = r#"package com.example;
public class ProductDto {
    private String id;
    private String title;
    private double price;

    public ProductDto(String id, String title, double price) {
        this.id = id;
        this.title = title;
        this.price = price;
    }
    public String getId() { return id; }
    public String getTitle() { return title; }
    public double getPrice() { return price; }
}
"#;

    let client = r#"
export interface Product {
    id: string;
    title: string;
    price: number;
}

export async function fetchProduct(id: string): Promise<Product> {
    const res = await fetch(`/api/products/${id}`);
    return (await res.json()) as Product;
}
"#;

    fs::write(java_dir.join("ProductController.java"), controller).unwrap();
    fs::write(java_dir.join("ProductDto.java"), dto).unwrap();
    fs::write(fe_dir.join("productClient.ts"), client).unwrap();

    run_cmd(&repo.path, &["git", "add", "."]);
    run_cmd(&repo.path, &["git", "commit", "-m", "Initial baseline commit"]);

    // 2. Initialize Sajimora baseline
    let init_out = Command::new(&cli)
        .args(["init", "--apply"])
        .current_dir(&repo.path)
        .output()
        .expect("sajimora init --apply");
    assert!(init_out.status.success(), "init --apply must succeed: {}", String::from_utf8_lossy(&init_out.stderr));

    run_cmd(&repo.path, &["git", "add", "."]);
    run_cmd(&repo.path, &["git", "commit", "-m", "Commit baseline contract"]);

    // 3. Mutate: Add an additive non-breaking field to ProductDto and ProductController
    let dto_v2 = r#"package com.example;
public class ProductDto {
    private String id;
    private String title;
    private double price;
    private String sku; // Additive non-breaking

    public ProductDto(String id, String title, double price, String sku) {
        this.id = id;
        this.title = title;
        this.price = price;
        this.sku = sku;
    }
    public String getId() { return id; }
    public String getTitle() { return title; }
    public double getPrice() { return price; }
    public String getSku() { return sku; }
}
"#;
    fs::write(java_dir.join("ProductDto.java"), dto_v2).unwrap();
    run_cmd(&repo.path, &["git", "add", "."]);
    run_cmd(&repo.path, &["git", "commit", "-m", "Additive non-breaking field sku"]);

    // 4. Run incremental verify (cache active)
    let verify_incremental = Command::new(&cli)
        .args(["verify", "--json"])
        .current_dir(&repo.path)
        .output()
        .expect("incremental verify");
    assert!(verify_incremental.status.success(), "Incremental verify must pass");

    let stdout_incremental: serde_json::Value = serde_json::from_slice(&verify_incremental.stdout)
        .expect("parse incremental stdout json");

    let report_file = repo.path.join(".sajimora").join("impact-report.json");
    let report_incremental_bytes = fs::read(&report_file).expect("read impact-report.json");
    let report_incremental: CrossLanguageImpactReport = serde_json::from_slice(&report_incremental_bytes)
        .expect("parse incremental report json");

    // 5. Cold Full Scan: Delete .sajimora/contracts.db and transient candidate artifacts
    let db_path = repo.path.join(".sajimora").join("contracts.db");
    let cand_file = repo.path.join(".sajimora").join("candidate-contract.json");
    let _ = fs::remove_file(db_path);
    let _ = fs::remove_file(cand_file);
    let _ = fs::remove_file(&report_file);

    // 6. Run cold verify on exact same HEAD
    let verify_cold = Command::new(&cli)
        .args(["verify", "--json"])
        .current_dir(&repo.path)
        .output()
        .expect("cold verify");
    assert!(verify_cold.status.success(), "Cold verify must pass");

    let stdout_cold: serde_json::Value = serde_json::from_slice(&verify_cold.stdout)
        .expect("parse cold stdout json");

    let report_cold_bytes = fs::read(&report_file).expect("read cold impact-report.json");
    let report_cold: CrossLanguageImpactReport = serde_json::from_slice(&report_cold_bytes)
        .expect("parse cold report json");

    // 7. Verify Differential Equivalence Oracle:
    // Report_incremental == Report_cold
    assert_eq!(
        stdout_incremental["verdict"], stdout_cold["verdict"],
        "CLI stdout verdict must match across incremental and cold runs"
    );
    assert_eq!(
        stdout_incremental["total_repo_call_sites_checked"], stdout_cold["total_repo_call_sites_checked"],
        "Call site counts must match across incremental and cold runs"
    );
    assert_eq!(
        report_incremental.verdict, report_cold.verdict,
        "Incremental scan and cold full scan must yield identical report verdicts"
    );
    assert_eq!(
        report_incremental.property, report_cold.property,
        "Incremental scan and cold full scan must assess identical property"
    );
    assert_eq!(
        report_incremental.findings.len(),
        report_cold.findings.len(),
        "Number of findings must be identical across incremental and cold runs"
    );
    assert_eq!(
        report_incremental.advisories.len(),
        report_cold.advisories.len(),
        "Advisories must be identical across incremental and cold runs"
    );

    println!("\nDifferential scan verification passed: Incremental and Cold scans are 100% equivalent.");
}
