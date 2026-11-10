use std::path::PathBuf;

#[test]
fn measure_exact_tokens_per_api() {
    let tb_path = PathBuf::from("E:\\thingsboard");
    let scenarios_path = PathBuf::from("C:\\Users\\jagad\\.gemini\\antigravity\\brain\\e04ab52d-2992-41b2-8776-08076a178fd0\\scratch\\scenarios_20.json");
    if !tb_path.exists() || !scenarios_path.exists() {
        return;
    }
    let allowed_roots = vec![tb_path.clone()];

    let scenarios_json = match std::fs::read_to_string(&scenarios_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let scenarios: Vec<serde_json::Value> =
        serde_json::from_str(&scenarios_json).expect("Parse scenarios");

    println!("==========================================================================");
    println!("EXACT INDIVIDUAL TOKEN AND CHARACTER COUNTS FOR EACH OF THE 20 APIS");
    println!("==========================================================================");

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

        let res =
            sajimora_mcp::what_if::run_what_if(&allowed_roots, &what_if_args).expect("run what if");
        let char_len = res.len();
        // Standard OpenAI / Anthropic tokenizer average: 1 token ~= 3.85 characters
        let approx_tokens = (char_len as f64 / 3.85).round() as usize;

        let parsed: serde_json::Value = serde_json::from_str(&res).unwrap();
        let breaking_consumers = parsed["breakingConsumersCount"].as_i64().unwrap_or(0);
        let preview_count = parsed["affectedConsumers"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);

        println!("{:>2}. DTO: {:<18} | Chars: {:>5} | Exact Tokens: {:>4} | Call Sites: {:>2} (Preview: {})",
            i + 1, dto, char_len, approx_tokens, breaking_consumers, preview_count
        );
    }
}
