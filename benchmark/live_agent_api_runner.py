#!/usr/bin/env python3
"""
Sajimora Live LLM API Benchmark Harness
Executes 100% REAL live API calls to Anthropic (Claude) and OpenAI-compatible providers
(OpenRouter / Together / Ollama / vLLM) for Qwen 2.5 32B.

NO internal guessing. NO heuristic simulation.
Captures live HTTP requests, raw API response JSON, real provider token usage,
and step-by-step tool execution logs.

Supported Provider Endpoints:
  1. Anthropic Direct:
     export ANTHROPIC_API_KEY="sk-ant-..."
  2. OpenRouter (Hosts both Claude 3.5 Sonnet and Qwen 2.5 32B Coder):
     export OPENROUTER_API_KEY="sk-or-..."
  3. Local Ollama / vLLM:
     --base-url http://localhost:11434/v1
"""

import os
import sys
import json
import time
import re
import argparse
import subprocess
import requests
from pathlib import Path
from datetime import datetime, timezone

REPO_ROOT = "/home/ec2-user/thingsboard"
BENCHMARK_DIR = Path("/home/ec2-user/Sajimora-v0.10/benchmark")
SCENARIOS_FILE = BENCHMARK_DIR / "eval_20_scenarios.json"
LIVE_LOGS_DIR = BENCHMARK_DIR / "live_api_logs"

RELEASE_BIN = Path("/home/ec2-user/Sajimora-v0.10/rust/target/release/sajimora-mcp")
DEBUG_BIN = Path("/home/ec2-user/Sajimora-v0.10/rust/target/debug/sajimora-mcp")
MCP_BIN = str(RELEASE_BIN if RELEASE_BIN.exists() else DEBUG_BIN)

def utc_now():
    return datetime.now(timezone.utc).isoformat()

# ==============================================================================
# Local Tool Implementations (Executed when LLM issues tool_calls)
# ==============================================================================

def execute_grep(pattern: str, file_pattern: str = "*.ts", path: str = "ui-ngx/src/app") -> str:
    target_dir = os.path.join(REPO_ROOT, path)
    cmd = [
        "grep", "-rnE",
        "--exclude-dir=.git", "--exclude-dir=node_modules",
        "--exclude-dir=target", "--exclude-dir=.sajimora",
        f"--include={file_pattern}",
        pattern,
        target_dir
    ]
    t0 = time.perf_counter()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=8.0)
        lines = p.stdout.splitlines()[:50]  # Cap at 50 lines to prevent context overflow
        return "\n".join(lines) if lines else "No matches found."
    except Exception as e:
        return f"Error executing grep: {e}"

def execute_read_file(file_path: str, start_line: int = 1, end_line: int = 100) -> str:
    full_path = os.path.join(REPO_ROOT, file_path) if not os.path.isabs(file_path) else file_path
    if not os.path.exists(full_path):
        return f"Error: File {file_path} does not exist."
    try:
        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        selected = lines[max(0, start_line - 1):end_line]
        return "".join([f"{i+start_line}: {l}" for i, l in enumerate(selected)])
    except Exception as e:
        return f"Error reading file: {e}"

class MCPClient:
    def __init__(self, bin_path, repo_root):
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
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "live-api-bench", "version": "1.0"}
            }
        })
        self.read_rpc()
        self.send_rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send_rpc(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read_rpc(self):
        line = self.proc.stdout.readline()
        return json.loads(line) if line else None

    def call_what_if(self, arguments):
        self.req_id += 1
        self.send_rpc({
            "jsonrpc": "2.0", "id": self.req_id + 10,
            "method": "tools/call",
            "params": {"name": "sajimora_what_if", "arguments": arguments}
        })
        res = self.read_rpc()
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        return content

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=2)
        except Exception:
            pass

# ==============================================================================
# Live LLM API Clients
# ==============================================================================

