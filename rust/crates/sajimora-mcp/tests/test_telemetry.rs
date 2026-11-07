use std::path::PathBuf;

#[test]
fn print_sample_telemetry() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    let allowed_roots = vec![tb_path.clone()];

    let mut what_if_args = serde_json::Map::new();
    what_if_args.insert("repoRoot".to_string(), serde_json::json!("E:\\thingsboard"));
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
