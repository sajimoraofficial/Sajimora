#!/usr/bin/env python3
"""
21_monorepos_test.py
Automated benchmark harness for the 21 True Fullstack Monorepos.
Validates the zero-false-positive fixes across all 21 true monorepository codebases.
"""

import os
import sys
import json
import time
import shutil
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional

SAJIMORA_BIN = "/home/ec2-user/Sajimora-v0.10/rust/target/release/sajimora"
WORK_DIR = "/tmp/monorepos_21_workspace"
MANIFEST_PATH = "/home/ec2-user/Sajimora-v0.10/scripts/100_fullstack_repos_manifest.json"
OUTPUT_JSON = "/home/ec2-user/.gemini/antigravity-cli/brain/5c4f2113-7e0d-4be4-9e15-515ef2bd3f12/monorepos_21_audit.json"

TRUE_MONOREPOS = [
    "Antabot/White-Jotter",
    "linlinjava/litemall",
    "techa03/goodsKill",
    "shimh-develop/blog-vue-springboot",
    "jonashackt/spring-boot-vuejs",
    "shzlw/poli",
    "Heeexy/SpringBoot-Shiro-Vue",
    "lenve/VBlog",
    "linhaojun857/aurora",
    "MarkerHub/vueblog",
    "Naccl/NBlog",
    "callicoder/spring-security-react-ant-design-polls-app",
    "SaiUpadhyayula/spring-boot-3-microservices-course",
    "IAMLZY2018/XianYuAssistant",
    "thingsboard/thingsboard",
    "moxi624/mogu_blog_v2",
    "dancancro/great-big-example-application",
    "in28minutes/full-stack-with-angular-and-spring-boot",
    "zhulinn/SpringBoot-Angular7-Online-Shopping-Store",
    "borysn/spring-boot-angular2",
    "dsyer/spring-boot-angular"
]

def run_command(cmd: List[str], cwd: Optional[str] = None, timeout_sec: int = 45) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout_sec
    )

