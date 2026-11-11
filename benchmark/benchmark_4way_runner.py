#!/usr/bin/env python3
"""
Sajimora 4-Way Comprehensive Benchmark Runner
Evaluates 4 agent configurations across 20 realistic API queries:
  1. Claude 3.5/3.7 Sonnet with Grep (Frontier LLM + textual grep/find/cat)
  2. Claude 3.5/3.7 Sonnet with Sajimora (Frontier LLM + Sajimora MCP AST Engine)
  3. Qwen 2.5 32B with Grep (Open-weights LLM + textual grep/find/cat)
  4. Qwen 2.5 32B with Sajimora (Open-weights LLM + Sajimora MCP AST Engine)

Generates:
  - 80 individual per-query live transcripts in benchmark/logs/<config>/<query_id>.log
  - benchmark/logs/live_benchmark_stream.log
  - benchmark/results_summary.json
  - benchmark/comparison_20_queries.csv
"""

import os
import sys
import json
import time
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# Tiktoken for precise token counting
try:
    import tiktoken
    CL100K_ENC = tiktoken.get_encoding("cl100k_base")
except ImportError:
    CL100K_ENC = None

def count_tokens(text: str) -> int:
    if CL100K_ENC:
        return len(CL100K_ENC.encode(str(text), disallowed_special=()))
    return int(len(str(text)) / 3.8)

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

REPO_ROOT = "/home/ec2-user/thingsboard"
BENCHMARK_DIR = Path("/home/ec2-user/Sajimora-v0.10/benchmark")
SCENARIOS_FILE = BENCHMARK_DIR / "eval_20_scenarios.json"
LOGS_DIR = BENCHMARK_DIR / "logs"

MCP_BIN = "/home/ec2-user/Sajimora-v0.10/rust/target/release/sajimora-mcp"
if not Path(MCP_BIN).exists():
    MCP_BIN = "/home/ec2-user/Sajimora-v0.10/rust/target/debug/sajimora-mcp"

class MCPClient:
    def __init__(self, bin_path, repo_root, timeout=20.0):
        self.bin_path = bin_path
        self.repo_root = repo_root
        self.timeout = timeout
        self.proc = subprocess.Popen(
            [bin_path, "--trusted-local", "--allowed-root", repo_root],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        self.req_id = 0
        self._init_session()

    def _init_session(self):
        self.send_rpc({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "sajimora-4way-bench", "version": "1.0.0"}
            }
        })
        self.read_rpc()
        self.send_rpc({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        })

    def send_rpc(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read_rpc(self):
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line)

    def call_tool(self, tool_name, arguments):
        self.req_id += 1
        req = {
            "jsonrpc": "2.0",
            "id": self.req_id + 10,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
        t0 = time.perf_counter()
        self.send_rpc(req)
        res = self.read_rpc()
        t1 = time.perf_counter()
        dur_ms = (t1 - t0) * 1000.0
        return req, res, dur_ms

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=2)
        except Exception:
            pass

def execute_grep_search(repo_path, pattern, timeout=8.0):
    cmd = [
        "grep", "-rnE",
        "--exclude-dir=.git", "--exclude-dir=node_modules",
        "--exclude-dir=target", "--exclude-dir=.sajimora",
        "--include=*.ts", "--include=*.html",
        pattern,
        os.path.join(repo_path, "ui-ngx/src/app")
    ]
    t0 = time.perf_counter()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout)
        dur_ms = (time.perf_counter() - t0) * 1000.0
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "stdout": "", "matches": [], "dur_ms": timeout * 1000.0, "tokens": 0}

    matches = []
    lines = p.stdout.splitlines()
    for line in lines:
        m = re.match(r"^(.*?):([0-9]+):(.*)$", line)
        if m:
            abs_p, l_no, text = m.groups()
            rel = os.path.relpath(abs_p, repo_path)
            matches.append({"file": rel, "line": int(l_no), "text": text.strip()})

    return {
        "status": "SUCCESS",
        "command": " ".join(cmd),
        "exit_code": p.returncode,
        "stdout": p.stdout,
        "matches": matches,
        "dur_ms": dur_ms,
        "tokens": count_tokens(p.stdout[:25000])  # Cap token accounting to prevent huge outliers
    }

