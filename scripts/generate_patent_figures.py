import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path("patent_deliverables")
OUT.mkdir(exist_ok=True)

def get_font(size, bold=False):
    try:
        name = "arialbd.ttf" if bold else "arial.ttf"
        return ImageFont.truetype(name, size)
    except Exception:
        return ImageFont.load_default()

def draw_rounded_rect(draw, bbox, fill, outline, width=2, radius=8):
    draw.rounded_rectangle(bbox, radius=radius, fill=fill, outline=outline, width=width)

def draw_arrow_down(draw, x, y1, y2, color="black", width=3, arrow_size=10):
    draw.line((x, y1, x, y2), fill=color, width=width)
    draw.polygon([(x, y2), (x - arrow_size, y2 - arrow_size), (x + arrow_size, y2 - arrow_size)], fill=color)

def draw_arrow_right(draw, x1, y, x2, color="black", width=3, arrow_size=10):
    draw.line((x1, y, x2, y), fill=color, width=width)
    draw.polygon([(x2, y), (x2 - arrow_size, y - arrow_size), (x2 - arrow_size, y + arrow_size)], fill=color)

def draw_centered_text(draw, bbox, text, font, fill="black"):
    lines = text.split("\n")
    # compute total height
    line_heights = []
    line_widths = []
    for l in lines:
        left, top, right, bottom = draw.textbbox((0, 0), l, font=font)
        line_widths.append(right - left)
        line_heights.append(bottom - top + 4)
    total_h = sum(line_heights)
    cur_y = bbox[1] + (bbox[3] - bbox[1] - total_h) / 2
    for i, l in enumerate(lines):
        w = line_widths[i]
        cur_x = bbox[0] + (bbox[2] - bbox[0] - w) / 2
        draw.text((cur_x, cur_y), l, font=font, fill=fill)
        cur_y += line_heights[i]