class AnthropicLiveClient:
    def __init__(self, api_key: str, model: str = "claude-3-5-sonnet-20241022"):
        self.api_key = api_key
        self.model = model
        self.url = "https://api.anthropic.com/v1/messages"
        self.headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

    def chat(self, messages, tools=None):
        payload = {
            "model": self.model,
            "max_tokens": 1024,
            "messages": messages
        }
        if tools:
            payload["tools"] = tools

        t0 = time.perf_counter()
        resp = requests.post(self.url, headers=self.headers, json=payload, timeout=60)
        dur_ms = (time.perf_counter() - t0) * 1000.0

        if resp.status_code != 200:
            raise RuntimeError(f"Anthropic API Error {resp.status_code}: {resp.text}")

        data = resp.json()
        return data, dur_ms

class OpenAILiveClient:
    """Supports OpenRouter, Together AI, Ollama, vLLM, or direct OpenAI."""
    def __init__(self, api_key: str, base_url: str = "https://openrouter.ai/api/v1", model: str = "qwen/qwen-2.5-coder-32b-instruct"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        if "openrouter.ai" in base_url:
            self.headers["HTTP-Referer"] = "https://github.com/sajimoraofficial"
            self.headers["X-Title"] = "Sajimora Benchmark"

    def chat(self, messages, tools=None):
        payload = {
            "model": self.model,
            "max_tokens": 1024,
            "messages": messages
        }
        if tools:
            payload["tools"] = tools

        url = f"{self.base_url}/chat/completions"
        for attempt in range(10):
            t0 = time.perf_counter()
            resp = requests.post(url, headers=self.headers, json=payload, timeout=60)
            dur_ms = (time.perf_counter() - t0) * 1000.0

            if resp.status_code == 429:
                wait_s = min(10 * (attempt + 1), 60)
                print(f"       [RateLimit 429 on {self.model}: waiting {wait_s}s before retry (attempt {attempt+1}/10)...]")
                time.sleep(wait_s)
                continue

            if resp.status_code != 200:
                raise RuntimeError(f"OpenAI/OpenRouter Error {resp.status_code}: {resp.text}")

            return resp.json(), dur_ms

# ==============================================================================
# Tool Schemas for Live Function Calling
# ==============================================================================

GREP_TOOLS_ANTHROPIC = [
    {
        "name": "grep_search",
        "description": "Searches for regex or string pattern in frontend TypeScript/HTML files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex or substring pattern to search"},
                "file_pattern": {"type": "string", "description": "File glob e.g. *.ts or *.html"}
            },
            "required": ["pattern"]
        }
    },
    {
        "name": "read_file",
        "description": "Reads lines from a file in the repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Relative file path from repo root"},
                "start_line": {"type": "integer", "description": "Starting line number (1-based)"},
                "end_line": {"type": "integer", "description": "Ending line number (inclusive)"}
            },
            "required": ["file_path"]
        }
    }
]

SAJIMORA_TOOLS_ANTHROPIC = [
    {
        "name": "sajimora_what_if",
        "description": "Simulates contract and consumer impact of a hypothetical change in-memory using deterministic AST join.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repoRoot": {"type": "string", "description": "Absolute repository root"},
                "mutation": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["RENAME_FIELD", "REMOVE_FIELD", "CHANGE_TYPE", "DELETE_ENDPOINT"]},
                        "route": {"type": "string"},
                        "method": {"type": "string"},
                        "targetDto": {"type": "string"},
                        "field": {"type": "string"},
                        "renameTo": {"type": "string"}
                    }
                }
            },
            "required": ["repoRoot", "mutation"]
        }
    }
]

GREP_TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": "grep_search",
            "description": "Searches for regex or string pattern in frontend TypeScript/HTML files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex or substring pattern to search"},
                    "file_pattern": {"type": "string", "description": "File glob e.g. *.ts or *.html"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads lines from a file in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Relative file path from repo root"},
                    "start_line": {"type": "integer", "description": "Starting line number (1-based)"},
                    "end_line": {"type": "integer", "description": "Ending line number"}
                },
                "required": ["file_path"]
            }
        }
    }
]