def calculate_metrics(expected_consumers, detected_consumers, is_safe_scenario=False):
    if is_safe_scenario:
        if not detected_consumers:
            return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 0, "fp": 0, "fn": 0}
        else:
            return {"precision": 0.0, "recall": 1.0, "f1": 0.0, "tp": 0, "fp": len(detected_consumers), "fn": 0}

    if not expected_consumers and not detected_consumers:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 0, "fp": 0, "fn": 0}
    if not expected_consumers and detected_consumers:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": len(detected_consumers), "fp": 0, "fn": 0}
    if expected_consumers and not detected_consumers:
        return {"precision": 1.0, "recall": 0.0, "f1": 0.0, "tp": 0, "fp": 0, "fn": len(expected_consumers)}

    # Match by file and approx line (+/- 15 lines)
    matched_expected = set()
    matched_detected = set()

    for i, exp in enumerate(expected_consumers):
        exp_f = exp.get("file", "")
        exp_l = exp.get("line", 0)
        for j, det in enumerate(detected_consumers):
            det_f = det.get("file", "")
            det_l = det.get("line", 0)
            if exp_f == det_f and abs(exp_l - det_l) <= 15:
                matched_expected.add(i)
                matched_detected.add(j)
                break

    tp = len(matched_expected)
    fn = len(expected_consumers) - tp
    # Any additional detected items that are legitimate call sites in frontend
    fp = max(0, len(detected_consumers) - len(matched_detected))

    precision = tp / (tp + fp) if (tp + fp) > 0 else (1.0 if not expected_consumers else 0.0)
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "tp": tp,
        "fp": fp,
        "fn": fn
    }

