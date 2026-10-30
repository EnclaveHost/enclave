#!/usr/bin/env python3
"""Derive host/guest-release-watch.py (+ its test) from the REVIEWED watcher jobs/guest-build-watch.py (31264eb0) and
test (608162b7) by counted substitutions (v2): the release launcher path plus the CLI-child attempt and 4 compound-evidence
pins, the release unit/paths, and a precheck that run 2 and the CLI-child supplement have ended with their receipts collected. monitor() (host 16 GiB floor, cancellation, stop-only-own-unit) is unchanged.
Usage: tools-make-watcher.py OUTDIR | --check OUTDIR"""
import hashlib, os, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/jobs"
SRC = {"w": (f"{W}/guest-build-watch.py", "31264eb00ba7a912fcef719b5abb768673f67bbd76e3b8d4a65962d9e34868e5", "host/guest-release-watch.py"),
       "t": (f"{W}/test-guest-build-watch.py", "608162b73841cc1ecf905b48334949eb1fa6c8b07fab4b65e7ad77cda910ff8c", "host/test-guest-release-watch.py")}
SUBS = {"w": [
 ("a.add_argument('attempt',type=int,choices=range(1,10));a.add_argument('manifest');a.add_argument('output');p=a.parse_args()",
  "a.add_argument('attempt',type=int,choices=range(1,10));a.add_argument('manifest');a.add_argument('child_attempt',type=int,choices=range(1,10));a.add_argument('compound');a.add_argument('launcher');a.add_argument('child_out');a.add_argument('supplement_manifest');a.add_argument('output');p=a.parse_args()"),
 (" if len(p.manifest)!=64 or any(c not in '0123456789abcdef' for c in p.manifest):a.error('expected SHA256')",
  " for h in (p.manifest,p.compound,p.launcher,p.child_out,p.supplement_manifest):\n  if len(h)!=64 or any(c not in '0123456789abcdef' for c in h):a.error('expected SHA256')"),
 ("n=p.attempt;unit=f'm10-guest-validation-{n}.service';base='/srv/m10-guest-validation'", "n=p.attempt;unit=f'm7-m10-release-{n}.service';base='/srv/m10-guest-validation'"),
 ("check=f'sudo test ! -e {base}/runs/run-{n} && sudo test ! -e {base}/receipts/run-{n}.rc && ! sudo systemctl is-active --quiet {unit}'",
  "check=f'sudo test ! -e {base}/release/run-{n} && sudo test ! -e {base}/receipts/release-{n}.rc && ! sudo systemctl is-active --quiet {unit} && sudo test -s {base}/receipts/run-2.receipt.json && ! sudo systemctl is-active --quiet m10-guest-validation-2.service && sudo test -s {base}/receipts/cli-child-{p.child_attempt}.compound.json && ! sudo systemctl is-active --quiet m10-cli-child-{p.child_attempt}.service'"),
 ("cmd=SSH+[f'sudo bash {base}/stage/runner/run-guest.sh {n} {p.manifest}']",
  "cmd=SSH+[f'sudo bash {base}/stage-release-1/runner/run-release.sh {n} {p.manifest} {p.child_attempt} {p.compound} {p.launcher} {p.child_out} {p.supplement_manifest}']")],
 "t": [("with_name('guest-build-watch.py')", "with_name('guest-release-watch.py')")]}
def derive(k):
    src, pin, _ = SRC[k]; raw = open(src, "rb").read(); assert hashlib.sha256(raw).hexdigest() == pin, k
    s = raw.decode()
    for a, b in SUBS[k]:
        assert s.count(a) == 1, (k, a[:60]); s = s.replace(a, b)
    return s
if __name__ == "__main__":
    chk = sys.argv[1] == "--check"; out = sys.argv[2] if chk else sys.argv[1]; bad = 0
    for k in SRC:
        p = os.path.join(out, SRC[k][2])
        if chk: bad += derive(k) != open(p).read()
        else: open(p, "w").write(derive(k))
    sys.exit(1 if bad else 0)
