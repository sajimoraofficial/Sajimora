use std::path::PathBuf;

#[test]
#[ignore = "Requires local ThingsBoard repository corpus"]
fn print_sample_telemetry() {
    let tb_path = std::env::var("THINGSBOARD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("E:\\thingsboard"));
    if !tb_path.exists() {
        return;
    }
    let allowed_roots = vec![tb_path.clone()];
    let tb_str = tb_path.to_string_lossy().to_string();

    let mut what_if_args = serde_json::Map::new();
    what_if_args.insert("repoRoot".to_string(), serde_json::json!(tb_str));
    what_if_args.insert(
        "mutation".to_string(),
        serde_json::json!({
            "action": "RENAME_FIELD",
            "targetDto": "RuleChain",
            "field": "name",
            "renameTo": "renamed_name",
            "jsonPropertyRetained": false
        }),
    );

    let res =
        sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_args).expect("run what if");
    let parsed: serde_json::Value = serde_json::from_str(&res).unwrap();
    println!("TELEMETRY PAYLOAD:");
    println!(
        "{}",
        serde_json::to_string_pretty(&parsed["telemetry"]).unwrap()
    );
}