SAJIMORA_TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": "sajimora_what_if",
            "description": "Simulates contract and consumer impact of a hypothetical change in-memory using deterministic AST join.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repoRoot": {"type": "string", "description": "Absolute repository root"},
                    "mutation": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["RENAME_FIELD", "REMOVE_FIELD", "CHANGE_TYPE", "DELETE_ENDPOINT"]},
                            "route": {"type": "string"},
                            "method": {"type": "string"},
                            "targetDto": {"type": "string"},
                            "field": {"type": "string"},
                            "renameTo": {"type": "string"}
                        }
                    }
                },
                "required": ["repoRoot", "mutation"]
            }
        }
    }
]

# ==============================================================================
# Autonomous Live Agent Loops
# ==============================================================================

def run_live_anthropic_session(client, prompt, use_sajimora, mcp_client, max_turns=6):
    messages = [
        {"role": "user", "content": f"You are a principal engineer auditing API changes in {REPO_ROOT}.\nTask: {prompt}\nDetermine if this change is BREAKING or SAFE for the Angular frontend. Output your verdict and affected client files."}
    ]
    tools = SAJIMORA_TOOLS_ANTHROPIC if use_sajimora else GREP_TOOLS_ANTHROPIC

    turns = 0
    total_in_tokens = 0
    total_out_tokens = 0
    transcript = []

    while turns < max_turns:
        turns += 1
        resp_data, dur_ms = client.chat(messages, tools=tools)

        usage = resp_data.get("usage", {})
        in_tok = usage.get("input_tokens", 0)
        out_tok = usage.get("output_tokens", 0)
        total_in_tokens += in_tok
        total_out_tokens += out_tok

        content_blocks = resp_data.get("content", [])
        tool_calls = [b for b in content_blocks if b.get("type") == "tool_use"]
        text_blocks = [b.get("text", "") for b in content_blocks if b.get("type") == "text"]

        transcript.append({
            "turn": turns,
            "raw_api_response": resp_data,
            "dur_ms": round(dur_ms, 2)
        })

        if not tool_calls:
            # Final answer reached
            final_text = "\n".join(text_blocks)
            return {
                "turns": turns,
                "input_tokens": total_in_tokens,
                "output_tokens": total_out_tokens,
                "total_tokens": total_in_tokens + total_out_tokens,
                "final_answer": final_text,
                "transcript": transcript
            }

        # Handle tool call
        messages.append({"role": "assistant", "content": content_blocks})
        tool_results = []
        for tc in tool_calls:
            t_name = tc.get("name")
            t_args = tc.get("input", {})
            t_id = tc.get("id")

            if t_name == "sajimora_what_if":
                res_str = mcp_client.call_what_if(t_args)
            elif t_name == "grep_search":
                res_str = execute_grep(t_args.get("pattern", ""), t_args.get("file_pattern", "*.ts"))
            elif t_name == "read_file":
                res_str = execute_read_file(t_args.get("file_path", ""), t_args.get("start_line", 1), t_args.get("end_line", 100))
            else:
                res_str = f"Unknown tool: {t_name}"

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": t_id,
                "content": res_str
            })

        messages.append({"role": "user", "content": tool_results})

    return {
        "turns": turns,
        "input_tokens": total_in_tokens,
        "output_tokens": total_out_tokens,
        "total_tokens": total_in_tokens + total_out_tokens,
        "final_answer": "Reached max turns",
        "transcript": transcript
    }

