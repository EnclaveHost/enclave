#!/usr/bin/env python3
"""Mutation check: each mutant re-introduces one r1 defect (or removes one r2 guard) in a temp copy. The matching test
file must FAIL on every mutant, and must pass on the unmutated copy."""
import pathlib, shutil, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent
EV, SH = "evaluate-preflight.py", "vm-preflight.sh"
MUTANTS = [  # (file, old, new, test file, what)
    (EV, 'return int(v) if v is not None and INT.fullmatch(v) and int(v) <= MAX_INT else None',
         'try: return int(v)\n    except (TypeError, ValueError): return None', "test_evaluate.py", "lenient int() (non-canonical/negative/unicode digits)"),
    (EV, 'errors.append(f"line {i}: duplicate key {k}"); dups.add(k); kv.pop(k, None); continue', 'pass', "test_evaluate.py", "last duplicate wins"),
    (EV, 'elif st != "ok":', 'elif False:', "test_evaluate.py", "failed read status ignored"),
    (EV, 'review.append(f"db.count.{t} {c} < {base}', 'blockers.append(f"data may have been lost: db.count.{t} {c} < {base}', "test_evaluate.py", "count decrease reported as data loss"),
    (EV, 'else: unknown.append("backup capacity not decidable', 'else: notes.append("backup capacity not decidable', "test_evaluate.py", "undecidable disk check passes (r1 except: pass)"),
    (EV, 'if k in ok and ok[k] != v: unknown.append(f"{k} = {ok[k]!r}, required {v!r}: session bounds not proven")', 'pass', "test_evaluate.py", "session bounds not required"),
    (EV, 'if not lines or lines[-1] != "preflight.complete=yes":', 'if False:', "test_evaluate.py", "truncated capture accepted"),
    (EV, 'if g("disk.var_lib_total_bytes") == 0:', 'if False:', "test_evaluate.py", "zero disk total accepted"),
    (EV, 'elif None not in (g("mem.available_mib"), g("mem.total_mib")) and g("mem.available_mib") > g("mem.total_mib"):', 'elif False:', "test_evaluate.py", "MemAvailable > MemTotal accepted"),
    (SH, '  [ "$st" = ok ] || val=\n', '', "test_script.py", "a failed read still prints its partial value"),
    (SH, 'if not d: sys.exit("empty pg_dump output: nothing hashed")', 'pass', "test_script.py", "empty pg_dump hashed"),
    (SH, 'if "-- PostgreSQL database dump complete" not in', 'if False and "" not in', "test_script.py", "truncated pg_dump hashed"),
    (SH, "r_df() { T df", "r_df() { df", "test_script.py", "df not under timeout"),
    (SH, '[ "$LAST_STATUS" != timeout ] || SQL_DEGRADED=1', 'true', "test_script.py", "SQL continues after a timeout"),
    (SH, 'elif [ -z "$INNER_TIMEOUT" ]; then skip db.schema_sha256 no-inner-timeout', 'elif false; then :', "test_script.py", "pg_dump without inner timeout"),
    (SH, 'if (( SECONDS + t + KILL > BUDGET ))', 'if false', "test_script.py", "no walltime budget"),
    (SH, '-c default_transaction_read_only=on -c statement_timeout', '-c statement_timeout', "test_script.py", "read-only session option dropped"),
    (SH, 'if [ "$EUID" != 0 ]; then', 'if false; then', "test_script.py", "runs as non-root"),
]

def run(tmp, test):
    return subprocess.run([sys.executable, "-B", str(tmp / "storage-migration-r2" / "preflight" / test)], capture_output=True, text=True, timeout=600).returncode

def main():
    with tempfile.TemporaryDirectory(prefix="pf-r2-mut-") as t:
        tmp = pathlib.Path(t); d = tmp / "storage-migration-r2" / "preflight"
        shutil.copytree(H, d, ignore=shutil.ignore_patterns("*.out", "*.log", "__pycache__", "mutants.py", "test_real_pg.py"))
        (tmp / "storage-migration").symlink_to(H.parent.parent / "storage-migration")       # r1 digest.sql, read-only
        for test in ("test_evaluate.py", "test_script.py"):
            rc = run(tmp, test); print(f"baseline {test}: rc={rc}"); assert rc == 0, test
        killed = 0
        for f, old, new, test, what in MUTANTS:
            src = (H / f).read_text(); assert src.count(old) == 1, (f, old)
            (d / f).write_text(src.replace(old, new))
            rc = run(tmp, test); (d / f).write_text(src)
            print(f"{'KILLED' if rc else 'SURVIVED'}  {f}: {what}"); killed += bool(rc)
        print(f"{killed}/{len(MUTANTS)} mutants killed"); return 0 if killed == len(MUTANTS) else 1

if __name__ == "__main__": sys.exit(main())