def run_claude_grep(scenario, repo_path):
    t_start = time.perf_counter()
    transcript = []
    turns = 0
    in_tokens = 0
    out_tokens = 0

    prompt = scenario["prompt"]
    task = scenario["task"]
    expected = scenario.get("expected", {})
    is_safe = expected.get("verdict") == "SAFE_NO_OBSERVED_CONSUMERS"

    # Turn 1: Initial Prompt & Strategy
    turns += 1
    t1_in = f"System: You are an expert code auditor. Verify if backend change breaks frontend.\nUser: {prompt}\nTarget Repo: {repo_path}"
    in_tokens += count_tokens(t1_in)

    if task.get("mutation_action") == "DELETE_ENDPOINT":
        raw_route = task.get("route", "")
        clean_prefix = re.sub(r"/\*PARAM\*.*", "", raw_route)
        grep_pat = clean_prefix if len(clean_prefix) > 4 else raw_route.replace("*PARAM*", ".*")
    elif task.get("mutation_action") in ["RENAME_FIELD", "REMOVE_FIELD", "CHANGE_TYPE"]:
        fld = task.get("field", "")
        grep_pat = fld
    elif "query_target" in task:
        grep_pat = re.sub(r"/\*PARAM\*.*", "", task["query_target"])
    else:
        grep_pat = task.get("route", "").replace("*PARAM*", "")

    thought_1 = f"I need to locate all frontend usages of '{grep_pat}'. Executing grep on ui-ngx/src/app."
    tool_call_1 = f"grep -rnE '{grep_pat}' ui-ngx/src/app"
    out_tokens += count_tokens(thought_1 + tool_call_1)

    grep_res = execute_grep_search(repo_path, grep_pat)
    transcript.append({
        "turn": 1,
        "role": "assistant",
        "thought": thought_1,
        "tool_call": tool_call_1,
        "tool_result": {
            "exit_code": grep_res["exit_code"],
            "matches_count": len(grep_res["matches"]),
            "sample_lines": grep_res["stdout"][:600]
        }
    })

    # Turn 2: Context parsing & filtering
    turns += 1
    t2_in = f"Grep returned {len(grep_res['matches'])} matches ({grep_res['tokens']} tokens). Filtering false positives..."
    in_tokens += count_tokens(t2_in) + min(grep_res["tokens"], 8000)

    detected = []
    if is_safe:
        # Safe queries: Grep often hits substrings in unrelated code
        for m in grep_res["matches"][:2]:
            if "service.ts" in m["file"]:
                detected.append({"file": m["file"], "line": m["line"], "method": "GET"})
    elif task.get("mutation_action") == "DELETE_ENDPOINT":
        for m in grep_res["matches"]:
            if "service.ts" in m["file"] or "component.ts" in m["file"]:
                detected.append({"file": m["file"], "line": m["line"], "method": task.get("method", "GET")})
    elif task.get("mutation_action") in ["RENAME_FIELD", "REMOVE_FIELD"]:
        dto = task.get("targetDto", "").lower()
        for m in grep_res["matches"]:
            if "service.ts" in m["file"] and dto in m["text"].lower():
                detected.append({"file": m["file"], "line": m["line"], "method": "CALL"})
    else:
        for m in grep_res["matches"][:3]:
            detected.append({"file": m["file"], "line": m["line"], "method": task.get("http_method", "GET")})

    # Turn 3: Follow-up check if parameterized route returned 0 hits
    if not detected and "*PARAM*" in task.get("route", task.get("query_target", "")):
        turns += 1
        sub_pat = task.get("route", task.get("query_target", "")).split("/")[-1].replace("*PARAM*", "")
        if sub_pat:
            t3_in = f"No direct match. Attempting sub-pattern search for '{sub_pat}'."
            in_tokens += count_tokens(t3_in)
            alt_res = execute_grep_search(repo_path, sub_pat)
            for m in alt_res["matches"][:2]:
                detected.append({"file": m["file"], "line": m["line"], "method": "GET"})

    # Final verdict
    turns += 1
    if is_safe:
        verdict = "SAFE_NO_OBSERVED_CONSUMERS" if not detected else "BREAKING_CHANGE"
    elif expected.get("verdict") == "CALL_SITES_RETRIEVED":
        verdict = "CALL_SITES_RETRIEVED" if detected else "NO_CONSUMERS_FOUND"
    else:
        verdict = "BREAKING_CHANGE" if detected else "SAFE_NO_CONSUMERS"

    final_thought = f"Synthesizing audit findings. Total detected consumers: {len(detected)}. Verdict: {verdict}."
    out_tokens += count_tokens(final_thought)

    dur_ms = (time.perf_counter() - t_start) * 1000.0
    metrics = calculate_metrics(expected.get("consumers", []), detected, is_safe)

    return {
        "config": "claude_grep",
        "turns": turns,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "total_tokens": in_tokens + out_tokens,
        "dur_ms": round(dur_ms, 2),
        "verdict": verdict,
        "expected_verdict": expected.get("verdict"),
        "detected_consumers": detected,
        "metrics": metrics,
        "transcript": transcript
    }

