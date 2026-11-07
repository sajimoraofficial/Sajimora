//! dashboard.rs — Native terminal & web contract health dashboard.
//!
//! Run anywhere in the repository:
//!   sajimora dashboard         (displays terminal dashboard)
//!   sajimora dashboard --web   (opens interactive HTML dashboard in browser)

use anyhow::{anyhow, Result};
use clap::Args;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Args, Debug)]
pub struct DashboardArgs {
    /// Path to the repository root or subproject. Defaults to auto-detecting .sajimora.
    #[arg(long, default_value = ".")]
    pub repo: PathBuf,

    /// Open interactive web dashboard in the default browser.
    #[arg(long, short = 'w')]
    pub web: bool,

    /// Export static HTML dashboard to specified path without launching browser.
    #[arg(long)]
    pub html_out: Option<PathBuf>,
}

pub fn run(args: DashboardArgs) -> i32 {
    match run_inner(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("\n❌ Dashboard error: {}\n", e);
            1
        }
    }
}

#[derive(Debug, Clone)]
struct DashboardData {
    repo_name: String,
    backend_service_id: String,
    frontend_service_id: String,
    backend_endpoints_count: usize,
    backend_dtos_count: usize,
    resolved_endpoints_count: usize,
    partial_endpoints_count: usize,
    unresolved_endpoints_count: usize,
    frontend_contracts_count: usize,
    verdict: String,
    findings_count: usize,
    affected_call_sites: usize,
    changed_endpoints_count: usize,
    telemetry_active: bool,
    telemetry_window: Option<String>,
    telemetry_spans_count: usize,
    jacoco_active: bool,
    jacoco_classes_count: usize,
    contract_tests_count: usize,
    advisory_tests_count: usize,
    abstain_tests_count: usize,
    findings: Vec<FindingItem>,
    backend_endpoints: Vec<EndpointItem>,
    frontend_contracts: Vec<ClientContractItem>,
}

#[derive(Debug, Clone)]
struct FindingItem {
    method: String,
    path: String,
    wire_path: String,
    before: String,
    after: String,
    ts_file: String,
    ts_line: usize,
    usage: String,
    repair_hint: String,
}

#[derive(Debug, Clone)]
struct EndpointItem {
    method: String,
    path: String,
    java_file: String,
    has_body: bool,
    status: String,
}

#[derive(Debug, Clone)]
struct ClientContractItem {
    method: String,
    route: String,
    client_file: String,
    client_line: usize,
    usage: String,
}

fn run_inner(args: DashboardArgs) -> Result<i32> {
    let current_dir = std::env::current_dir()?;
    let repo_start = if args.repo.is_relative() {
        current_dir.join(&args.repo)
    } else {
        args.repo.clone()
    };

    let (repo_root, sajimora_dir) = find_sajimora_dir(&repo_start).ok_or_else(|| {
        anyhow!("Could not find `.sajimora` directory. Run `sajimora init` first.")
    })?;

    let data = load_dashboard_data(&repo_root, &sajimora_dir)?;

    // 1. Render Terminal Dashboard
    render_terminal_dashboard(&data);

    // 2. Render Web Dashboard if requested
    if args.web || args.html_out.is_some() {
        let html_content = generate_html_dashboard(&data);
        let out_path = args
            .html_out
            .unwrap_or_else(|| sajimora_dir.join("dashboard.html"));
        fs::write(&out_path, html_content)?;
        println!("📄 HTML dashboard generated at: {:?}", out_path);

        if args.web {
            println!("🌐 Opening dashboard in your default browser...");
            open_in_browser(&out_path);
        }
    }

    Ok(0)
}

fn is_partial_wire_type(val: &Value) -> bool {
    if let Some(kind) = val.get("kind").and_then(|k| k.as_str()) {
        if kind == "UNKNOWN" {
            return true;
        }
    }
    if let Some(props) = val.get("properties").and_then(|p| p.as_array()) {
        for p in props {
            if let Some(t) = p.get("type") {
                if is_partial_wire_type(t) {
                    return true;
                }
            }
        }
    }
    if let Some(elem) = val.get("elementType") {
        if is_partial_wire_type(elem) {
            return true;
        }
    }
    false
}

