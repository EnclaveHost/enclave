#!/usr/bin/env python3
"""summarize-baseline.py <bench_dir> [queue_log] -- one table from cpu/bench-baseline.sh's output (PVM-CPU.md, "Measured baseline").

Per run and per turn: launch -> first token (cold start, from logcat's START and the turn window, both on the PHONE's clocks),
model load, time to first token (the turn window's first - start: prompt sent -> first token back), prefill and decode rates,
the CPU window (cores busy, core-ms per token; COMPLETE windows only), the VM's effective memory, and the live thermal trace
over the run (peak status, peak BIG temperature, lowest big-core caps, lowest MemAvailable). Also the crash run's verdicts."""
import csv, glob, json, os, re, sys

B = sys.argv[1]; QLOG = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/gguf-e2b/cpu-baseline.log")
def rd(p):
    try: return open(p, errors="replace").read()
    except OSError: return ""

# device boottime -> wall offset, from the crash script's last line (both clocks on the phone)
off = None
m = re.search(r"offset now: ([0-9.]+) ([0-9.]+)", rd(os.path.join(B, "crash.txt")))
if m: off = float(m.group(2)) - float(m.group(1))
starts = {}
for line in rd(os.path.join(B, "starts.txt")).splitlines():
    f = line.split()
    if len(f) == 2: starts[f[0]] = float(f[1])
m = re.search(r"START of the relaunch: ([0-9.]+)", rd(os.path.join(B, "crash.txt")))   # the crash script's relaunch (cr-02)
if m: starts["cr-02"] = float(m.group(1))
# thermal trace, and each run's wall window from the bench log's "== label (batch) HH:MM:SS" lines
th = list(csv.DictReader(open(os.path.join(B, "thermal.tsv")), delimiter="\t")) if os.path.exists(os.path.join(B, "thermal.tsv")) else []
dev = rd(os.path.join(B, "device.txt"))
t0 = None; m = re.search(r"started: (\S+)", dev)
if m:
    import datetime
    t0 = datetime.datetime.fromisoformat(m.group(1)).timestamp()

rows = []
for log in sorted(set(glob.glob(os.path.join(B, "**", "*.log"), recursive=True))):
    label = os.path.basename(log)[:-4]
    if label.endswith(".driver"): continue
    t = rd(log)
    if "CAPTURE BEGIN" not in t: continue
    runs = rd(os.path.join(os.path.dirname(log), "RUNS.tsv"))
    st = re.search(rf"^{re.escape(label)}\t[^\t]*\t[^\t]*\t(\w+)\t(\d+)", runs, re.M)
    status = f"{st.group(1)} rc={st.group(2)}" if st else "?"
    load = re.search(r"load_s=([0-9.]+)", t); mem = re.search(r"EFFECTIVE mem=(\d+) MiB", t)
    wins = {int(a): (int(b), int(c), int(d)) for a, b, c, d in re.findall(r"LOCAL turn (\d+) window boottime_ms start=(\d+) first=(\d+) end=(\d+)", t)}
    stats = {int(a): dict(kv.split("=", 1) for kv in b.split(", ")) for a, b in re.findall(r"LOCAL turn (\d+) STATS \{([^}]*)\}", t)}
    cpu = {int(a): (float(b), int(c), k) for a, k, b, c in re.findall(r"cpu turn (\d+) decode window [0-9.]+ s \(\d+ tokens\): (COMPLETE|INCOMPLETE)[^=]*= ([0-9.]+) cores busy, (\d+) core-ms", rd(log[:-4] + ".cpu"))}
    cold = None
    if 1 in wins and label in starts and off is not None: cold = wins[1][1] / 1000 + off - starts[label]
    for n in sorted(stats):
        s = stats[n]; w = wins.get(n); c = cpu.get(n)
        rows.append({"run": label, "status": status, "turn": n, "cold_start_s": round(cold, 1) if (n == 1 and cold) else None,
                     "load_s": float(load.group(1)) if (load and n == 1) else None,
                     "ttft_ms": (w[1] - w[0]) if w else None, "prefill_tok_s": float(s.get("prefill_tok_s", 0)), "decode_tokens": int(s.get("decode_tokens", 0)),
                     "decode_tok_s": float(s.get("decode_tok_s", 0)), "ctx_used": int(s.get("ctx_used", 0)),
                     "cores_busy": c[0] if c and c[2] == "COMPLETE" else None, "core_ms_per_token": c[1] if c and c[2] == "COMPLETE" else None,
                     "vm_mem_mib": int(mem.group(1)) if mem else None, "_win": w})