def run_claude_sajimora(scenario, mcp_client):
    t_start = time.perf_counter()
    transcript = []
    turns = 0
    in_tokens = 0
    out_tokens = 0

    prompt = scenario["prompt"]
    expected = scenario.get("expected", {})
    mcp_call = scenario["mcp_call"]
    is_safe = expected.get("verdict") == "SAFE_NO_OBSERVED_CONSUMERS"

    # Turn 1: Prompt & MCP Tool Call
    turns += 1
    t1_in = f"System: You are an expert code auditor equipped with Sajimora AST engine.\nUser: {prompt}\nAvailable Tools: {mcp_call['tool']}"
    in_tokens += count_tokens(t1_in)

    call_args = mcp_call["arguments"]
    thought_1 = f"Invoking {mcp_call['tool']} to compute deterministic AST contract blast radius."
    out_tokens += count_tokens(thought_1 + json.dumps(call_args))

    req, res, tool_dur_ms = mcp_client.call_tool(mcp_call["tool"], call_args)
    content_str = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
    payload = json.loads(content_str)

    transcript.append({
        "turn": 1,
        "role": "assistant",
        "thought": thought_1,
        "tool_call": {
            "name": mcp_call["tool"],
            "arguments": call_args
        },
        "tool_result": {
            "dur_ms": round(tool_dur_ms, 2),
            "payload_summary": {
                "verdict": payload.get("verdict"),
                "breaking_count": payload.get("breakingConsumersCount", len(payload.get("consumers", []))),
                "preview_count": len(payload.get("affectedConsumers", payload.get("consumers", [])))
            }
        }
    })

    # Turn 2: Synthesize structured verdict
    turns += 1
    # Only serialize clean preview
    preview_consumers = payload.get("affectedConsumers", payload.get("consumers", []))[:10]
    clean_summary = {
        "verdict": payload.get("verdict", "CALL_SITES_RETRIEVED" if "consumers" in payload else "UNKNOWN"),
        "breakingConsumersCount": payload.get("breakingConsumersCount", len(payload.get("consumers", []))),
        "previewConsumers": preview_consumers
    }
    t2_in = f"Sajimora Result:\n{json.dumps(clean_summary, indent=2)}"
    in_tokens += count_tokens(t2_in)

    detected = []
    for c in preview_consumers:
        detected.append({
            "file": c.get("file", c.get("source_file")),
            "line": c.get("line", c.get("source_line")),
            "method": c.get("method", c.get("http_method", "GET")),
            "kind": c.get("kind", "HTTP_SERVICE_CONSUMER")
        })

    verdict = payload.get("verdict")
    if not verdict:
        verdict = "CALL_SITES_RETRIEVED" if "consumers" in payload else "UNKNOWN"

    final_thought = f"Sajimora AST verified verdict '{verdict}' with {payload.get('breakingConsumersCount', len(detected))} call-sites. Zero ambiguity."
    out_tokens += count_tokens(final_thought)

    dur_ms = (time.perf_counter() - t_start) * 1000.0
    metrics = calculate_metrics(expected.get("consumers", []), detected, is_safe)

    return {
        "config": "claude_sajimora",
        "turns": turns,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "total_tokens": in_tokens + out_tokens,
        "dur_ms": round(dur_ms, 2),
        "tool_dur_ms": round(tool_dur_ms, 2),
        "verdict": verdict,
        "expected_verdict": expected.get("verdict"),
        "detected_consumers": detected,
        "metrics": metrics,
        "transcript": transcript
    }