fn load_dashboard_data(repo_root: &Path, sajimora_dir: &Path) -> Result<DashboardData> {
    let repo_name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repository")
        .to_string();

    let manifest_path = sajimora_dir.join("init-manifest.json");
    let mut backend_service_id = "backend".to_string();
    let mut frontend_service_id = "frontend".to_string();

    if let Ok(m_bytes) = fs::read(&manifest_path) {
        if let Ok(val) = serde_json::from_slice::<Value>(&m_bytes) {
            if let Some(sid) = val
                .get("roots")
                .and_then(|r| r.get("service_id"))
                .and_then(|s| s.as_str())
            {
                backend_service_id = sid.to_string();
            }
            if let Some(froot) = val
                .get("roots")
                .and_then(|r| r.get("frontend_root"))
                .and_then(|f| f.as_str())
            {
                if !froot.is_empty() {
                    frontend_service_id = froot.to_string();
                }
            }
        }
    }

    // Backend Contract
    let backend_file = sajimora_dir.join("backend-contract.json");
    let mut backend_endpoints_count = 0;
    let mut backend_dtos_count = 0;
    let mut resolved_endpoints_count = 0;
    let mut partial_endpoints_count = 0;
    let mut unresolved_endpoints_count = 0;
    let mut backend_endpoints = Vec::new();

    if let Ok(b_bytes) = fs::read(&backend_file) {
        if let Ok(val) = serde_json::from_slice::<Value>(&b_bytes) {
            if let Some(payload) = val.get("payload") {
                if let Some(eps) = payload.get("endpoints").and_then(|e| e.as_array()) {
                    backend_endpoints_count = eps.len();
                    for ep in eps {
                        let method = ep
                            .get("identity")
                            .and_then(|i| i.get("httpMethod"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("GET")
                            .to_string();
                        let path = ep
                            .get("identity")
                            .and_then(|i| i.get("normalizedRoute"))
                            .and_then(|r| r.get("rawPath"))
                            .and_then(|p| p.as_str())
                            .unwrap_or("/")
                            .to_string();
                        let java_file = ep
                            .get("provenance")
                            .and_then(|p| p.get("file"))
                            .and_then(|f| f.as_str())
                            .unwrap_or("Controller.java")
                            .to_string();
                        let body_val = ep.get("body");
                        let has_body = body_val.is_some() && !body_val.unwrap().is_null();

                        let status = match body_val {
                            Some(b)
                                if b.get("kind").and_then(|k| k.as_str()) == Some("UNKNOWN") =>
                            {
                                unresolved_endpoints_count += 1;
                                "UNRESOLVED".to_string()
                            }
                            Some(b) if is_partial_wire_type(b) => {
                                partial_endpoints_count += 1;
                                "PARTIAL".to_string()
                            }
                            _ => {
                                resolved_endpoints_count += 1;
                                "RESOLVED".to_string()
                            }
                        };

                        backend_endpoints.push(EndpointItem {
                            method,
                            path,
                            java_file,
                            has_body,
                            status,
                        });
                    }
                }
                if let Some(pool) = payload.get("type_pool").and_then(|p| p.as_object()) {
                    backend_dtos_count = pool.len();
                }
            }
        }
    }

    // Frontend Contract
    let frontend_file = sajimora_dir.join("frontend-contract.json");
    let mut frontend_contracts_count = 0;
    let mut frontend_contracts = Vec::new();

    if let Ok(f_bytes) = fs::read(&frontend_file) {
        if let Ok(val) = serde_json::from_slice::<Value>(&f_bytes) {
            if let Some(payload) = val.get("payload") {
                if let Some(clients) = payload.get("clientContracts").and_then(|c| c.as_array()) {
                    frontend_contracts_count = clients.len();
                    for c in clients {
                        let method = c
                            .get("httpMethod")
                            .or_else(|| c.get("method"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("GET")
                            .to_string();
                        let route = c
                            .get("normalizedRoute")
                            .and_then(|r| r.as_str())
                            .or_else(|| {
                                c.get("routeDomain")
                                    .and_then(|rd| rd.get("alternatives"))
                                    .and_then(|a| a.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|alt| alt.get("path"))
                                    .and_then(|p| p.as_str())
                            })
                            .unwrap_or("/")
                            .to_string();
                        let client_file = c
                            .get("sourceFile")
                            .or_else(|| c.get("provenance").and_then(|p| p.get("file")))
                            .and_then(|f| f.as_str())
                            .unwrap_or("api.ts")
                            .to_string();
                        let client_line = c
                            .get("sourceLine")
                            .or_else(|| c.get("provenance").and_then(|p| p.get("line")))
                            .and_then(|l| l.as_u64())
                            .unwrap_or(1) as usize;
                        let usage = c
                            .get("consumers")
                            .and_then(|cons| cons.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|u| u.get("usage"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();

                        frontend_contracts.push(ClientContractItem {
                            method,
                            route,
                            client_file,
                            client_line,
                            usage,
                        });
                    }
                }
            }
        }
    }

    // Impact Report
    let report_file = sajimora_dir.join("impact-report.json");
    let mut verdict = "UNKNOWN".to_string();
    let mut findings_count = 0;
    let mut affected_call_sites = 0;
    let mut changed_endpoints_count = 0;
    let mut findings = Vec::new();

    if let Ok(r_bytes) = fs::read(&report_file) {
        if let Ok(val) = serde_json::from_slice::<Value>(&r_bytes) {
            if let Some(v) = val.get("verdict").and_then(|s| s.as_str()) {
                verdict = v.to_string();
            }
            if let Some(counts) = val.get("counts") {
                affected_call_sites = counts
                    .get("affectedConsumers")
                    .and_then(|c| c.as_u64())
                    .unwrap_or(0) as usize;
                changed_endpoints_count = counts
                    .get("changedEndpoints")
                    .and_then(|e| e.as_u64())
                    .unwrap_or(0) as usize;
            }
            if let Some(raw_findings) = val.get("findings").and_then(|f| f.as_array()) {
                for f in raw_findings {
                    let method = f
                        .get("endpoint")
                        .and_then(|e| e.get("method"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let path = f
                        .get("endpoint")
                        .and_then(|e| e.get("path"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let wire_path = f
                        .get("wirePath")
                        .and_then(|w| w.as_str())
                        .unwrap_or("")
                        .to_string();
                    let before = f
                        .get("change")
                        .and_then(|c| c.get("before"))
                        .and_then(|b| b.as_str())
                        .unwrap_or("")
                        .to_string();
                    let after = f
                        .get("change")
                        .and_then(|c| c.get("after"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("")
                        .to_string();
                    let ts_file = f
                        .get("typescriptClient")
                        .and_then(|t| t.get("file"))
                        .and_then(|f| f.as_str())
                        .unwrap_or("")
                        .to_string();
                    let ts_line = f
                        .get("typescriptClient")
                        .and_then(|t| t.get("line"))
                        .and_then(|l| l.as_u64())
                        .unwrap_or(0) as usize;
                    let repair_hint = f
                        .get("repairHint")
                        .and_then(|r| r.as_str())
                        .unwrap_or("")
                        .to_string();
                    let usage = f
                        .get("consumers")
                        .and_then(|c| c.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|first| first.get("usage"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();

                    findings.push(FindingItem {
                        method,
                        path,
                        wire_path,
                        before,
                        after,
                        ts_file,
                        ts_line,
                        usage,
                        repair_hint,
                    });
                }
            }
            findings_count = findings.len();
        }
    }

    // Telemetry & Coverage status
    let telemetry_file = sajimora_dir.join("telemetry.json");
    let mut telemetry_active = false;
    let mut telemetry_window = None;
    let mut telemetry_spans_count = 0;
    let mut jacoco_active = false;
    let mut jacoco_classes_count = 0;

    if let Ok(t_bytes) = fs::read(&telemetry_file) {
        if let Ok(val) = serde_json::from_slice::<Value>(&t_bytes) {
            telemetry_active = true;
            if let (Some(start), Some(end)) = (
                val.get("windowStart").and_then(|s| s.as_str()),
                val.get("windowEnd").and_then(|e| e.as_str()),
            ) {
                telemetry_window = Some(format!("{} to {}", start, end));
            }
            if let Some(spans) = val.get("spanSummaries").and_then(|s| s.as_array()) {
                telemetry_spans_count = spans.len();
            }
            if let Some(cov) = val.get("coverage").and_then(|c| c.as_object()) {
                if !cov.is_empty() {
                    jacoco_active = true;
                    jacoco_classes_count = cov.len();
                }
            }
        }
    }

    let jacoco_file = sajimora_dir.join("jacoco-coverage.json");
    if !jacoco_active && jacoco_file.exists() {
        jacoco_active = true;
    }

    // Inspect generated test metrics from disk if available
    let test_java_path = repo_root.join("src/test/java/ContractPropertyTest.java");
    let mut contract_tests_count = 0;
    let mut advisory_tests_count = 0;
    let mut abstain_tests_count = 0;

    if let Ok(test_content) = fs::read_to_string(&test_java_path) {
        for line in test_content.lines() {
            if line.contains("[CONTRACT_TEST]") {
                contract_tests_count += 1;
            } else if line.contains("[ADVISORY_FALLBACK_TEST]") {
                advisory_tests_count += 1;
            } else if line.contains("// ABSTAIN:") {
                abstain_tests_count += 1;
            }
        }
    } else {
        // Fallback calculation based on static analysis status
        contract_tests_count = resolved_endpoints_count;
        advisory_tests_count = partial_endpoints_count;
        abstain_tests_count = unresolved_endpoints_count;
    }

    Ok(DashboardData {
        repo_name,
        backend_service_id,
        frontend_service_id,
        backend_endpoints_count,
        backend_dtos_count,
        resolved_endpoints_count,
        partial_endpoints_count,
        unresolved_endpoints_count,
        frontend_contracts_count,
        verdict,
        findings_count,
        affected_call_sites,
        changed_endpoints_count,
        telemetry_active,
        telemetry_window,
        telemetry_spans_count,
        jacoco_active,
        jacoco_classes_count,
        contract_tests_count,
        advisory_tests_count,
        abstain_tests_count,
        findings,
        backend_endpoints,
        frontend_contracts,
    })
}

fn render_terminal_dashboard(data: &DashboardData) {
    println!(
        "\n╔══════════════════════════════════════════════════════════════════════════════════╗"
    );
    println!(
        "║                       SAJIMORA CONTRACT HEALTH DASHBOARD                         ║"
    );
    println!(
        "║  Repository: {:<25}  Service: {:<18}  v0.1.0   ║",
        data.repo_name, data.backend_service_id
    );
    println!(
        "╚══════════════════════════════════════════════════════════════════════════════════╝\n"
    );

    println!("📊 ARCHITECTURE TOPOLOGY");
    println!(
        "   Backend Service  : {} (Spring Boot)",
        data.backend_service_id
    );
    println!("                      ├── Tracked Endpoints : {} REST routes ({} resolved, {} partial, {} unresolved)",
        data.backend_endpoints_count, data.resolved_endpoints_count, data.partial_endpoints_count, data.unresolved_endpoints_count);
    println!(
        "                      └── Interned DTOs     : {} schemas",
        data.backend_dtos_count
    );
    println!(
        "   Frontend Service : {} (TypeScript / React)",
        data.frontend_service_id
    );
    println!(
        "                      └── Mapped Call Sites : {} active client contracts\n",
        data.frontend_contracts_count
    );

    println!("🛡️ CONTRACT COMPATIBILITY STATUS");
    match data.verdict.as_str() {
        "LIKELY_VIOLATED" => {
            println!("   Verdict          : ❌ LIKELY VIOLATED (Breaking Changes Detected!)");
            println!("   Total Findings   : {}", data.findings_count);
            println!(
                "   Affected Calls   : {} client call sites impacted",
                data.affected_call_sites
            );
            println!("   Changed Routes   : {}", data.changed_endpoints_count);
        }
        "LIKELY_PRESERVED" => {
            println!("   Verdict          : ✅ LIKELY PRESERVED (Contracts Clean)");
            println!("   Total Findings   : 0 issues");
            println!(
                "   Health           : 0 breaking findings across {} linked client contracts",
                data.frontend_contracts_count
            );
        }
        "INCONCLUSIVE" => {
            println!("   Verdict          : ⚠️ INCONCLUSIVE (Static Proof Incomplete)");
            println!("   Note             : Telemetry or dynamic route qualification required");
        }
        _ => {
            println!("   Verdict          : ℹ️ UNVERIFIED (Run `sajimora verify` to check)");
        }
    }

    println!("\n🧪 TEST SYNTHESIS COVERAGE");
    println!(
        "   Contract Tests   : {} verified contracts [CONTRACT_TEST]",
        data.contract_tests_count
    );
    println!(
        "   Fallback Tests   : {} advisory assertions [ADVISORY_FALLBACK_TEST]",
        data.advisory_tests_count
    );
    println!(
        "   Abstentions      : {} honest unknown bounds",
        data.abstain_tests_count
    );

    println!("\n📡 TELEMETRY & TEST COVERAGE");
    if data.telemetry_active {
        let win = data.telemetry_window.as_deref().unwrap_or("active");
        if data.telemetry_spans_count > 0 {
            println!(
                "   Sealed Telemetry : 🟢 Active ({} spans observed, {})",
                data.telemetry_spans_count, win
            );
        } else {
            println!("   Sealed Telemetry : 🟢 Active ({})", win);
        }
    } else {
        println!("   Sealed Telemetry : ⚪ Not configured (run `sajimora build-telemetry`)");
    }
    if data.jacoco_active {
        if data.jacoco_classes_count > 0 {
            println!(
                "   JaCoCo Coverage  : 🟢 Ingested ({} classes tracked)",
                data.jacoco_classes_count
            );
        } else {
            println!("   JaCoCo Coverage  : 🟢 Ingested (.sajimora/jacoco-coverage.json)");
        }
    } else {
        println!("   JaCoCo Coverage  : ⚪ Not configured");
    }

    if !data.findings.is_empty() {
        println!("\n🚨 TOP BREAKING FINDINGS (Grouped Sample):");
        struct Group {
            file: String,
            line: usize,
            endpoint: String,
            call: String,
            issues: Vec<(String, String, String, String)>,
        }
        let mut group_order = Vec::new();
        let mut map: std::collections::BTreeMap<String, Group> = std::collections::BTreeMap::new();
        for f in &data.findings {
            let key = format!("{}:{}", f.ts_file, f.ts_line);
            if !map.contains_key(&key) {
                group_order.push(key.clone());
                map.insert(
                    key.clone(),
                    Group {
                        file: f.ts_file.clone(),
                        line: f.ts_line,
                        endpoint: format!("{} {}", f.method, f.path),
                        call: f.usage.clone(),
                        issues: Vec::new(),
                    },
                );
            }
            if let Some(g) = map.get_mut(&key) {
                g.issues.push((
                    f.wire_path.clone(),
                    f.before.clone(),
                    f.after.clone(),
                    f.repair_hint.clone(),
                ));
            }
        }

        let mut count = 0;
        for key in group_order.iter().take(3) {
            if let Some(g) = map.get(key) {
                count += 1;
                println!("   {}. {}:{} [{}]", count, g.file, g.line, g.endpoint);
                if !g.call.is_empty() {
                    println!("      Call   : {}", g.call);
                }
                println!("      Issues :");
                for (wire, before, after, fix) in &g.issues {
                    if wire.is_empty() || wire == "$" {
                        println!("        • Type shift : {} -> {}", before, after);
                    } else {
                        println!("        • Field `{}` : {} -> {}", wire, before, after);
                    }
                    if !fix.is_empty() {
                        println!("          Fix : {}", fix);
                    }
                }
                println!();
            }
        }
        if map.len() > count {
            println!(
                "   ... and {} more affected files ({} total findings across {} call sites).\n",
                map.len() - count,
                data.findings.len(),
                data.affected_call_sites
            );
        }
    }

    println!("⌨️  QUICK ACTIONS");
    println!("   • Run contract verification:  sajimora verify");
    println!("   • Synthesize property tests:  sajimora generate-tests");
    println!("   • Update baseline contract:   sajimora init --apply --force");
    println!("   • Open visual web dashboard:  sajimora dashboard --web\n");
}

fn generate_html_dashboard(data: &DashboardData) -> String {
    let verdict_color = match data.verdict.as_str() {
        "LIKELY_PRESERVED" => "#10B981",
        "LIKELY_VIOLATED" => "#F43F5E",
        "INCONCLUSIVE" => "#F59E0B",
        _ => "#6B7280",
    };

    let verdict_badge = match data.verdict.as_str() {
        "LIKELY_PRESERVED" => "✅ LIKELY PRESERVED",
        "LIKELY_VIOLATED" => "❌ LIKELY VIOLATED",
        "INCONCLUSIVE" => "⚠️ INCONCLUSIVE",
        _ => "ℹ️ UNVERIFIED",
    };

    let (telemetry_status, telemetry_color) = if data.telemetry_active {
        let spans_str = if data.telemetry_spans_count > 0 {
            format!("{} traces", data.telemetry_spans_count)
        } else {
            "Active".to_string()
        };
        let cov_str = if data.jacoco_classes_count > 0 {
            format!("{} classes", data.jacoco_classes_count)
        } else {
            "No coverage".to_string()
        };
        (format!("🟢 {} &bull; {}", spans_str, cov_str), "#10B981")
    } else {
        ("⚪ Not configured".to_string(), "#9CA3AF")
    };

    let mut findings_rows = String::new();
    if data.findings.is_empty() {
        findings_rows.push_str(
            r#"<tr>
                <td colspan="6" style="text-align:center;padding:48px 24px;color:#94a3b8">
                    <div style="font-size:32px;margin-bottom:8px">🎉</div>
                    <div style="font-size:16px;font-weight:700;color:#10b981;margin-bottom:4px">No Breaking Changes Detected</div>
                    <div style="font-size:13px;color:#64748b">All frontend client contracts match backend API schemas with zero breaking discrepancies.</div>
                </td>
            </tr>"#,
        );
    } else {
        for (i, f) in data.findings.iter().enumerate() {
            findings_rows.push_str(&format!(
                r#"<tr>
                    <td style="color:#64748b;font-weight:600">{idx}</td>
                    <td><span class="badge {method_lower}">{method}</span> <code class="route-code">{path}</code></td>
                    <td><code style="color:#f43f5e;font-weight:600">{wire_path}</code></td>
                    <td><span class="diff-before">{before}</span> &rarr; <span class="diff-after">{after}</span></td>
                    <td><span class="file-link">{ts_file}:{ts_line}</span></td>
                    <td style="color:#94a3b8;font-size:12px">{repair}</td>
                </tr>"#,
                idx = i + 1,
                method_lower = f.method.to_lowercase(),
                method = f.method,
                path = html_escape(&f.path),
                wire_path = html_escape(&f.wire_path),
                before = html_escape(&f.before),
                after = html_escape(&f.after),
                ts_file = html_escape(&f.ts_file),
                ts_line = f.ts_line,
                repair = html_escape(&f.repair_hint),
            ));
        }
    }

    let mut endpoint_rows = String::new();
    for ep in &data.backend_endpoints {
        let (status_class, status_label) = match ep.status.as_str() {
            "RESOLVED" => ("status-resolved", "RESOLVED"),
            "PARTIAL" => ("status-partial", "PARTIAL"),
            _ => ("status-unresolved", "UNRESOLVED"),
        };

        endpoint_rows.push_str(&format!(
            r#"<tr data-route="{path}">
                <td><span class="badge {method_lower}">{method}</span></td>
                <td><code class="route-code">{path}</code></td>
                <td><span class="status-pill {status_class}">{status_label}</span></td>
                <td style="color:#94a3b8;font-size:13px">{file}</td>
                <td>{body_status}</td>
            </tr>"#,
            method_lower = ep.method.to_lowercase(),
            method = ep.method,
            path = html_escape(&ep.path),
            status_class = status_class,
            status_label = status_label,
            file = html_escape(&ep.java_file),
            body_status = if ep.has_body {
                "<span style='color:#38bdf8'>Payload DTO</span>"
            } else {
                "<span style='color:#64748b'>Void</span>"
            }
        ));
    }

    let mut client_rows = String::new();
    for c in &data.frontend_contracts {
        client_rows.push_str(&format!(
            r#"<tr data-route="{route}">
                <td><span class="badge {method_lower}">{method}</span></td>
                <td><code class="route-code">{route}</code></td>
                <td><span class="file-link">{file}:{line}</span></td>
                <td style="color:#cbd5e1;font-size:12px;font-family:monospace">{usage}</td>
            </tr>"#,
            method_lower = c.method.to_lowercase(),
            method = c.method,
            route = html_escape(&c.route),
            file = html_escape(&c.client_file),
            line = c.client_line,
            usage = html_escape(&c.usage),
        ));
    }

    // Build interactive topology cards
    let mut topology_cards = String::new();
    let mut matched_pairs_count = 0;
    for ep in &data.backend_endpoints {
        // Find matching frontend clients
        let ep_clean_route = ep.path.trim_end_matches('/');
        let matching_clients: Vec<&ClientContractItem> = data
            .frontend_contracts
            .iter()
            .filter(|c| {
                let c_clean = c.route.trim_end_matches('/');
                c_clean == ep_clean_route
                    || c_clean.ends_with(ep_clean_route)
                    || ep_clean_route.ends_with(c_clean)
            })
            .collect();

        if !matching_clients.is_empty() {
            matched_pairs_count += 1;
        }

        let mut client_links_html = String::new();
        if matching_clients.is_empty() {
            client_links_html
                .push_str("<div class='topo-client-none'>No active frontend consumers</div>");
        } else {
            for mc in matching_clients {
                client_links_html.push_str(&format!(
                    r#"<div class="topo-client-item">
                        <span class="badge {c_method_lower}">{c_method}</span>
                        <span class="file-link">{file}:{line}</span>
                        <span class="topo-usage">{usage}</span>
                    </div>"#,
                    c_method_lower = mc.method.to_lowercase(),
                    c_method = mc.method,
                    file = html_escape(&mc.client_file),
                    line = mc.client_line,
                    usage = html_escape(&mc.usage),
                ));
            }
        }

        let (status_class, status_label) = match ep.status.as_str() {
            "RESOLVED" => ("status-resolved", "RESOLVED"),
            "PARTIAL" => ("status-partial", "PARTIAL"),
            _ => ("status-unresolved", "UNRESOLVED"),
        };

        topology_cards.push_str(&format!(
            r#"<div class="topo-pair-card" data-search="{method} {path} {file}">
                <div class="topo-endpoint">
                    <div class="topo-header">
                        <span class="badge {method_lower}">{method}</span>
                        <code class="route-code">{path}</code>
                        <span class="status-pill {status_class}">{status_label}</span>
                    </div>
                    <div class="topo-source">Controller: {file}</div>
                </div>
                <div class="topo-connector">
                    <div class="topo-line"></div>
                    <div class="topo-arrow">&rarr;</div>
                </div>
                <div class="topo-clients">
                    {client_links}
                </div>
            </div>"#,
            method_lower = ep.method.to_lowercase(),
            method = ep.method,
            path = html_escape(&ep.path),
            status_class = status_class,
            status_label = status_label,
            file = html_escape(&ep.java_file),
            client_links = client_links_html,
        ));
    }

    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sajimora Contract Health Dashboard — {repo_name}</title>
    <style>
        :root {{
            --bg: #0B0F19;
            --card-bg: rgba(17, 24, 39, 0.75);
            --card-border: #1E293B;
            --card-hover: rgba(30, 41, 59, 0.6);
            --border: #1E293B;
            --text: #F3F4F6;
            --text-dim: #9CA3AF;
            --text-muted: #64748B;
            --primary: #3B82F6;
            --success: #10B981;
            --danger: #F43F5E;
            --warning: #F59E0B;
            --verdict-color: {verdict_color};
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }}
        body {{ background-color: var(--bg); color: var(--text); padding: 28px; line-height: 1.5; min-height: 100vh; }}
        
        header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 24px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 28px;
            flex-wrap: wrap;
            gap: 16px;
        }}
        .title-group h1 {{
            font-size: 26px;
            font-weight: 800;
            display: flex;
            align-items: center;
            gap: 12px;
            letter-spacing: -0.5px;
        }}
        .title-group p {{
            color: var(--text-dim);
            font-size: 14px;
            margin-top: 6px;
        }}
        .verdict-banner {{
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid var(--verdict-color);
            color: var(--verdict-color);
            padding: 12px 24px;
            border-radius: 10px;
            font-weight: 800;
            font-size: 16px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(8px);
        }}
        
        .metrics-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
            gap: 16px;
            margin-bottom: 28px;
        }}
        .metric-card {{
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 20px;
            backdrop-filter: blur(12px);
            transition: transform 0.15s ease, border-color 0.15s ease;
        }}
        .metric-card:hover {{
            transform: translateY(-2px);
            border-color: #334155;
        }}
        .metric-card .label {{
            color: var(--text-dim);
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
        }}
        .metric-card .value {{
            font-size: 30px;
            font-weight: 800;
            margin-top: 8px;
            letter-spacing: -0.5px;
        }}
        .metric-card .subtext {{
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 6px;
        }}
        
        .tabs {{
            display: flex;
            gap: 8px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 20px;
            overflow-x: auto;
        }}
        .tab-btn {{
            background: transparent;
            border: none;
            color: var(--text-dim);
            padding: 12px 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: color 0.15s ease, border-color 0.15s ease;
            white-space: nowrap;
        }}
        .tab-btn:hover {{
            color: #fff;
        }}
        .tab-btn.active {{
            color: var(--primary);
            border-bottom: 2px solid var(--primary);
        }}
        
        .tab-content {{
            display: none;
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            backdrop-filter: blur(12px);
        }}
        .tab-content.active {{
            display: block;
        }}
        
        .filter-bar {{
            padding: 14px 20px;
            background: rgba(15, 23, 42, 0.7);
            border-bottom: 1px solid var(--border);
            display: flex;
            gap: 16px;
            align-items: center;
        }}
        .filter-bar input {{
            background: #0B1120;
            border: 1px solid #334155;
            color: #fff;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            width: 360px;
            outline: none;
            transition: border-color 0.15s ease;
        }}
        .filter-bar input:focus {{
            border-color: var(--primary);
        }}
        .filter-count {{
            color: var(--text-muted);
            font-size: 13px;
        }}
        
        table {{
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 14px;
        }}
        th {{
            background: #111A2E;
            color: #94A3B8;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 14px 20px;
            border-bottom: 1px solid var(--border);
        }}
        td {{
            padding: 14px 20px;
            border-bottom: 1px solid #162032;
        }}
        tr:hover td {{
            background: rgba(255, 255, 255, 0.02);
        }}
        
        .badge {{
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: inline-block;
        }}
        .badge.get {{ background: #064E3B; color: #34D399; }}
        .badge.post {{ background: #1E3A8A; color: #60A5FA; }}
        .badge.put {{ background: #78350F; color: #FBBF24; }}
        .badge.delete {{ background: #831843; color: #F472B6; }}
        .badge.patch {{ background: #4C1D95; color: #C084FC; }}
        
        .status-pill {{
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            display: inline-block;
        }}
        .status-resolved {{ background: rgba(16, 185, 129, 0.15); color: #10B981; border: 1px solid rgba(16, 185, 129, 0.3); }}
        .status-partial {{ background: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3); }}
        .status-unresolved {{ background: rgba(239, 68, 68, 0.15); color: #EF4444; border: 1px solid rgba(239, 68, 68, 0.3); }}
        
        code.route-code {{
            background: #1E293B;
            padding: 3px 8px;
            border-radius: 5px;
            font-size: 13px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            color: #E2E8F0;
        }}
        .file-link {{
            color: #38BDF8;
            font-family: ui-monospace, SFMono-Regular, monospace;
            font-size: 13px;
            text-decoration: none;
        }}
        .diff-before {{ color: #F43F5E; font-family: monospace; font-weight: 600; }}
        .diff-after {{ color: #10B981; font-family: monospace; font-weight: 600; }}
        
        /* Topology Layout */
        .topo-container {{
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }}
        .topo-pair-card {{
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid #1E293B;
            border-radius: 10px;
            padding: 16px 20px;
            display: grid;
            grid-template-columns: 1fr 60px 1.2fr;
            align-items: center;
            gap: 16px;
            transition: border-color 0.15s ease;
        }}
        .topo-pair-card:hover {{
            border-color: #38BDF8;
        }}
        .topo-endpoint .topo-header {{
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 6px;
        }}
        .topo-source {{
            font-size: 12px;
            color: var(--text-muted);
        }}
        .topo-connector {{
            display: flex;
            align-items: center;
            justify-content: center;
            color: #64748B;
            font-size: 20px;
            font-weight: 700;
        }}
        .topo-clients {{
            display: flex;
            flex-direction: column;
            gap: 6px;
        }}
        .topo-client-item {{
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
        }}
        .topo-client-none {{
            color: #64748B;
            font-size: 12px;
            font-style: italic;
        }}
        .topo-usage {{
            color: #94A3B8;
            font-size: 11px;
            font-family: monospace;
            max-width: 320px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }}
        
        footer {{
            margin-top: 32px;
            padding-top: 20px;
            border-top: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            color: var(--text-muted);
            font-size: 13px;
        }}
    </style>
</head>
<body>
    <header>
        <div class="title-group">
            <h1>🛡️ Sajimora Contract Dashboard</h1>
            <p>Repository: <strong>{repo_name}</strong> &bull; Backend: <strong>{backend_id}</strong> &bull; Frontend: <strong>{frontend_id}</strong> &bull; Version: <strong>v0.1.0</strong></p>
        </div>
        <div class="verdict-banner">{verdict_badge}</div>
    </header>

    <div class="metrics-grid">
        <div class="metric-card">
            <div class="label">Backend Endpoints</div>
            <div class="value" style="color: #60A5FA">{backend_count}</div>
            <div class="subtext">{resolved_count} resolved &bull; {partial_count} partial &bull; {unresolved_count} unres</div>
        </div>
        <div class="metric-card">
            <div class="label">Frontend Call Sites</div>
            <div class="value" style="color: #34D399">{frontend_count}</div>
            <div class="subtext">Client contracts mapped</div>
        </div>
        <div class="metric-card">
            <div class="label">Breaking Findings</div>
            <div class="value" style="color: {verdict_color}">{findings_count}</div>
            <div class="subtext">{affected_calls} affected consumer sites</div>
        </div>
        <div class="metric-card">
            <div class="label">Test Synthesis</div>
            <div class="value" style="color: #A78BFA">{test_total}</div>
            <div class="subtext">{contract_tests} contract &bull; {advisory_tests} fallback &bull; {abstain_tests} abstain</div>
        </div>
        <div class="metric-card">
            <div class="label">Telemetry & Coverage</div>
            <div class="value" style="color: {telemetry_color}; font-size: 20px; margin-top: 12px;">{telemetry_status}</div>
            <div class="subtext">Verified runtime evidence</div>
        </div>
    </div>

    <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('findings', this)">🚨 Breaking Findings ({findings_count})</button>
        <button class="tab-btn" onclick="switchTab('topology', this)">🗺️ Architecture Topology ({matched_pairs})</button>
        <button class="tab-btn" onclick="switchTab('backend', this)">📦 Backend Endpoints ({backend_count})</button>
        <button class="tab-btn" onclick="switchTab('frontend', this)">🌐 Frontend Call Sites ({frontend_count})</button>
    </div>

    <div id="tab-findings" class="tab-content active">
        <div class="filter-bar">
            <input type="text" id="findingFilter" placeholder="Filter findings by path, wire name, or file..." onkeyup="filterTable('findingsTable', this.value)">
            <span class="filter-count">Showing breaking contract discrepancies</span>
        </div>
        <table id="findingsTable">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Endpoint</th>
                    <th>Wire Path</th>
                    <th>Type Shift</th>
                    <th>Consumer Site</th>
                    <th>Recommended Fix</th>
                </tr>
            </thead>
            <tbody>
                {findings_rows}
            </tbody>
        </table>
    </div>

    <div id="tab-topology" class="tab-content">
        <div class="filter-bar">
            <input type="text" id="topologyFilter" placeholder="Search topology by route, method, or controller..." onkeyup="filterTopology(this.value)">
            <span class="filter-count">Verified Service &rarr; Route &rarr; Frontend Client consumer chains</span>
        </div>
        <div class="topo-container" id="topologyContainer">
            {topology_cards}
        </div>
    </div>

    <div id="tab-backend" class="tab-content">
        <div class="filter-bar">
            <input type="text" id="backendFilter" placeholder="Filter backend endpoints by route, method, or file..." onkeyup="filterTable('backendTable', this.value)">
            <span class="filter-count">{backend_count} extracted Spring MVC endpoints</span>
        </div>
        <table id="backendTable">
            <thead>
                <tr>
                    <th>Method</th>
                    <th>Route Path</th>
                    <th>Contract Completeness</th>
                    <th>Java Controller Source</th>
                    <th>Payload DTO</th>
                </tr>
            </thead>
            <tbody>
                {endpoint_rows}
            </tbody>
        </table>
    </div>

    <div id="tab-frontend" class="tab-content">
        <div class="filter-bar">
            <input type="text" id="frontendFilter" placeholder="Filter frontend call sites by route, method, or file..." onkeyup="filterTable('frontendTable', this.value)">
            <span class="filter-count">{frontend_count} extracted TypeScript / React call sites</span>
        </div>
        <table id="frontendTable">
            <thead>
                <tr>
                    <th>Method</th>
                    <th>Call URL / Route</th>
                    <th>Frontend Client Source</th>
                    <th>Invocation Usage</th>
                </tr>
            </thead>
            <tbody>
                {client_rows}
            </tbody>
        </table>
    </div>

    <footer>
        <div>Sajimora Artifact Verification Engine &bull; LLM Proposes. Sajimora Verifies.</div>
        <div>Advisory Contract Compatibility Analysis</div>
    </footer>

    <script>
        function switchTab(name, btn) {{
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            if (btn) {{
                btn.classList.add('active');
            }} else if (window.event && window.event.currentTarget) {{
                window.event.currentTarget.classList.add('active');
            }}
            const target = document.getElementById('tab-' + name);
            if (target) {{
                target.classList.add('active');
            }}
        }}

        function filterTable(tableId, query) {{
            const filter = query.toLowerCase();
            const rows = document.getElementById(tableId).getElementsByTagName('tbody')[0].getElementsByTagName('tr');
            for (let i = 0; i < rows.length; i++) {{
                const text = rows[i].textContent.toLowerCase();
                rows[i].style.display = text.includes(filter) ? '' : 'none';
            }}
        }}

        function filterTopology(query) {{
            const filter = query.toLowerCase();
            const cards = document.querySelectorAll('.topo-pair-card');
            cards.forEach(card => {{
                const text = card.textContent.toLowerCase();
                card.style.display = text.includes(filter) ? '' : 'none';
            }});
        }}
    </script>
</body>
</html>"#,
        repo_name = html_escape(&data.repo_name),
        backend_id = html_escape(&data.backend_service_id),
        frontend_id = html_escape(&data.frontend_service_id),
        verdict_badge = verdict_badge,
        verdict_color = verdict_color,
        backend_count = data.backend_endpoints_count,
        resolved_count = data.resolved_endpoints_count,
        partial_count = data.partial_endpoints_count,
        unresolved_count = data.unresolved_endpoints_count,
        frontend_count = data.frontend_contracts_count,
        findings_count = data.findings_count,
        affected_calls = data.affected_call_sites,
        test_total =
            data.contract_tests_count + data.advisory_tests_count + data.abstain_tests_count,
        contract_tests = data.contract_tests_count,
        advisory_tests = data.advisory_tests_count,
        abstain_tests = data.abstain_tests_count,
        telemetry_status = telemetry_status,
        telemetry_color = telemetry_color,
        findings_rows = findings_rows,
        endpoint_rows = endpoint_rows,
        client_rows = client_rows,
        topology_cards = topology_cards,
        matched_pairs = matched_pairs_count,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn open_in_browser(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

fn find_sajimora_dir(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut curr = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        let sajimora = curr.join(".sajimora");
        if sajimora.is_dir() {
            return Some((curr, sajimora));
        }
        if !curr.pop() {
            break;
        }
    }

    None
}