def generate_fig1_lifecycle():
    # 1600 x 950
    W, H = 1600, 950
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    # Title
    d.text((60, 40), "FIGURE 1 - REVISION-KEYED COMPILER INGESTION & QUERY LIFECYCLE", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    stages = [
        ("Phase A: Ingest Repository Revision", "Construct isolated compiler context for parent revision"),
        ("Phase B: Semantic Extraction", "Derive TypeIR, candidate signatures, and call obligations"),
        ("Phase C: Selective Materialization", "Serialize query-sufficient contracts; exclude AST & checkers"),
        ("Phase D: Persistent Index Storage", "Atomically commit records into file-backed SQLite database"),
        ("Phase E: Compiler-State Release", "Nullify compiler references; clear maps; invoke disposal"),
        ("Phase F: Context Teardown", "Terminate ingestion process or seal execution boundary"),
        ("Phase G: Independent Query Context", "Instantiate isolated warm analysis context without compiler"),
        ("Phase H: Persistent Contract Retrieval", "Evaluate semantic obligations directly from indexed contracts")
    ]
    
    box_w = 1100
    box_h = 70
    start_x = (W - box_w) // 2
    start_y = 110
    step_y = 100
    
    for i, (title, sub) in enumerate(stages):
        y = start_y + i * step_y
        bg = "#f0f4f8" if i % 2 == 0 else "#ffffff"
        border_col = "#0b3c61" if i >= 6 else "#1a365d"
        draw_rounded_rect(d, (start_x, y, start_x + box_w, y + box_h), fill=bg, outline=border_col, width=2)
        
        # Draw stage badge
        d.text((start_x + 25, y + 16), title, font=get_font(20, True), fill="#0b3c61")
        d.text((start_x + 25, y + 42), sub, font=get_font(15, False), fill="#333333")
        
        if i < len(stages) - 1:
            draw_arrow_down(d, W // 2, y + box_h, y + step_y, color="#0b3c61", width=3, arrow_size=8)
            
    im.save(OUT / "fig_lifecycle.png")
    print("Generated fig_lifecycle.png")

def generate_fig2_before_after():
    W, H = 1600, 950
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    d.text((60, 40), "FIGURE 2 - CONVENTIONAL RECONSTRUCTION VS. DISCLOSED PERSISTENT PATH", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    # Upper Section: Conventional Path
    d.text((60, 105), "CONVENTIONAL ANALYSIS ARCHITECTURE (REPEATED RECONSTRUCTION / MONOLITHIC HEAP)", font=get_font(20, True), fill="#b71c1c")
    draw_rounded_rect(d, (60, 140, W - 60, 440), fill="#fff8f8", outline="#e57373", width=2)
    
    conv_steps = [
        "1. Revision Input\n(Full Git Tree)",
        "2. Monolithic Compiler\n(ts.Program + AST Graph)",
        "3. Initial Extraction\n(In-Memory Objects)",
        "4. Subsequent Query\n(Reconstruct Program)",
        "5. Re-scan Full AST\n(Heap Pressure & OOM)"
    ]
    bw = 250
    bh = 110
    gap = ( (W - 160) - (len(conv_steps) * bw) ) // (len(conv_steps) - 1)
    top_y = 200
    
    for i, step in enumerate(conv_steps):
        x = 80 + i * (bw + gap)
        draw_rounded_rect(d, (x, top_y, x + bw, top_y + bh), fill="#ffffff", outline="#b71c1c", width=2)
        draw_centered_text(d, (x, top_y, x + bw, top_y + bh), step, get_font(16, True), fill="#b71c1c")
        if i < len(conv_steps) - 1:
            draw_arrow_right(d, x + bw, top_y + bh // 2, x + bw + gap, color="#b71c1c", width=3, arrow_size=8)
            
    d.text((80, 360), "CRITICAL FLAW: Retained compiler objects across queries exhaust V8 heap (> 4.0 GiB), resulting in fatal OOM aborts.", font=get_font(17, True), fill="#b71c1c")
    
    # Lower Section: Disclosed Architecture
    d.text((60, 480), "DISCLOSED SAJIMORA ARCHITECTURE 5 (SELECTIVE MATERIALIZATION & ISOLATED QUERY)", font=get_font(20, True), fill="#1b5e20")
    draw_rounded_rect(d, (60, 515, W - 60, 890), fill="#f4faf4", outline="#81c784", width=2)
    
    disc_steps = [
        "1. Compiler Context\n(Extract Reusable Contracts)",
        "2. Persistent Index\n(SQLite SemanticIndex)",
        "3. Explicit Release\n(Sever Object Retainers)",
        "4. Independent Context\n(Zero Compiler Allocation)",
        "5. Indexed Verification\n(Strictly Bounded RSS)"
    ]
    top_y2 = 580
    for i, step in enumerate(disc_steps):
        x = 80 + i * (bw + gap)
        draw_rounded_rect(d, (x, top_y2, x + bw, top_y2 + bh), fill="#ffffff", outline="#1b5e20", width=2)
        draw_centered_text(d, (x, top_y2, x + bw, top_y2 + bh), step, get_font(16, True), fill="#1b5e20")
        if i < len(disc_steps) - 1:
            draw_arrow_right(d, x + bw, top_y2 + bh // 2, x + bw + gap, color="#1b5e20", width=3, arrow_size=8)
            
    d.text((80, 770), "TECHNICAL EFFECT: Zero ts.Program creation in warm path; bounded RSS (126.9-128.0 MB); 3.15x campaign latency reduction.", font=get_font(17, True), fill="#1b5e20")

    im.save(OUT / "fig_before_after.png")
    print("Generated fig_before_after.png")

def generate_fig3_retention():
    W, H = 1600, 750
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    d.text((60, 40), "FIGURE 3 - MANAGED RUNTIME (V8 / NODE.JS) COMPILER-STATE RELEASE EMBODIMENT", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    # BEFORE PANEL
    d.text((60, 110), "BEFORE DISPOSAL: RETAINED COMPILER OBJECT GRAPH (V8 MANAGED HEAP BLOAT)", font=get_font(19, True), fill="#b71c1c")
    draw_rounded_rect(d, (60, 140, W - 60, 390), fill="#fffbfb", outline="#e57373", width=2)
    
    boxes_before = [
        "AnalysisContext\n(Active Session)",
        "ts.Program\n(Compiler Instance)",
        "TypeChecker\n(Symbol Table)",
        "SourceFiles\n(AST Node Trees)",
        "Application Closures\n(Memory Leaks)",
        "Retained Heap\n(Continued RSS Bloat)"
    ]
    bw = 215
    bh = 95
    gap = ((W - 160) - (len(boxes_before) * bw)) // (len(boxes_before) - 1)
    y1 = 200
    for i, box in enumerate(boxes_before):
        x = 80 + i * (bw + gap)
        draw_rounded_rect(d, (x, y1, x + bw, y1 + bh), fill="#ffffff", outline="#b71c1c", width=2)
        draw_centered_text(d, (x, y1, x + bw, y1 + bh), box, get_font(15, True), fill="#b71c1c")
        if i < len(boxes_before) - 1:
            draw_arrow_right(d, x + bw, y1 + bh // 2, x + bw + gap, color="#b71c1c", width=3, arrow_size=7)
            
    d.text((80, 335), "Status: Retaining paths prevent V8 Garbage Collector from reclaiming large AST and TypeChecker memory graphs.", font=get_font(15, False), fill="#555555")

    # AFTER PANEL
    d.text((60, 430), "AFTER DISPOSAL: EXPLICIT DE-REFERENCING & PROCESS ISOLATION", font=get_font(19, True), fill="#1b5e20")
    draw_rounded_rect(d, (60, 460, W - 60, 710), fill="#f7fbf7", outline="#81c784", width=2)
    
    boxes_after = [
        "AnalysisContext\n.dispose() Invoked",
        "Program & Checker\nNullified (Explicit)",
        "SourceFile Maps\nArrays Cleared",
        "Persistent Store\n(Validated Commit)",
        "Compiler Process\nTerminated / Isolated",
        "Subsequent Queries\n(Zero Retained Graph)"
    ]
    y2 = 520
    for i, box in enumerate(boxes_after):
        x = 80 + i * (bw + gap)
        draw_rounded_rect(d, (x, y2, x + bw, y2 + bh), fill="#ffffff", outline="#1b5e20", width=2)
        draw_centered_text(d, (x, y2, x + bw, y2 + bh), box, get_font(15, True), fill="#1b5e20")
        if i < len(boxes_after) - 1:
            draw_arrow_right(d, x + bw, y2 + bh // 2, x + bw + gap, color="#1b5e20", width=3, arrow_size=7)
            
    d.text((80, 655), "Status: All retaining paths explicitly severed; V8 GC collects dead compiler objects; warm queries operate from SQLite.", font=get_font(15, False), fill="#555555")

    im.save(OUT / "fig_retention.png")
    print("Generated fig_retention.png")

def generate_fig4_flow():
    # Complete 3-Phase Method Flowchart
    W, H = 1600, 1100
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    d.text((60, 40), "FIGURE 4 - METHOD FLOWCHART: EXTERNALIZATION, CONSERVATION & VERIFICATION", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    # 3 Columns for 3 Phases
    col_w = 460
    col_gap = 40
    start_x = 60
    
    phases = [
        ("PHASE 1: COMPILER INGESTION", "#1a365d", "#f0f4f8", [
            ("Start Repository Analysis", "Receive parent & candidate Git commit trees"),
            ("Instantiate Ingestion Compiler", "Initialize revision-keyed ts.Program"),
            ("Discover Changed Entities", "Compute target closure E* across project graph"),
            ("Extract Consumer References", "Identify call sites, imports, dynamic boundaries"),
            ("Mint Scope Exclusion Proof", "Generate SHA-256 non-interference certificate")
        ]),
        ("PHASE 2: MATERIALIZATION & TEARDOWN", "#004d40", "#e0f2f1", [
            ("Derive Query Contracts", "Format TypeIR & candidate usage obligations"),
            ("Commit to SemanticIndexDatabase", "Atomic SQLite file-backed transaction"),
            ("Enforce Conservation Pre-Check", "|Accounted| = |Discovered| boundary verification"),
            ("Nullify Compiler References", "Sever SourceFile & TypeChecker object paths"),
            ("Terminate Ingestion Context", "Release V8 heap; exit ingestion isolate")
        ]),
        ("PHASE 3: PERSISTENT VERIFICATION", "#1b5e20", "#f1f8e9", [
            ("Receive Cross-Revision Query", "Warm query initiated in clean worker isolate"),
            ("Fail-Closed Completeness Gate", "Authorize retrieval iff proof obligations complete"),
            ("Replay Counterexample Witnesses", "Execution-local session verifies IEEE-754 outputs"),
            ("Cryptographic Authority Bridge", "Consult immutable VerdictAuthority root"),
            ("Emit Final Certified Ledger", "Emit PRESERVED, VIOLATED, or UNKNOWN verdict")
        ])
    ]
    
    for c_idx, (col_title, header_col, col_bg, steps) in enumerate(phases):
        cx = start_x + c_idx * (col_w + col_gap)
        # Column header
        draw_rounded_rect(d, (cx, 110, cx + col_w, 160), fill=header_col, outline=header_col, width=2)
        draw_centered_text(d, (cx, 110, cx + col_w, 160), col_title, get_font(18, True), fill="#ffffff")
        
        # Column container
        draw_rounded_rect(d, (cx, 175, cx + col_w, 1040), fill=col_bg, outline=header_col, width=1)
        
        step_y = 200
        step_h = 135
        for s_idx, (s_title, s_desc) in enumerate(steps):
            box_bbox = (cx + 20, step_y, cx + col_w - 20, step_y + step_h)
            draw_rounded_rect(d, box_bbox, fill="#ffffff", outline=header_col, width=2)
            
            # Badge
            d.text((cx + 35, step_y + 15), f"{c_idx+1}.{s_idx+1} {s_title}", font=get_font(16, True), fill=header_col)
            # Textwrap description
            d.text((cx + 35, step_y + 45), s_desc, font=get_font(14, False), fill="#333333")
            
            if s_idx < len(steps) - 1:
                draw_arrow_down(d, cx + col_w // 2, step_y + step_h, step_y + step_h + 30, color=header_col, width=2, arrow_size=6)
                
            step_y += step_h + 30
            
    # Cross-column arrows
    # Phase 1 to Phase 2
    draw_arrow_right(d, start_x + col_w, 980, start_x + col_w + col_gap, color="#1a365d", width=4, arrow_size=10)
    # Phase 2 to Phase 3
    draw_arrow_right(d, start_x + 2 * col_w + col_gap, 980, start_x + 2 * (col_w + col_gap), color="#004d40", width=4, arrow_size=10)

    im.save(OUT / "fig_flow.png")
    print("Generated fig_flow.png")

def generate_fig5_multiquery():
    W, H = 1600, 800
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    d.text((60, 40), "FIGURE 5 - MULTI-WORKER CONCURRENT CAMPAIGN EXECUTION & BENCHMARK", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    # 2 Big panels: Architecture and Performance
    # Left: Architecture
    d.text((60, 110), "MULTI-THREADED CONCURRENT CAMPAIGN HARNESS", font=get_font(19, True), fill="#1a365d")
    draw_rounded_rect(d, (60, 140, 780, 740), fill="#f8fafc", outline="#94a3b8", width=2)
    
    harness_boxes = [
        ("Query Campaign Dispatcher", "Reads semantic coverage manifest (911 queries across 6 tiers)"),
        ("Dynamic Worker Pool (6 Threads)", "Distributes verification tasks across isolated worker threads"),
        ("Shared Persistent Semantic Index", "SQLite file-backed store (zero compiler graph sharing)"),
        ("Conservation Gate & Epistemic Filter", "Enforces |Accounted| = |Discovered|; verifies counterexamples"),
        ("Authoritative Verdict Bridge", "Evaluates against frozen VerdictAuthority.ts (SHA-256 sealed)")
    ]
    by = 170
    for title, desc in harness_boxes:
        draw_rounded_rect(d, (90, by, 750, by + 85), fill="#ffffff", outline="#1e293b", width=2)
        d.text((110, by + 16), title, font=get_font(17, True), fill="#1e293b")
        d.text((110, by + 45), desc, font=get_font(14, False), fill="#475569")
        if by < 550:
            draw_arrow_down(d, 420, by + 85, by + 115, color="#1e293b", width=2, arrow_size=6)
        by += 115

    # Right: Benchmark Results
    d.text((820, 110), "REAL PRODUCTION BENCHMARK (911 QUERIES)", font=get_font(19, True), fill="#15803d")
    draw_rounded_rect(d, (820, 140, W - 60, 740), fill="#f0fdf4", outline="#86efac", width=2)
    
    metrics = [
        ("Total Verification Queries", "911 multi-revision pairs across 6 tiers"),
        ("Total Obligations Accounted", "2,673 obligations (100.0% conservation)"),
        ("Silent Drops / Dropped Calls", "0 (Mathematically verified)"),
        ("Sequential Campaign Runtime", "88.6 minutes (5,316,000 ms)"),
        ("Parallel Campaign Runtime (6 Workers)", "28.1 minutes (1,686,000 ms)"),
        ("Campaign Speedup Factor", "3.15x wall-clock latency reduction"),
        ("Compiler Errors / OOM Crashes", "0 errors across all 911 queries (100% stability)"),
        ("Verdict Authority Sealing", "Verified SHA-256 root integrity")
    ]
    my = 165
    for m_label, m_val in metrics:
        draw_rounded_rect(d, (850, my, W - 90, my + 58), fill="#ffffff", outline="#15803d", width=1)
        d.text((870, my + 10), m_label, font=get_font(15, True), fill="#14532d")
        d.text((870, my + 32), m_val, font=get_font(14, False), fill="#333333")
        my += 70

    im.save(OUT / "fig5_multiquery.png")
    print("Generated fig5_multiquery.png")

def generate_fig6_memory():
    W, H = 1600, 750
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    
    d.text((60, 40), "FIGURE 6 - MEASURED RESOURCE PROFILING & OOM PREVENTION", font=get_font(26, True), fill="#0d233a")
    d.line((60, 80, W - 60, 80), fill="#0b3c61", width=2)
    
    # 2 Comparison Panels
    d.text((60, 110), "BASELINE DUAL-COMPILER RECONSTRUCTION", font=get_font(19, True), fill="#b91c1c")
    draw_rounded_rect(d, (60, 140, 780, 700), fill="#fff5f5", outline="#fca5a5", width=2)
    
    base_rows = [
        ("Architecture", "Constructs 2 full ts.Programs on every revision comparison"),
        ("Heap Memory Trend", "Uncontrolled accumulation of AST nodes and symbol graphs"),
        ("Peak Resident Memory", "Exceeds 4,096 MB V8 heap limit"),
        ("Garbage Collector Latency", "Last GC cycle: 4,044.4 MB to 4,031.8 MB (exhaustion)"),
        ("Terminal Status", "FATAL ERROR: Ineffective mark-compacts near heap limit; Out of Memory (OOM) abort"),
        ("Queries Handled", "0 successful warm queries executed")
    ]
    ry = 170
    for lbl, val in base_rows:
        draw_rounded_rect(d, (85, ry, 755, ry + 75), fill="#ffffff", outline="#ef4444", width=1)
        d.text((100, ry + 12), lbl, font=get_font(15, True), fill="#991b1b")
        d.text((100, ry + 38), val, font=get_font(13, False), fill="#333333")
        ry += 86

    d.text((820, 110), "DISCLOSED ARCHITECTURE 5 PERSISTENT QUERY", font=get_font(19, True), fill="#15803d")
    draw_rounded_rect(d, (820, 140, W - 60, 700), fill="#f0fdf4", outline="#86efac", width=2)
    
    disc_rows = [
        ("Architecture", "Persistent SQLite materialization + isolated warm query engine"),
        ("Compiler Construction Invariant", "0 ts.Programs constructed in warm query path"),
        ("TypeChecker Construction Invariant", "0 TypeCheckers instantiated in warm query path"),
        ("AST Traversal Invariant", "0 AST nodes traversed in warm query path"),
        ("Observed Warm Resident Memory", "Strictly bounded: Query 1: 126.9 MB; Query 2: 127.5 MB; Query 3: 128.0 MB RSS"),
        ("Query Latency", "Sub-millisecond to 15.38 ms response time per warm query")
    ]
    ry2 = 170
    for lbl, val in disc_rows:
        draw_rounded_rect(d, (845, ry2, W - 85, ry2 + 75), fill="#ffffff", outline="#22c55e", width=1)
        d.text((860, ry2 + 12), lbl, font=get_font(15, True), fill="#166534")
        d.text((860, ry2 + 38), val, font=get_font(13, False), fill="#333333")
        ry2 += 86

    im.save(OUT / "fig6_memory.png")
    print("Generated fig6_memory.png")

if __name__ == "__main__":
    generate_fig1_lifecycle()
    generate_fig2_before_after()
    generate_fig3_retention()
    generate_fig4_flow()
    generate_fig5_multiquery()
    generate_fig6_memory()
    print("All patent figures generated successfully.")