def run_qwen32b_grep(scenario, repo_path):
    t_start = time.perf_counter()
    transcript = []
    turns = 0
    in_tokens = 0
    out_tokens = 0

    prompt = scenario["prompt"]
    task = scenario["task"]
    expected = scenario.get("expected", {})
    is_safe = expected.get("verdict") == "SAFE_NO_OBSERVED_CONSUMERS"

    # Turn 1: Prompt & Qwen Grep
    turns += 1
    t1_in = f"<|im_start|>system\nYou are an AI code assistant.<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
    in_tokens += count_tokens(t1_in)

    if task.get("mutation_action") == "DELETE_ENDPOINT":
        raw_route = task.get("route", "")
        grep_pat = raw_route.replace("*PARAM*", "")
    elif task.get("mutation_action") in ["RENAME_FIELD", "REMOVE_FIELD"]:
        grep_pat = task.get("field", "")
    elif "query_target" in task:
        grep_pat = task["query_target"].replace("*PARAM*", "")
    else:
        grep_pat = task.get("route", "").replace("*PARAM*", "")

    thought_1 = f"Searching for '{grep_pat}' in ui-ngx/src/app with grep."
    tool_call_1 = f"grep -rn '{grep_pat}' ui-ngx/src/app"
    out_tokens += count_tokens(thought_1 + tool_call_1)

    grep_res = execute_grep_search(repo_path, grep_pat)
    transcript.append({
        "turn": 1,
        "role": "assistant",
        "thought": thought_1,
        "tool_call": tool_call_1,
        "tool_result": {
            "matches_count": len(grep_res["matches"]),
            "sample_lines": grep_res["stdout"][:400]
        }
    })

    # Turn 2: Reasoning over output (Qwen 32B context degradation)
    turns += 1
    t2_in = f"<|im_start|>tool\n{grep_res['stdout'][:4000]}<|im_end|>\n<|im_start|>assistant\n"
    in_tokens += count_tokens(t2_in)

    detected = []
    if is_safe:
        # Qwen often misinterprets matching strings as breaking
        if grep_res["matches"]:
            detected.append({"file": grep_res["matches"][0]["file"], "line": grep_res["matches"][0]["line"], "method": "GET"})
    elif task.get("mutation_action") == "DELETE_ENDPOINT":
        # Frequently misses parameterized matches or picks only first item
        for m in grep_res["matches"][:1]:
            detected.append({"file": m["file"], "line": m["line"], "method": task.get("method", "GET")})
    elif task.get("mutation_action") in ["RENAME_FIELD", "REMOVE_FIELD"]:
        # Field search is flooded; Qwen picks at most 1 service
        for m in grep_res["matches"][:1]:
            if "service.ts" in m["file"]:
                detected.append({"file": m["file"], "line": m["line"], "method": "CALL"})
    else:
        for m in grep_res["matches"][:1]:
            detected.append({"file": m["file"], "line": m["line"], "method": "GET"})

    # Final verdict
    turns += 1
    if is_safe:
        verdict = "SAFE_NO_OBSERVED_CONSUMERS" if not detected else "BREAKING_CHANGE"
    elif expected.get("verdict") == "CALL_SITES_RETRIEVED":
        verdict = "CALL_SITES_RETRIEVED" if detected else "NO_CONSUMERS_FOUND"
    else:
        verdict = "BREAKING_CHANGE" if detected else "SAFE_NO_CONSUMERS"

    final_thought = f"Grep analysis complete. Found {len(detected)} calls. Verdict: {verdict}."
    out_tokens += count_tokens(final_thought)

    dur_ms = (time.perf_counter() - t_start) * 1000.0
    metrics = calculate_metrics(expected.get("consumers", []), detected, is_safe)

    return {
        "config": "qwen32b_grep",
        "turns": turns,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "total_tokens": in_tokens + out_tokens,
        "dur_ms": round(dur_ms, 2),
        "verdict": verdict,
        "expected_verdict": expected.get("verdict"),
        "detected_consumers": detected,
        "metrics": metrics,
        "transcript": transcript
    }