def analyze_repo(repo_info: Dict[str, Any], idx: int, total: int) -> Dict[str, Any]:
    repo_id = repo_info.get("id", "unknown_repo")
    full_name = repo_info.get("full_name", repo_id)
    repo_url = repo_info["url"]
    license_id = repo_info.get("license", "APACHE/MIT")
    stars = repo_info.get("stars", 0)
    fe_tech = repo_info.get("frontend_tech", "Web Frontend")
    be_tech = repo_info.get("backend_tech", "Spring Boot")
    tier = repo_info.get("tier", "General Fullstack")
    clone_path = os.path.join(WORK_DIR, repo_id)
    
    print(f"\n[{idx:02d}/{total:02d}] [{full_name}] ({stars:,}★ | {be_tech} + {fe_tech})")
    print(f"       Cloning {repo_url} (--depth 1)...", end="", flush=True)
    
    if os.path.exists(clone_path):
        shutil.rmtree(clone_path, ignore_errors=True)
    os.makedirs(WORK_DIR, exist_ok=True)
    
    start_clone = time.perf_counter()
    try:
        clone_res = run_command(["git", "clone", "--depth", "1", repo_url, clone_path], timeout_sec=45)
        clone_time_ms = (time.perf_counter() - start_clone) * 1000.0
    except subprocess.TimeoutExpired:
        print(" [CLONE TIMEOUT]")
        shutil.rmtree(clone_path, ignore_errors=True)
        return {
            "id": repo_id, "full_name": full_name, "stars": stars, "license": license_id,
            "status": "CLONE_TIMEOUT", "clone_time_ms": 45000.0, "verdict": "UNKNOWN",
            "endpoints_count": 0, "clients_count": 0, "client_calls_count": 0,
            "blockers_count": 0, "findings_count": 0, "blockers": [], "findings": []
        }
    except Exception as e:
        print(f" [CLONE ERROR: {e}]")
        shutil.rmtree(clone_path, ignore_errors=True)
        return {
            "id": repo_id, "full_name": full_name, "stars": stars, "license": license_id,
            "status": "CLONE_ERROR", "error": str(e), "verdict": "UNKNOWN",
            "endpoints_count": 0, "clients_count": 0, "client_calls_count": 0,
            "blockers_count": 0, "findings_count": 0, "blockers": [], "findings": []
        }
        
    if clone_res.returncode != 0:
        print(" [CLONE FAILED]")
        shutil.rmtree(clone_path, ignore_errors=True)
        return {
            "id": repo_id, "full_name": full_name, "stars": stars, "license": license_id,
            "status": "CLONE_FAILED", "error": clone_res.stderr.strip()[:200], "verdict": "UNKNOWN",
            "endpoints_count": 0, "clients_count": 0, "client_calls_count": 0,
            "blockers_count": 0, "findings_count": 0, "blockers": [], "findings": []
        }
        
    print(f" done ({clone_time_ms:.0f}ms).")
    print(f"       Running sajimora init...", end="", flush=True)
    
    start_init = time.perf_counter()
    try:
        init_res = run_command([SAJIMORA_BIN, "init", "--repo", clone_path, "--apply", "--force"], timeout_sec=45)
        init_time_ms = (time.perf_counter() - start_init) * 1000.0
    except subprocess.TimeoutExpired:
        print(" [INIT TIMEOUT]")
        shutil.rmtree(clone_path, ignore_errors=True)
        return {
            "id": repo_id, "full_name": full_name, "stars": stars, "license": license_id,
            "status": "INIT_TIMEOUT", "clone_time_ms": clone_time_ms, "init_time_ms": 45000.0,
            "verdict": "UNKNOWN", "endpoints_count": 0, "clients_count": 0, "client_calls_count": 0,
            "blockers_count": 0, "findings_count": 0, "blockers": [], "findings": []
        }
    except Exception as e:
        print(f" [INIT ERROR: {e}]")
        shutil.rmtree(clone_path, ignore_errors=True)
        return {
            "id": repo_id, "full_name": full_name, "stars": stars, "license": license_id,
            "status": "INIT_ERROR", "error": str(e), "verdict": "UNKNOWN",
            "endpoints_count": 0, "clients_count": 0, "client_calls_count": 0,
            "blockers_count": 0, "findings_count": 0, "blockers": [], "findings": []
        }
        
    if init_res.returncode != 0:
        print(f" [INIT FAILED: {init_res.stderr[:100]}]")
    else:
        print(f" done ({init_time_ms:.0f}ms).")
        
    start_verify = time.perf_counter()
    print(f"       Running sajimora verify...", end="", flush=True)
    try:
        verify_res = run_command([SAJIMORA_BIN, "verify", "--repo", clone_path, "--trusted-local"], timeout_sec=30)
        verify_time_ms = (time.perf_counter() - start_verify) * 1000.0
    except subprocess.TimeoutExpired:
        print(" [VERIFY TIMEOUT]")
        verify_time_ms = 30000.0
    except Exception as e:
        print(f" [VERIFY ERROR: {e}]")
        verify_time_ms = 0.0
        
    print(f" done ({verify_time_ms:.0f}ms).")
    
    report_path = os.path.join(clone_path, ".sajimora", "impact-report.json")
    be_contract_path = os.path.join(clone_path, ".sajimora", "backend-contract.json")
    fe_contract_path = os.path.join(clone_path, ".sajimora", "frontend-contract.json")
    
    verdict = "UNKNOWN"
    endpoints_count = 0
    clients_count = 0
    client_calls_count = 0
    blockers = []
    findings = []
    status = "SUCCESS"
    
    if os.path.exists(be_contract_path):
        try:
            with open(be_contract_path, "r", encoding="utf-8") as bf:
                bdata = json.load(bf)
                endpoints_count = len(bdata.get("payload", {}).get("endpoints", []))
        except Exception:
            pass
            
    if os.path.exists(fe_contract_path):
        try:
            with open(fe_contract_path, "r", encoding="utf-8") as ff:
                fdata = json.load(ff)
                payload = fdata.get("payload", {})
                ccs = payload.get("clientContracts", [])
                clients_count = len(ccs)
                for c in ccs:
                    client_calls_count += len(c.get("consumers", []))
        except Exception:
            pass
            
    if os.path.exists(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as rf:
                rdata = json.load(rf)
                verdict = rdata.get("verdict", "UNKNOWN")
                blockers = rdata.get("blockers", [])
                findings = rdata.get("findings", []) or rdata.get("delta", {}).get("existingFindings", [])
        except Exception:
            pass
            
    print(f"       -> Endpoints: {endpoints_count} | Clients: {clients_count} (Calls: {client_calls_count}) | Verdict: {verdict} | Findings: {len(findings)} | Blockers: {len(blockers)}")
    if findings:
        for fi, f in enumerate(findings, 1):
            hint = f.get("repairHint") or f.get("detail", "unknown")
            ep = f.get("endpoint", {})
            m = ep.get("method", "")
            p = ep.get("path", "")
            w = f.get("wirePath", "$")
            ch = f.get("change", {})
            print(f"         Finding #{fi}: [{m} {p}] wire={w} change={ch} hint={hint}")
            
    # Purge repository immediately to maintain zero disk footprint
    shutil.rmtree(clone_path, ignore_errors=True)
    
    return {
        "id": repo_id,
        "full_name": full_name,
        "stars": stars,
        "license": license_id,
        "tier": tier,
        "frontend_tech": fe_tech,
        "backend_tech": be_tech,
        "status": status,
        "verdict": verdict,
        "endpoints_count": endpoints_count,
        "clients_count": clients_count,
        "client_calls_count": client_calls_count,
        "clone_time_ms": clone_time_ms,
        "init_time_ms": init_time_ms,
        "verify_time_ms": verify_time_ms,
        "blockers_count": len(blockers),
        "findings_count": len(findings),
        "blockers": blockers,
        "findings": findings
    }

def main():
    if not os.path.exists(SAJIMORA_BIN):
        print(f"Error: {SAJIMORA_BIN} does not exist.")
        sys.exit(1)
        
    with open(MANIFEST_PATH, "r") as f:
        all_repos = json.load(f)
        
    manifest_by_name = {r["full_name"]: r for r in all_repos}
    target_repos = [manifest_by_name[name] for name in TRUE_MONOREPOS if name in manifest_by_name]
    
    total = len(target_repos)
    print(f"================================================================================")
    print(f"  SAJIMORA v0.10: 21 TRUE MONOREPOS BENCHMARK (AFTER SOUNDNESS FIX)")
    print(f"  Target Cohort: {total} Genuine Fullstack Monorepos")
    print(f"  Binary: {SAJIMORA_BIN}")
    print(f"================================================================================")
    
    start_total = time.perf_counter()
    results = []
    
    for idx, repo_info in enumerate(target_repos, 1):
        res = analyze_repo(repo_info, idx, total)
        results.append(res)
        
    total_sec = time.perf_counter() - start_total
    
    verdicts = {}
    total_endpoints = sum(r["endpoints_count"] for r in results)
    total_clients = sum(r["clients_count"] for r in results)
    total_calls = sum(r["client_calls_count"] for r in results)
    total_findings = sum(r["findings_count"] for r in results)
    
    for r in results:
        v = r["verdict"]
        verdicts[v] = verdicts.get(v, 0) + 1
        
    print(f"\n================================================================================")
    print(f"  21 TRUE MONOREPOS BENCHMARK COMPLETE")
    print(f"  Total Duration: {total_sec:.2f}s ({total_sec/60:.2f} min)")
    print(f"  Backend REST Routes: {total_endpoints:,}")
    print(f"  Frontend Client Contracts: {total_clients:,}")
    print(f"  Frontend API Calls Linked: {total_calls:,}")
    print(f"  Total Findings: {total_findings:,}")
    print(f"  Verdict Distribution: {verdicts}")
    print(f"================================================================================")
    
    output_data = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_repos_analyzed": total,
        "total_duration_sec": total_sec,
        "verdict_distribution": verdicts,
        "repositories": results
    }
    
    os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
    with open(OUTPUT_JSON, "w") as f:
        json.dump(output_data, f, indent=2)
    print(f"Saved audit results to {OUTPUT_JSON}")

if __name__ == "__main__":
    main()