# thermal over each run: the bench log gives each run's start (wall) -- the trace's t_s is seconds since device.txt's start
blog = rd(QLOG)
run_start = {}
if t0:
    import datetime
    day = datetime.datetime.fromtimestamp(t0)
    for lab, hh in re.findall(r"^== (\S+) \([^)]*\) (\d\d:\d\d:\d\d)", blog, re.M):
        h, mi, se = map(int, hh.split(":")); run_start[lab] = day.replace(hour=h, minute=mi, second=se).timestamp() - t0
labels = sorted(run_start, key=run_start.get)
def therm(label):
    if not th or label not in run_start: return {}
    a = run_start[label]; nxt = [run_start[l] for l in labels if run_start[l] > a]; b = min(nxt) if nxt else 1e9
    seg = [r for r in th if a <= float(r["t_s"]) < b]
    if not seg: return {}
    f = lambda k: [float(r[k]) for r in seg if r[k] not in ("", None)]
    return {"status_max": int(max(f("status"))), "big_c_max": max(f("BIG")), "skin_c_max": round(max(f("skin")), 1),
            "cap_cpu2_min_ghz": min(f("cap_cpu2")) / 1e6, "cap_cpu7_min_ghz": min(f("cap_cpu7")) / 1e6, "mem_avail_min_mib": int(min(f("mem_avail_kb")) / 1024)}

print("| run | turn | status | cold start s | load s | TTFT ms | prefill tok/s | decode tokens | decode tok/s | cores busy | core-ms/token | VM MiB |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    g = lambda k: "" if r[k] is None else r[k]
    print(f"| {r['run']} | {r['turn']} | {r['status']} | {g('cold_start_s')} | {g('load_s')} | {g('ttft_ms')} | {r['prefill_tok_s']} | {r['decode_tokens']} | {r['decode_tok_s']} | {g('cores_busy')} | {g('core_ms_per_token')} | {g('vm_mem_mib')} |")
print()
print("| run | peak thermal status | peak BIG C | peak skin C | lowest cpu2 cap GHz | lowest cpu7 cap GHz | lowest MemAvailable MiB |")
print("|---|---|---|---|---|---|---|")
for lab in labels:
    x = therm(lab)
    if x: print(f"| {lab} | {x['status_max']} | {x['big_c_max']} | {x['skin_c_max']} | {x['cap_cpu2_min_ghz']:.3f} | {x['cap_cpu7_min_ghz']:.3f} | {x['mem_avail_min_mib']} |")
# per run: decode over every turn together (tokens / seconds) and the worst turn -- the sustained criterion (PVM-CPU.md target 2)
print()
print("| run | condition | turns | decode tokens | tok/s over the run | worst turn tok/s | core-ms/token (mean of turns) |")
print("|---|---|---|---|---|---|---|")
cond = dict(re.findall(r"^== (\S+) \(([^)]*)\)", blog, re.M))
for lab in sorted({r["run"] for r in rows}):
    t = [r for r in rows if r["run"] == lab and r["decode_tok_s"] > 0]
    if not t: continue
    tok = sum(r["decode_tokens"] for r in t); sec = sum(r["decode_tokens"] / r["decode_tok_s"] for r in t)
    cms = [r["core_ms_per_token"] for r in t if r["core_ms_per_token"]]
    print(f"| {lab} | {cond.get(lab, '')} | {len(t)} | {tok} | {tok / sec:.2f} | {min(r['decode_tok_s'] for r in t):.2f} | {sum(cms) / len(cms):.0f} |" if cms else f"| {lab} | {cond.get(lab, '')} | {len(t)} | {tok} | {tok / sec:.2f} | {min(r['decode_tok_s'] for r in t):.2f} | |")
json.dump([{k: v for k, v in r.items() if not k.startswith("_")} for r in rows], open(os.path.join(B, "summary.json"), "w"), indent=1)