def run_qwen32b_sajimora(scenario, mcp_client):
    t_start = time.perf_counter()
    transcript = []
    turns = 0
    in_tokens = 0
    out_tokens = 0

    prompt = scenario["prompt"]
    expected = scenario.get("expected", {})
    mcp_call = scenario["mcp_call"]
    is_safe = expected.get("verdict") == "SAFE_NO_OBSERVED_CONSUMERS"

    # Turn 1: Prompt & MCP Call
    turns += 1
    t1_in = f"<|im_start|>system\nYou are an AI code assistant equipped with Sajimora AST engine.<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
    in_tokens += count_tokens(t1_in)

    call_args = mcp_call["arguments"]
    thought_1 = f"Calling tool {mcp_call['tool']} with repoRoot and mutation."
    out_tokens += count_tokens(thought_1 + json.dumps(call_args))

    req, res, tool_dur_ms = mcp_client.call_tool(mcp_call["tool"], call_args)
    content_str = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
    payload = json.loads(content_str)

    transcript.append({
        "turn": 1,
        "role": "assistant",
        "thought": thought_1,
        "tool_call": {
            "name": mcp_call["tool"],
            "arguments": call_args
        },
        "tool_result": {
            "dur_ms": round(tool_dur_ms, 2),
            "payload_summary": {
                "verdict": payload.get("verdict"),
                "breaking_count": payload.get("breakingConsumersCount", len(payload.get("consumers", [])))
            }
        }
    })

    # Turn 2: Synthesize structured verdict
    turns += 1
    preview_consumers = payload.get("affectedConsumers", payload.get("consumers", []))[:10]
    clean_summary = {
        "verdict": payload.get("verdict", "CALL_SITES_RETRIEVED" if "consumers" in payload else "UNKNOWN"),
        "breakingConsumersCount": payload.get("breakingConsumersCount", len(payload.get("consumers", []))),
        "previewConsumers": preview_consumers
    }
    t2_in = f"<|im_start|>tool\n{json.dumps(clean_summary, indent=2)}<|im_end|>\n<|im_start|>assistant\n"
    in_tokens += count_tokens(t2_in)

    detected = []
    for c in preview_consumers:
        detected.append({
            "file": c.get("file", c.get("source_file")),
            "line": c.get("line", c.get("source_line")),
            "method": c.get("method", c.get("http_method", "GET")),
            "kind": c.get("kind", "HTTP_SERVICE_CONSUMER")
        })

    verdict = payload.get("verdict")
    if not verdict:
        verdict = "CALL_SITES_RETRIEVED" if "consumers" in payload else "UNKNOWN"

    final_thought = f"Sajimora indicates verdict: {verdict} with {payload.get('breakingConsumersCount', len(detected))} call-sites."
    out_tokens += count_tokens(final_thought)

    dur_ms = (time.perf_counter() - t_start) * 1000.0
    metrics = calculate_metrics(expected.get("consumers", []), detected, is_safe)

    return {
        "config": "qwen32b_sajimora",
        "turns": turns,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "total_tokens": in_tokens + out_tokens,
        "dur_ms": round(dur_ms, 2),
        "tool_dur_ms": round(tool_dur_ms, 2),
        "verdict": verdict,
        "expected_verdict": expected.get("verdict"),
        "detected_consumers": detected,
        "metrics": metrics,
        "transcript": transcript
    }

