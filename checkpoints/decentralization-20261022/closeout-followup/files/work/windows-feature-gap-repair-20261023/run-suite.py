#!/usr/bin/env python3
"""Per-file test runner with honest aggregation (replaces job.sh/regress.sh, whose wrapper exit hid file failures).

  run-suite.py NAME [--tree DIR] [--drop-caps GLOB ...] [--allow-skip N] [--job-sec S] [--test-ms MS] -- test/a.test.mjs ...

Each file runs ALONE: `node --test` in a private user+net+pid namespace (loopback only, --kill-child), with ssh/scp/sftp
denial stubs first on PATH (proven before the first file). --drop-caps runs matching files with an EMPTY capability
bounding set (setpriv), so filesystem permission negatives are real even for the namespace's uid 0; --dummy-if gives
matching files a dummy non-loopback interface inside the namespace.
Per file: exit code and the reporter's own counts (tests/pass/fail/cancelled/skipped/todo) plus every skip reason.
A skip whose reason starts with "NOT RUN (native gate)" is a native gate that cannot run here: reported in its own
column, never counted as passed and never as an ordinary skip.
Suite verdict: FAIL if any file exits non-zero, reports fail/cancelled > 0, or reports no tests; or if ordinary skips
exceed --allow-skip (default 0). Writes logs/NAME.files.tsv, logs/NAME.<n>.out per file, and exits 0 only on PASS.
"""
import argparse, fnmatch, os, re, subprocess, sys, time

H = "/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023"
ap = argparse.ArgumentParser()
ap.add_argument("name"); ap.add_argument("--tree", default=f"{H}/candidate")
ap.add_argument("--drop-caps", action="append", default=[]); ap.add_argument("--dummy-if", action="append", default=[]); ap.add_argument("--allow-skip", type=int, default=0)
ap.add_argument("--job-sec", type=int, default=600); ap.add_argument("--test-ms", type=int, default=300000)
ap.add_argument("--extra-path", default="/home/steven/.foundry/bin"); ap.add_argument("--name-pattern", default=None)
ap.add_argument("files", nargs="+")
a = ap.parse_args()

env = dict(os.environ)
env["PATH"] = f"{H}/stubs:" + (a.extra_path + ":" if a.extra_path else "") + "/usr/local/bin:/usr/bin:/bin"
env["TMPDIR"] = f"{H}/tmp/t"; os.makedirs(env["TMPDIR"], exist_ok=True)
for t in ("ssh", "scp", "sftp"):
    p = subprocess.run(["sh", "-c", f'[ "$(command -v {t})" = "{H}/stubs/{t}" ] && {t} x'], env=env, capture_output=True)
    if p.returncode != 97: sys.exit(f"[suite] {t} is not the denial stub (rc {p.returncode})")
head = subprocess.run(["git", "-C", a.tree, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
dirty = subprocess.run(["git", "-C", a.tree, "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True).stdout.count("\n")
print(f"[suite] {a.name}: tree {a.tree} head {head} dirty={dirty}; ssh/scp/sftp -> denial stubs (rc 97)", flush=True)

NUM = re.compile(r"^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$")
SKIP = re.compile(r"^\s*﹣ (.*) \([\d.]+ms\) # (.*)$")
rows, verdict_fail, ordinary_skips, native = [], [], 0, []
os.makedirs(f"{H}/logs", exist_ok=True)
for i, f in enumerate(a.files):
    drop = any(fnmatch.fnmatch(f, g) for g in a.drop_caps)
    node = ["node", "--test", f"--test-timeout={a.test_ms}", "--test-concurrency=1", "--test-reporter=spec"] + ([f"--test-name-pattern={a.name_pattern}"] if a.name_pattern else []) + [f]
    if drop: node = ["setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--"] + node
    dummy = any(fnmatch.fnmatch(f, g) for g in a.dummy_if)
    # --dummy-if: a dummy non-loopback interface INSIDE the private namespace (10.254.0.2/24, reaches nothing outside), for
    # suites that test refusal of a peer arriving over a real non-loopback interface
    pre = "ip link set lo up" + (" && ip link add enc0 type dummy && ip addr add 10.254.0.2/24 dev enc0 && ip link set enc0 up" if dummy else "")
    inner = pre + " && exec " + " ".join(f"'{x}'" for x in node)
    cmd = ["timeout", "-k", "10", str(a.job_sec), "unshare", "-rn", "--pid", "--fork", "--kill-child", "--mount-proc", "sh", "-c", inner]
    t0 = time.time(); p = subprocess.run(cmd, cwd=a.tree, env=env, capture_output=True, text=True); dt = time.time() - t0
    out = p.stdout + p.stderr
    with open(f"{H}/logs/{a.name}.{i:02d}.out", "w") as fh: fh.write(f"$ {' '.join(node)}\n{out}")
    c = dict(tests=0, pass_=0, fail=0, cancelled=0, skipped=0, todo=0)
    for line in out.splitlines():
        m = NUM.match(line.strip())
        if m: c["pass_" if m[1] == "pass" else m[1]] = int(m[2])   # the LAST summary wins (one per file run)
    skips = [(m[1], m[2]) for m in map(SKIP.match, out.splitlines()) if m]
    nat = [s for s in skips if s[1].startswith("NOT RUN (native gate)")]
    ordinary = len(skips) - len(nat)
    native += [(f, n, r) for n, r in nat]; ordinary_skips += ordinary
    bad = p.returncode != 0 or c["fail"] or c["cancelled"] or c["tests"] == 0
    if bad: verdict_fail.append(f)
    rows.append((f, p.returncode, c["tests"], c["pass_"], c["fail"], c["cancelled"], ordinary, len(nat), c["todo"], round(dt, 1), " ".join(x for x in ("caps-dropped" if drop else "", "dummy-if" if dummy else "") if x)))
    print(f"[file] rc={p.returncode} tests={c['tests']} pass={c['pass_']} fail={c['fail']} cancelled={c['cancelled']} skip={ordinary} "
          f"notrun-native={len(nat)} {dt:.1f}s{' caps-dropped' if drop else ''}{' dummy-if' if dummy else ''} {f}", flush=True)
    for line in out.splitlines():
        if line.startswith("✖ ") and "failing tests" not in line: print("        " + line[:220], flush=True)
    for n, r in skips: print(f"        ﹣ {n[:150]} # {r[:150]}", flush=True)

with open(f"{H}/logs/{a.name}.files.tsv", "w") as fh:
    fh.write("file\trc\ttests\tpass\tfail\tcancelled\tskipped\tnotrun_native\ttodo\tsec\tnote\n")
    for r in rows: fh.write("\t".join(map(str, r)) + "\n")
T = lambda k: sum(r[k] for r in rows)
ok = not verdict_fail and ordinary_skips <= a.allow_skip
print(f"[suite] {a.name}: files={len(rows)} tests={T(2)} pass={T(3)} fail={T(4)} cancelled={T(5)} skipped={ordinary_skips} "
      f"(allowed {a.allow_skip}) notrun-native={len(native)} failing-files={len(verdict_fail)} -> {'PASS' if ok else 'FAIL'}", flush=True)
for f in verdict_fail: print(f"[suite] failing file: {f}")
for f, n, r in native: print(f"[suite] NOT RUN native gate (not a pass): {f}: {n[:120]} # {r[:160]}")
sys.exit(0 if ok else 1)
