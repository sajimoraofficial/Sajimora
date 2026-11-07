use std::path::PathBuf;
use std::time::Instant;

#[tokio::test]
async fn test_20_api_changes_benchmark() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    if !tb_path.exists() {
        return;
    }
    let allowed_roots = vec![tb_path.clone()];

    let scenarios_json = std::fs::read_to_string("C:\\Users\\jagad\\.gemini\\antigravity\\brain\\e04ab52d-2992-41b2-8776-08076a178fd0\\scratch\\scenarios_20.json")
        .expect("Read scenarios");
    let scenarios: Vec<serde_json::Value> =
        serde_json::from_str(&scenarios_json).expect("Parse scenarios");

    println!("==================================================");
    println!("RUNNING 20 API CHANGES WITH SAJIMORA WHAT-IF");
    println!("==================================================");

    let start_all = Instant::now();
    let mut total_latency_micros: u128 = 0;
    let mut total_breaking = 0;
    let mut total_output_chars = 0;

    for (i, sc) in scenarios.iter().enumerate() {
        let dto = sc["dto"].as_str().unwrap();
        let old_f = sc["old_field"].as_str().unwrap();
        let new_f = sc["new_field"].as_str().unwrap();

        let mut what_if_args = serde_json::Map::new();
        what_if_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
        what_if_args.insert(
            "mutation".to_string(),
            serde_json::json!({
                "action": "RENAME_FIELD",
                "targetDto": dto,
                "field": old_f,
                "renameTo": new_f,
                "jsonPropertyRetained": false
            }),
        );

        let t0 = Instant::now();
        let res =
            sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_args).expect("run what if");
        let elapsed_us = t0.elapsed().as_micros();
        total_latency_micros += elapsed_us;
        total_output_chars += res.len();

        let parsed: serde_json::Value = serde_json::from_str(&res).unwrap();
        let breaking_count = parsed
            .get("breakingConsumersCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let verdict = parsed
            .get("verdict")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");
        total_breaking += breaking_count;

        println!("{}. DTO: {:<18} Field: {:<15} -> Latency: {:>5} us ({:.2} ms) | Verdict: {} (Breaking: {})",
            i + 1, dto, old_f, elapsed_us, elapsed_us as f64 / 1000.0, verdict, breaking_count
        );
    }

    let total_wall_clock = start_all.elapsed();
    println!("--------------------------------------------------");
    println!("SAJIMORA TOTALS FOR 20 API CHANGES:");
    println!(
        "Total Wall-Clock Time : {:.2} ms ({:?})",
        total_wall_clock.as_micros() as f64 / 1000.0,
        total_wall_clock
    );
    println!(
        "Sum of Query Latencies: {:.2} ms (Avg: {:.2} ms per API change)",
        total_latency_micros as f64 / 1000.0,
        (total_latency_micros as f64 / 20.0) / 1000.0
    );
    println!("Total Breaking Call Sites Flagged: {}", total_breaking);
    println!(
        "Total JSON Output Chars: {} (approx {} tokens)",
        total_output_chars,
        total_output_chars / 4
    );
    println!("==================================================");
}
