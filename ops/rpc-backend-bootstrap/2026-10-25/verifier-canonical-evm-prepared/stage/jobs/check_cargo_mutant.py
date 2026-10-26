#!/usr/bin/env python3
"""Strict MUTANT verdict for one `cargo test --no-fail-fast` run (verifier-canonical-controls-repair/r2; replaces ONLY the
`mutant` mode of the frozen verifier-canonical-stage/jobs/check_cargo_output.py, which misread cargo's ordinary
test-failure footer as a compiler error).
  check_cargo_mutant.py --out FILE --rc N --controls EXPECTED-CONTROLS.txt --bins "--test a [--test b ...]" NAME...
Exit 0 KILLED, 1 NOT KILLED (a named test RAN and PASSED: a survivor), 3 INVALID (never a kill, never a verdict).
KILLED only if ALL hold:
  * cargo's exit code is exactly 101 (test failure). 0 = nothing failed (a survivor only if everything else is consistent);
    anything else (timeout 124, signal 128+N, 1, 2, ...) is INVALID;
  * every requested binary ran EXACTLY once (`Running tests/<bin>.rs`), and no other binary or doc-test ran;
  * each binary has exactly one summary with 0 ignored, 0 measured, 0 filtered out, status FAILED iff failed > 0, and a
    test line for every counted test; no `ignored` test line anywhere;
  * the ONLY lines starting with `error` are cargo 1.96's own test-failure footers, as ACTUALLY observed (r2):
      - per failed binary B, exactly ONE `error: test failed, to rerun pass `-p helios-core --test B`` inside B's own
        section, after its summary, separated only by blank lines; none for a passing binary; in run order;
      - then (--no-fail-fast) exactly ONE aggregate `error: 1 target failed:` / `error: N targets failed:` with N == the
        number of failed binaries, followed by exactly N lines `    `-p helios-core --test B`` naming them in run order,
        and nothing non-blank after it; OR (the original runner without --no-fail-fast) no aggregate and exactly one
        failed binary, its per-target footer being the last non-blank line;
    any compiler error (`error[E..]`), `error: could not compile`, any other `error` line, a duplicated / missing /
    wrong-target / misplaced footer, or a per-target vs aggregate mismatch is INVALID; exit 101 requires the footers, exit
    0 allows none;
  * each NAME belongs (EXPECTED-CONTROLS.txt) to a requested binary, appears there exactly once as `test NAME ... FAILED`,
    and has its own `---- NAME stdout ----` block containing `panicked at` (its own assertion). A NAME that is `ok` is NOT
    KILLED; a NAME missing, ignored, or FAILED without its own panic is INVALID."""
import argparse, re, sys
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True); ap.add_argument("--rc", required=True); ap.add_argument("--controls", required=True)
ap.add_argument("--bins", required=True); ap.add_argument("names", nargs="+")
a = ap.parse_args()
inv, surv = [], []
def invalid(w): inv.append(w)
try: out = open(a.out, errors="replace").read()
except OSError as e: print(f"mutant: INVALID (cannot read output: {e})"); sys.exit(3)
try: rc = int(a.rc)
except ValueError: rc = None
if rc not in (0, 101): invalid(f"cargo exit {a.rc} is never a verdict (only 101 = test failure, 0 = no failure)")
tok = a.bins.split()
if len(tok) % 2 or any(tok[i] != "--test" for i in range(0, len(tok), 2)) or not tok: invalid(f"--bins {a.bins!r} is not '--test B ...'")
bins = tok[1::2]
if len(set(bins)) != len(bins): invalid("a binary is requested twice")
owner = {}
for l in open(a.controls):
    l = l.strip()
    if l and not l.startswith("#"):
        b, n = l.split(); owner[n] = b
lines = out.splitlines()
run_re = re.compile(r"^\s+Running (\S+) \(")
starts = [(i, m.group(1)) for i, l in enumerate(lines) for m in [run_re.match(l)] if m]
if any(re.match(r"^\s+Doc-tests\s", l) for l in lines): invalid("doc-tests ran (not requested)")
ran = []
for target in (t for _, t in starts):
    m = re.fullmatch(r"tests/(\w+)\.rs", target)
    if not m: invalid(f"unexpected target ran: {target}"); continue
    ran.append(m.group(1))
if sorted(ran) != sorted(bins) or len(ran) != len(set(ran)):
    invalid(f"binaries ran {ran}, requested {bins} (each exactly once; a requested binary that did not run is never a kill)")
