use std::path::PathBuf;
use std::process::Command;

#[test]
#[ignore = "Requires local ThingsBoard repository corpus"]
fn test_cli_query_and_what_if_on_thingsboard() {
    let tb_path = std::env::var("THINGSBOARD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("E:\\thingsboard"));
    if !tb_path.exists() {
        return;
    }

    let bin_path = env!("CARGO_BIN_EXE_sajimora");

    // 1. Test sajimora query --stats --json
    let stats_output = Command::new(bin_path)
        .arg("query")
        .arg("--repo")
        .arg(&tb_path)
        .arg("--stats")
        .arg("--json")
        .output()
        .expect("sajimora query --stats should execute");

    assert!(stats_output.status.success());
    let stdout_str = String::from_utf8_lossy(&stats_output.stdout);
    assert!(stdout_str.contains("backendEndpoints"));
    assert!(stdout_str.contains("1526"));

    // 2. Test sajimora query --route "/api/user/*"
    let route_output = Command::new(bin_path)
        .arg("query")
        .arg("--repo")
        .arg(&tb_path)
        .arg("--route")
        .arg("/api/user/*")
        .arg("--json")
        .output()
        .expect("sajimora query --route should execute");

    assert!(route_output.status.success());
    let route_str = String::from_utf8_lossy(&route_output.stdout);
    assert!(route_str.contains("user.service.ts"));

    // 3. Test sajimora what-if --type User --field firstName --new-name givenName
    let what_if_output = Command::new(bin_path)
        .arg("what-if")
        .arg("--repo")
        .arg(&tb_path)
        .arg("--type")
        .arg("User")
        .arg("--field")
        .arg("firstName")
        .arg("--new-name")
        .arg("givenName")
        .arg("--json")
        .output()
        .expect("sajimora what-if should execute");

    assert!(what_if_output.status.success());
    let what_if_str = String::from_utf8_lossy(&what_if_output.stdout);
    assert!(what_if_str.contains("BREAKING_CHANGE"));
    assert!(what_if_str.contains("@JsonProperty(\\\"firstName\\\")"));
}