def run_live_openai_session(client, prompt, use_sajimora, mcp_client, max_turns=6):
    messages = [
        {"role": "system", "content": f"You are a principal engineer auditing API changes in {REPO_ROOT}. Determine if change is BREAKING or SAFE for Angular frontend."},
        {"role": "user", "content": prompt}
    ]
    tools = SAJIMORA_TOOLS_OPENAI if use_sajimora else GREP_TOOLS_OPENAI

    turns = 0
    total_in_tokens = 0
    total_out_tokens = 0
    transcript = []

    while turns < max_turns:
        turns += 1
        resp_data, dur_ms = client.chat(messages, tools=tools)

        usage = resp_data.get("usage", {})
        in_tok = usage.get("prompt_tokens", 0)
        out_tok = usage.get("completion_tokens", 0)
        total_in_tokens += in_tok
        total_out_tokens += out_tok

        choice = resp_data.get("choices", [{}])[0]
        msg = choice.get("message", {})
        tool_calls = msg.get("tool_calls", [])
        text_content = msg.get("content", "")

        transcript.append({
            "turn": turns,
            "raw_api_response": resp_data,
            "dur_ms": round(dur_ms, 2)
        })

        if not tool_calls:
            return {
                "turns": turns,
                "input_tokens": total_in_tokens,
                "output_tokens": total_out_tokens,
                "total_tokens": total_in_tokens + total_out_tokens,
                "final_answer": text_content,
                "transcript": transcript
            }

        messages.append(msg)
        for tc in tool_calls:
            fn = tc.get("function", {})
            f_name = fn.get("name")
            f_args = json.loads(fn.get("arguments", "{}"))
            call_id = tc.get("id")

            if f_name == "sajimora_what_if":
                res_str = mcp_client.call_what_if(f_args)
            elif f_name == "grep_search":
                res_str = execute_grep(f_args.get("pattern", ""), f_args.get("file_pattern", "*.ts"))
            elif f_name == "read_file":
                res_str = execute_read_file(f_args.get("file_path", ""), f_args.get("start_line", 1), f_args.get("end_line", 100))
            else:
                res_str = f"Unknown tool {f_name}"

            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": f_name,
                "content": res_str
            })

    return {
        "turns": turns,
        "input_tokens": total_in_tokens,
        "output_tokens": total_out_tokens,
        "total_tokens": total_in_tokens + total_out_tokens,
        "final_answer": "Reached max turns",
        "transcript": transcript
    }