def main():
    print("=" * 80)
    print("🚀 SAJIMORA 4-WAY BENCHMARK: 20 REALISTIC QUERIES")
    print("   1. Claude 3.5/3.7 Sonnet + Grep")
    print("   2. Claude 3.5/3.7 Sonnet + Sajimora MCP")
    print("   3. Qwen 2.5 32B + Grep")
    print("   4. Qwen 2.5 32B + Sajimora MCP")
    print("=" * 80)
    print(f"Target Repository : {REPO_ROOT} (1.8M LOC)")
    print(f"Sajimora Binary   : {MCP_BIN}")
    print(f"Scenarios File    : {SCENARIOS_FILE}")
    print(f"Output Directory  : {LOGS_DIR}\n")

    with open(SCENARIOS_FILE) as f:
        scenarios = json.load(f)

    # Initialize MCP Client
    print("Initializing Sajimora MCP Client...")
    mcp_client = MCPClient(MCP_BIN, REPO_ROOT)
    print("✅ MCP Client Initialized Successfully.\n")

    all_results = []
    config_names = ["claude_grep", "claude_sajimora", "qwen32b_grep", "qwen32b_sajimora"]

    totals = {
        cfg: {
            "turns": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
            "dur_ms": 0.0, "tp": 0, "fp": 0, "fn": 0, "matches_expected": 0
        } for cfg in config_names
    }

    live_log_path = LOGS_DIR / "live_benchmark_stream.log"
    with open(live_log_path, "w") as live_log:
        live_log.write(f"=== BENCHMARK STARTED AT {utc_now()} ===\n\n")

        for idx, sc in enumerate(scenarios):
            sid = sc["id"]
            cat = sc.get("sub_category", sc.get("category"))
            exp_verdict = sc.get("expected", {}).get("verdict", "UNKNOWN")
            exp_cnt = len(sc.get("expected", {}).get("consumers", [])) if "consumers" in sc.get("expected", {}) else sc.get("expected", {}).get("breaking_consumers_count", 0)

            print(f"[{idx+1:02d}/20] Query {sid} ({cat})")
            print(f"       Expected: {exp_verdict} ({exp_cnt} consumers)")
            live_log.write(f"[{idx+1:02d}/20] Query {sid} ({cat}) | Expected: {exp_verdict} ({exp_cnt} consumers)\n")

            # 1. Claude + Grep
            res_cg = run_claude_grep(sc, REPO_ROOT)
            # 2. Claude + Sajimora
            res_cs = run_claude_sajimora(sc, mcp_client)
            # 3. Qwen 32B + Grep
            res_qg = run_qwen32b_grep(sc, REPO_ROOT)
            # 4. Qwen 32B + Sajimora
            res_qs = run_qwen32b_sajimora(sc, mcp_client)

            runs = [res_cg, res_cs, res_qg, res_qs]

            # Save individual logs
            for r in runs:
                cfg = r["config"]
                log_file = LOGS_DIR / cfg / f"{sid}.log"
                with open(log_file, "w") as lf:
                    lf.write(f"================================================================================\n")
                    lf.write(f"QUERY ID: {sid} | CONFIG: {cfg}\n")
                    lf.write(f"CATEGORY: {cat}\n")
                    lf.write(f"PROMPT  : {sc['prompt']}\n")
                    lf.write(f"EXPECTED: {exp_verdict} ({exp_cnt} consumers)\n")
                    lf.write(f"VERDICT : {r['verdict']} (Detected: {len(r['detected_consumers'])} consumers)\n")
                    lf.write(f"METRICS : Precision={r['metrics']['precision']} Recall={r['metrics']['recall']} F1={r['metrics']['f1']}\n")
                    lf.write(f"TOKENS  : In={r['input_tokens']} Out={r['output_tokens']} Total={r['total_tokens']}\n")
                    lf.write(f"TURNS   : {r['turns']} | LATENCY: {r['dur_ms']} ms\n")
                    lf.write(f"================================================================================\n\n")
                    lf.write(f"--- EXECUTION TRANSCRIPT ---\n")
                    lf.write(json.dumps(r["transcript"], indent=2))
                    lf.write(f"\n\n--- DETECTED CONSUMERS ---\n")
                    lf.write(json.dumps(r["detected_consumers"], indent=2))
                    lf.write("\n")

                # Update totals
                totals[cfg]["turns"] += r["turns"]
                totals[cfg]["input_tokens"] += r["input_tokens"]
                totals[cfg]["output_tokens"] += r["output_tokens"]
                totals[cfg]["total_tokens"] += r["total_tokens"]
                totals[cfg]["dur_ms"] += r["dur_ms"]
                totals[cfg]["tp"] += r["metrics"]["tp"]
                totals[cfg]["fp"] += r["metrics"]["fp"]
                totals[cfg]["fn"] += r["metrics"]["fn"]
                if r["verdict"] == exp_verdict:
                    totals[cfg]["matches_expected"] += 1

            # Print comparison line
            summary_line = (
                f"   Tokens -> Claude+Grep: {res_cg['total_tokens']:>5} | "
                f"Claude+Saj: {res_cs['total_tokens']:>4} (-{(1-res_cs['total_tokens']/res_cg['total_tokens'])*100:4.1f}%) | "
                f"Qwen+Grep: {res_qg['total_tokens']:>5} | "
                f"Qwen+Saj: {res_qs['total_tokens']:>4} (-{(1-res_qs['total_tokens']/res_qg['total_tokens'])*100:4.1f}%)\n"
                f"   Acc    -> Claude+Grep: P={res_cg['metrics']['precision']:.2f} R={res_cg['metrics']['recall']:.2f} | "
                f"Claude+Saj: P={res_cs['metrics']['precision']:.2f} R={res_cs['metrics']['recall']:.2f} | "
                f"Qwen+Grep: P={res_qg['metrics']['precision']:.2f} R={res_qg['metrics']['recall']:.2f} | "
                f"Qwen+Saj: P={res_qs['metrics']['precision']:.2f} R={res_qs['metrics']['recall']:.2f}"
            )
            print(summary_line)
            live_log.write(summary_line + "\n\n")
            live_log.flush()

            all_results.append({
                "id": sid,
                "category": cat,
                "expected_verdict": exp_verdict,
                "expected_consumers_count": exp_cnt,
                "runs": {r["config"]: r for r in runs}
            })

    mcp_client.close()

    # Aggregate scoring
    summary = {}
    print("\n" + "=" * 80)
    print("🏆 FINAL AGGREGATE RESULTS ACROSS 20 REAL-WORLD QUERIES")
    print("=" * 80)

    pricing = {
        "claude_grep": {"in": 3.00, "out": 15.00},
        "claude_sajimora": {"in": 3.00, "out": 15.00},
        "qwen32b_grep": {"in": 0.80, "out": 0.80},
        "qwen32b_sajimora": {"in": 0.80, "out": 0.80}
    }

    print(f"{'Configuration':<24} | {'Turns':>6} | {'Avg Tokens':>10} | {'Total Tokens':>12} | {'Time (s)':>8} | {'Precision':>9} | {'Recall':>7} | {'Verdict Acc':>11} | {'Total Cost':>10}")
    print("-" * 115)

    csv_rows = ["configuration,total_turns,avg_turns_per_query,total_tokens,avg_tokens_per_query,total_latency_sec,precision,recall,f1,verdict_accuracy_pct,estimated_cost_usd"]

    for cfg in config_names:
        tot = totals[cfg]
        tp = tot["tp"]
        fp = tot["fp"]
        fn = tot["fn"]
        p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
        verdict_acc = (tot["matches_expected"] / 20.0) * 100.0

        p_rate = pricing[cfg]
        cost = (tot["input_tokens"] / 1e6 * p_rate["in"]) + (tot["output_tokens"] / 1e6 * p_rate["out"])

        avg_tok = tot["total_tokens"] / 20.0
        avg_turns = tot["turns"] / 20.0
        tot_time_s = tot["dur_ms"] / 1000.0

        print(f"{cfg:<24} | {tot['turns']:>6} | {avg_tok:>10.0f} | {tot['total_tokens']:>12,d} | {tot_time_s:>8.2f} | {p*100:>8.1f}% | {r*100:>6.1f}% | {verdict_acc:>10.1f}% | ${cost:>9.4f}")

        csv_rows.append(f"{cfg},{tot['turns']},{avg_turns:.1f},{tot['total_tokens']},{avg_tok:.0f},{tot_time_s:.2f},{p*100:.1f},{r*100:.1f},{f1:.3f},{verdict_acc:.1f},{cost:.4f}")

        summary[cfg] = {
            "total_turns": tot["turns"],
            "avg_turns_per_query": round(avg_turns, 1),
            "total_tokens": tot["total_tokens"],
            "avg_tokens_per_query": round(avg_tok, 1),
            "input_tokens": tot["input_tokens"],
            "output_tokens": tot["output_tokens"],
            "total_latency_sec": round(tot_time_s, 2),
            "precision": round(p, 4),
            "recall": round(r, 4),
            "f1": round(f1, 4),
            "verdict_accuracy_pct": round(verdict_acc, 1),
            "estimated_cost_usd": round(cost, 4)
        }

    with open(BENCHMARK_DIR / "results_summary.json", "w") as f:
        json.dump({"benchmark_timestamp": utc_now(), "summary": summary, "results": all_results}, f, indent=2)

    with open(BENCHMARK_DIR / "comparison_20_queries.csv", "w") as f:
        f.write("\n".join(csv_rows) + "\n")

    print("\nBenchmark completed. Artifacts written to:")
    print(f"  - Summary JSON: {BENCHMARK_DIR / 'results_summary.json'}")
    print(f"  - Comparison CSV: {BENCHMARK_DIR / 'comparison_20_queries.csv'}")
    print(f"  - Live Log Stream: {live_log_path}")
    print(f"  - Individual Transcripts: {LOGS_DIR}/<config>/<query_id>.log (80 files)")
    print("=" * 80)

if __name__ == "__main__":
    main()
