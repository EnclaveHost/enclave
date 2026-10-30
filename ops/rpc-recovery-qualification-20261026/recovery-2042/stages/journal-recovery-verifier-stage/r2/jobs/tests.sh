#!/bin/bash
# journal-recovery-verifier-stage/r2 tests: HARNESS/FIXTURE-ONLY fix of r1 (root 1646). PREPARED by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh jrv-r2-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r2/jobs/tests.sh
# Verifier runtime (jbd2_verify.py) and the actual-run job are byte-identical to frozen r1 (checked below).
# PASS only if: unittest's stderr has exactly one "Ran 9 tests", its last non-empty line is exactly "OK", stdout is EMPTY, and neither
# stream contains ResourceWarning, skipped, FAIL, ERROR or Traceback (python -u, ResourceWarnings always shown). Writes receipt.json.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); R1=$(cd "$S/../r1" && pwd -P)
R1_SUMS=1a7bcc31444776ddb4cf54b3fb2eca0c8d8f61b2e6b467b98f86752022cee46a
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$O/tmp" || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "r2 stage != SHA256SUMS"; exit 9; }
[ "$(sha256sum < "$R1/SHA256SUMS" | cut -c1-64)" = $R1_SUMS ] && (cd "$R1" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen r1 changed"; exit 9; }
cmp -s "$S/jbd2_verify.py" "$R1/jbd2_verify.py" && cmp -s "$S/jobs/root-verify.sh" "$R1/jobs/root-verify.sh" || { echo "verifier runtime differs from r1"; exit 9; }
[ -z "$(find "$S" -path "$S/runs" -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "bytecode in stage"; exit 9; }
(cd "$O" && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_jbd2_verify.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
python3 -I -B - "$O" "$r" "$S" "$R1_SUMS" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, platform, pathlib
O, r, S, r1 = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly9": ran == ["9"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
lib = pathlib.Path("/usr/lib/libext2fs.so.2")
rec = {"format": "enclave-jbd2-verifier-test-receipt/r2", "pass": all(checks.values()), "checks": checks, "badMarkers": bad, "ran": ran, "rc": r,
       "stageSums": sha(S / "SHA256SUMS"), "r1Sums": r1, "verifierSha256": sha(S / "jbd2_verify.py"), "python": platform.python_version(),
       "libext2fs": {"realpath": str(lib.resolve()), "sha256": sha(lib.resolve())} if lib.exists() else None,
       "stdoutSha256": hashlib.sha256(out.encode()).hexdigest(), "stderrSha256": hashlib.sha256(err.encode()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"
[ $rc = 0 ] && echo "## PASS (9)" || echo "## FAIL"
rm -rf "$O/tmp"; echo "## receipt $O/receipt.json"; echo "## jrv-r2-tests rc=$rc"; exit $rc
