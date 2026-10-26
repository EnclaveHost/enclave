#!/bin/bash
# postdelete-bitmap-stage/r3 fixture tests (review 1687 F1/F2/F3/F4/F6 + root 1698 single-transaction shape). PREPARED by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh pdb-r3-tests 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/tests.sh
# Must run as the UNPRIVILEGED owner (uid 1000) inside its own user namespace (refused for real root: no root opens of user paths).
# PASS only if: stderr has exactly one "Ran 21 tests", its last non-empty line is exactly "OK", stdout is EMPTY, and neither stream
# contains ResourceWarning, skipped, FAIL, ERROR or Traceback. Bounds: 600 s wall, 600 s CPU. Writes receipt.json bound to the stage
# SHA256SUMS, checker, runtime and test file hashes.
set -uo pipefail
export PATH=/usr/bin:/bin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn, never as real root (uid_map outer 0)"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); JR=$(cd "$S/../../journal-recovery-verifier-stage" && pwd -P)
[ "$(stat -c %u "$S")" = "$(id -u)" ] && [ ! -L "$S" ] || { echo "REFUSED: stage not owned by the caller"; exit 9; }
PR1_SUMS=f5c89089199de733163e87ef1c982b4c529bf89c8eb6f90974b04492e62447c5; PR2_SUMS=51c393bfeef5506752b44ebb3ae27c1a7f40faffa0126a278948b705113b529d
R1_SUMS=1a7bcc31444776ddb4cf54b3fb2eca0c8d8f61b2e6b467b98f86752022cee46a; R3_SUMS=f12578a688c08d43d71ba0a38dfd52b2e732dac0e9d981031af38dc7c08f6adf
N=21
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && mkdir "$O" && mkdir "$O/tmp" || { echo "REFUSED: run directory exists or cannot be created"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
for p in "r1 $R1_SUMS" "r3 $R3_SUMS"; do set -- $p
  [ "$(sha256sum < "$JR/$1/SHA256SUMS" | cut -c1-64)" = "$2" ] && (cd "$JR/$1" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen verifier $1 changed"; exit 9; }
  cmp -s "$S/jbd2_verify.py" "$JR/$1/jbd2_verify.py" || { echo "runtime differs from verifier $1"; exit 9; }
done
for p in "r1 $PR1_SUMS" "r2 $PR2_SUMS"; do set -- $p; D=$(cd "$S/../$1" && pwd -P)
  [ "$(sha256sum < "$D/SHA256SUMS" | cut -c1-64)" = "$2" ] && (cd "$D" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen postdelete $1 changed"; exit 9; }
done
for f in jbd2_verify.py case/base-1626.json; do cmp -s "$S/$f" "$S/../r1/$f" || { echo "$f differs from postdelete r1 (r3 changes only the checker, tests, jobs)"; exit 9; }; done
[ -z "$(find "$S" -path "$S/runs" -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "bytecode in stage"; exit 9; }
(cd "$O" && ulimit -t 600 && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_postdelete_bitmap.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
python3 -I -B - "$O" "$r" "$S" "$N" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, platform, pathlib
O, r, S, n = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
lib = pathlib.Path("/usr/lib/libext2fs.so.2")
rec = {"format": "enclave-postdelete-bitmap-test-receipt/r3", "pass": all(checks.values()), "checks": checks, "expectedTests": int(n),
       "badMarkers": bad, "ran": ran, "rc": r, "stageSums": sha(S / "SHA256SUMS"), "runtimeSha256": sha(S / "jbd2_verify.py"),
       "checkerSha256": sha(S / "postdelete_bitmap.py"), "testsSha256": sha(S / "tests" / "test_postdelete_bitmap.py"),
       "python": platform.python_version(),
       "libext2fs": {"realpath": str(lib.resolve()), "sha256": sha(lib.resolve())} if lib.exists() else None,
       "stdoutSha256": hashlib.sha256(out.encode()).hexdigest(), "stderrSha256": hashlib.sha256(err.encode()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"
[ $rc = 0 ] && echo "## PASS ($N)" || echo "## FAIL"
rm -rf "$O/tmp"; echo "## receipt $O/receipt.json"; echo "## pdb-r3-tests rc=$rc"; exit $rc