SUM = re.compile(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$")
sect, failed_bins = {}, []
for k, (i, t) in enumerate(starts):
    end = starts[k + 1][0] if k + 1 < len(starts) else len(lines)
    m = re.fullmatch(r"tests/(\w+)\.rs", t)
    if m: sect[m.group(1)] = lines[i:end]
for b, sl in sect.items():
    sums = [SUM.match(l) for l in sl if l.startswith("test result:")]
    if len(sums) != 1 or sums[0] is None: invalid(f"{b}: not exactly one well-formed summary"); continue
    st, p, f, ig, me, fo = sums[0].group(1), *map(int, sums[0].groups()[1:])
    if ig or me or fo: invalid(f"{b}: {ig} ignored / {me} measured / {fo} filtered out (never a valid control run)")
    if (st == "FAILED") != (f > 0): invalid(f"{b}: summary status {st} inconsistent with {f} failed")
    tl = [l for l in sl if re.match(r"^test \S+ \.\.\. ", l)]
    if any(re.match(r"^test \S+ \.\.\. ignored", l) for l in tl): invalid(f"{b}: an ignored test")
    if len([l for l in tl if re.fullmatch(r"test \S+ \.\.\. (ok|FAILED)", l)]) != p + f or len(tl) != p + f: invalid(f"{b}: {len(tl)} test lines for {p + f} counted tests")
    if f: failed_bins.append(b)
# error lines: only cargo's exact per-target footers + the exact aggregate (r2: the ACTUAL --no-fail-fast format)
err = [(i, l) for i, l in enumerate(lines) if l.startswith("error")]
PT = re.compile(r"^error: test failed, to rerun pass `-p helios-core --test (\w+)`$")
AG = re.compile(r"^error: (?:1 target|([2-9]|[1-9]\d+) targets) failed:$")
TGT = re.compile(r"^    `-p helios-core --test (\w+)`$")
pts = [(i, PT.match(l).group(1)) for i, l in err if PT.match(l)]
ags = [(i, l) for i, l in err if AG.match(l)]
other = [l for i, l in err if not PT.match(l) and not AG.match(l)]
if other: invalid(f"error line(s) that are not cargo's test-failure footers: {other[:3]}")
order = [b for b in ran if b in failed_bins]
if [b for _, b in pts] != order: invalid(f"per-target footers {[b for _, b in pts]} != the failed binaries in run order {order} (missing/duplicate/wrong target)")
sec_span = {}
for k, (i, t) in enumerate(starts):
    m = re.fullmatch(r"tests/(\w+)\.rs", t)
    if m: sec_span[m.group(1)] = (i, starts[k + 1][0] if k + 1 < len(starts) else len(lines))
agg_i = ags[0][0] if len(ags) == 1 else None
for i, b in pts:
    lo, hi = sec_span.get(b, (0, -1)); hi = min(hi, agg_i) if agg_i is not None else hi
    sums = [x for x in range(lo, hi) if lines[x].startswith("test result:")]
    if not (lo <= i < hi) or not sums or i < sums[-1]: invalid(f"{b}: per-target footer is not inside its own section after its summary"); continue
    if any(lines[x].strip() for x in range(sums[-1] + 1, i)) or any(lines[x].strip() for x in range(i + 1, hi)):
        invalid(f"{b}: non-blank lines around its per-target footer")
if len(ags) > 1: invalid("more than one aggregate footer")
elif len(ags) == 1:
    i0, l0 = ags[0]; m = AG.match(l0); k = int(m.group(1) or 1)
    if k != len(failed_bins): invalid(f"aggregate says {k} target(s) failed, but {len(failed_bins)} binaries failed")
    listed = [TGT.match(l).group(1) if TGT.match(l) else None for l in lines[i0 + 1:i0 + 1 + k]]
    if listed != order: invalid(f"aggregate lists {listed}, not the failed binaries in run order {order}")
    if pts and i0 < pts[-1][0]: invalid("aggregate footer precedes a per-target footer")
    if any(l.strip() for l in lines[i0 + 1 + k:]): invalid("non-blank lines after the aggregate footer")
elif failed_bins:
    if len(failed_bins) != 1: invalid("several failed binaries but no aggregate footer (--no-fail-fast footer missing)")
    elif pts and any(l.strip() for l in lines[pts[-1][0] + 1:]): invalid("non-blank lines after the single per-target footer")
if rc == 101 and (not failed_bins or not err): invalid("cargo exit 101 without a failed binary and its footer")
if rc == 0 and (failed_bins or err): invalid("cargo exit 0 but a failure/footer is reported")
for n in a.names:
    b = owner.get(n)
    if b is None: invalid(f"{n}: not a test in EXPECTED-CONTROLS"); continue
    if b not in bins: invalid(f"{n}: its binary {b} was not requested"); continue
    sl = sect.get(b)
    if sl is None: invalid(f"{n}: its binary {b} did not run"); continue
    st = [l for l in sl if re.match(rf"^test {re.escape(n)} \.\.\. ", l)]
    if len(st) != 1: invalid(f"{n}: {len(st)} result lines (missing or duplicated test)"); continue
    if st[0] == f"test {n} ... ok": surv.append(f"{n}: ok (not killed)"); continue
    if st[0] != f"test {n} ... FAILED": invalid(f"{n}: {st[0]!r}"); continue
    text = "\n".join(sl)
    blk = re.search(rf"^---- {re.escape(n)} stdout ----\n(.*?)(?=^---- |^failures:$|\Z)", text, re.M | re.S)
    if not blk or "panicked at" not in blk.group(1): invalid(f"{n}: FAILED without its own assertion panic")
if inv:
    print("mutant: INVALID (never a kill)"); [print("  [INVALID]", x) for x in inv]; [print("  [note]", x) for x in surv]; sys.exit(3)
if surv:
    print("mutant: NOT KILLED"); [print("  ", x) for x in surv]; sys.exit(1)
print(f"mutant: KILLED ({len(a.names)} named tests failed by their own assertion; cargo exit 101; binaries {bins})"); sys.exit(0)