# ==============================================================================
# CLI Orchestrator
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(description="Live API Benchmark Harness for Claude and Qwen 32B")
    parser.add_argument("--provider", choices=["anthropic", "openrouter", "ollama", "vertex"], default="openrouter",
                        help="LLM Provider: anthropic, openrouter, or local ollama")
    parser.add_argument("--api-key", default=os.getenv("OPENROUTER_API_KEY", os.getenv("ANTHROPIC_API_KEY", "")))
    parser.add_argument("--vertex-credentials", default="/home/ec2-user/vertex_credentials.json")
    parser.add_argument("--base-url", default="https://openrouter.ai/api/v1")
    parser.add_argument("--claude-model", default="anthropic/claude-3.5-sonnet")
    parser.add_argument("--qwen-model", default="qwen/qwen-2.5-coder-32b-instruct")
    parser.add_argument("--scenarios", default=str(SCENARIOS_FILE))
    parser.add_argument("--limit", type=int, default=20, help="Number of queries to run")
    parser.add_argument("--max-turns", type=int, default=20, help="Maximum turns for agent loop (default 20)")
    args = parser.parse_args()

    print("=" * 80)
    print("🚀 LIVE API CALLS BENCHMARK HARNESS (ZERO INTERNAL GUESSING)")
    print(f"Provider: {args.provider.upper()} | Base URL: {args.base_url}")
    print(f"Claude Model: {args.claude_model} | Qwen Model: {args.qwen_model}")
    print("=" * 80)

    if not args.api_key and args.provider not in ["ollama", "vertex"]:
        print(f"\n❌ Error: No API key provided for {args.provider}.")
        print("Set one of:")
        print("  export OPENROUTER_API_KEY='sk-or-...' (Provides BOTH Claude and Qwen 32B!)")
        print("  export ANTHROPIC_API_KEY='sk-ant-...'")
        print("\nOr run with local Ollama:")
        print("  python3 live_agent_api_runner.py --provider ollama --base-url http://localhost:11434/v1")
        sys.exit(1)

    # Initialize Clients
    if args.provider == "anthropic":
        claude_client = AnthropicLiveClient(args.api_key, model=args.claude_model)
        # For Qwen under anthropic provider, fallback to OpenRouter or alert
        qwen_client = None
    elif args.provider == "vertex":
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
        creds = service_account.Credentials.from_service_account_file(
            args.vertex_credentials,
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        creds.refresh(Request())
        vertex_base = f"https://aiplatform.googleapis.com/v1beta1/projects/{creds.project_id}/locations/global/endpoints/openapi"
        model_name = args.claude_model if "gemini" in args.claude_model else "google/gemini-3.5-flash"
        claude_client = OpenAILiveClient(creds.token, base_url=vertex_base, model=model_name)
        qwen_client = None
    else:
        # OpenRouter / Ollama supports both
        claude_client = OpenAILiveClient(args.api_key, base_url=args.base_url, model=args.claude_model)
        qwen_client = OpenAILiveClient(args.api_key, base_url=args.base_url, model=args.qwen_model)

    mcp_client = MCPClient(MCP_BIN, REPO_ROOT)

    with open(args.scenarios) as f:
        scenarios = json.load(f)[:args.limit]

    configs = ["claude_grep", "claude_sajimora"]
    if qwen_client:
        configs.extend(["qwen32b_grep", "qwen32b_sajimora"])

    for cfg in configs:
        os.makedirs(LIVE_LOGS_DIR / cfg, exist_ok=True)

    print(f"\nLoaded {len(scenarios)} scenarios. Ready to execute live HTTP API calls.\n")

    for idx, sc in enumerate(scenarios):
        sid = sc["id"]
        cat = sc.get("sub_category", sc.get("category"))
        prompt = sc["prompt"]

        print(f"[{idx+1:02d}/{len(scenarios)}] Executing Live API calls for Query {sid} ({cat})...")

        # 1. Claude with Grep (Live API tool loop)
        print("   -> Live API Call: Claude + Grep...")
        if args.provider == "anthropic":
            res_cg = run_live_anthropic_session(claude_client, prompt, use_sajimora=False, mcp_client=mcp_client, max_turns=args.max_turns)
        else:
            res_cg = run_live_openai_session(claude_client, prompt, use_sajimora=False, mcp_client=mcp_client, max_turns=args.max_turns)

        with open(LIVE_LOGS_DIR / "claude_grep" / f"{sid}.json", "w") as f:
            json.dump(res_cg, f, indent=2)

        # 2. Claude with Sajimora (Live API tool loop)
        print("   -> Live API Call: Claude + Sajimora...")
        if args.provider == "anthropic":
            res_cs = run_live_anthropic_session(claude_client, prompt, use_sajimora=True, mcp_client=mcp_client, max_turns=args.max_turns)
        else:
            res_cs = run_live_openai_session(claude_client, prompt, use_sajimora=True, mcp_client=mcp_client, max_turns=args.max_turns)

        with open(LIVE_LOGS_DIR / "claude_sajimora" / f"{sid}.json", "w") as f:
            json.dump(res_cs, f, indent=2)

        print(f"      Claude Grep Tokens: {res_cg['total_tokens']} (Turns: {res_cg['turns']}) | Claude Sajimora: {res_cs['total_tokens']} (Turns: {res_cs['turns']})")
        time.sleep(2)

        # 3 & 4. Qwen 32B (if configured)
        if qwen_client:
            print("   -> Live API Call: Qwen 32B + Grep...")
            res_qg = run_live_openai_session(qwen_client, prompt, use_sajimora=False, mcp_client=mcp_client, max_turns=args.max_turns)
            with open(LIVE_LOGS_DIR / "qwen32b_grep" / f"{sid}.json", "w") as f:
                json.dump(res_qg, f, indent=2)

            print("   -> Live API Call: Qwen 32B + Sajimora...")
            res_qs = run_live_openai_session(qwen_client, prompt, use_sajimora=True, mcp_client=mcp_client, max_turns=args.max_turns)
            with open(LIVE_LOGS_DIR / "qwen32b_sajimora" / f"{sid}.json", "w") as f:
                json.dump(res_qs, f, indent=2)

            print(f"      Qwen Grep Tokens: {res_qg['total_tokens']} (Turns: {res_qg['turns']}) | Qwen Sajimora: {res_qs['total_tokens']} (Turns: {res_qs['turns']})")

    mcp_client.close()
    print("\n✅ All Live API benchmark tests completed. Raw payloads saved in:", LIVE_LOGS_DIR)

if __name__ == "__main__":
    main()
