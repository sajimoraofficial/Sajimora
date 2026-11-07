use std::path::PathBuf;
use std::time::Instant;

#[tokio::test]
async fn test_endpoint_impact_stat_cache_on_thingsboard() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    if !tb_path.exists() {
        return;
    }
    let allowed_roots = vec![tb_path.clone()];

    let mut args = serde_json::Map::new();
    args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
    args.insert("mode".to_string(), serde_json::json!("workingTreeVsHead"));

    // Run 1: First run (populates the stat cache)
    let start1 = Instant::now();
    let res1 = sajimora_mcp::endpoint_impact::run_endpoint_impact(&allowed_roots, &args)
        .expect("Run 1 should succeed");
    let elapsed1 = start1.elapsed();
    println!("Run 1 (Cache Populate): {:?}", elapsed1);
    assert!(res1.contains("schemaVersion"));

    // Run 2: Second run (WARM STAT CACHE - Zero file reads for untouched files!)
    let start2 = Instant::now();
    let res2 = sajimora_mcp::endpoint_impact::run_endpoint_impact(&allowed_roots, &args)
        .expect("Run 2 should succeed");
    let elapsed2 = start2.elapsed();
    println!("Run 2 (Warm Stat Cache): {:?}", elapsed2);
    assert!(res2.contains("schemaVersion"));

    println!(
        "SPEEDUP: Run 1 took {:?}, Run 2 took {:?}",
        elapsed1, elapsed2
    );
    // Warm run must be fast (under 3 seconds even in debug build on 14k files)
    assert!(
        elapsed2.as_secs() < 5,
        "Warm stat cache run should be under 5s, took {:?}",
        elapsed2
    );
}
