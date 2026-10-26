#!/usr/bin/env python3
"""Each mutant of the overlay wrapper must be KILLED by test_l1_pruned_identity (offline)."""
import pathlib, shutil, subprocess, sys
H = pathlib.Path(__file__).resolve().parent; src = (H / 'overlay/wrapper/chain_service.py').read_text()
M = [("and m and m[1] == '0'", "and m"), ("e.code == PRUNED_CODE and ", ""), ("PRUNED_MSG.fullmatch(", "PRUNED_MSG.search("),
     ("if isinstance(err, dict) and type(err.get('code')) is int", "if isinstance(err, dict) and isinstance(err.get('code'), int)"),
     ("and 'result' not in result else None", "else None"),
     ("assert not earliest or gen.get('genesis_time') == CL_GENESIS_TIME, 'wrong CL genesis'", "pass"),
     ("assert doc.get('execution_optimistic') is False,", "assert doc.get('execution_optimistic') is not True,"),
     ("assert doc.get('finalized') is True,", "assert doc.get('finalized') is not False,"),
     ("assert earliest <= n,", "assert True,"), ("assert n <= el_finalized,", "assert True,"),
     ("assert -15 <= time.time() - ts < 3600, 'L1 beacon finalized stale'", "pass"),
     ("and _h32(el.get('parentHash')) == _h32(p.get('parent_hash'))", ""),
     ("and _qty(el.get('timestamp')) == ts", ""), ("_qty(el.get('number')) == n and ", ""),
     ("_h32(el.get('hash')) == _h32(p.get('block_hash'))", "True"),
     ("assert isinstance(g, dict) and g.get('hash') == EL_GENESIS", "assert g is None or g.get('hash') == EL_GENESIS"),
     ("if earliest else {'basis': 'el-genesis-block'}", "if False else {'basis': 'el-genesis-block'}"),
     ("            return int(m[2])\n", "            return 26100000\n")]
rc = 0
for i, (a, b) in enumerate(M):
    assert src.count(a) == 1, a
    d = H / 'tmp' / f'mut{i}'; shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
    (d / 'chain_service.py').write_text(src.replace(a, b))
    for t in ('ref/test_chain_service.py', 'overlay/wrapper/test_l1_pruned_identity.py'):
        shutil.copy(H / t, d)
    r = subprocess.run([sys.executable, '-m', 'unittest', 'test_l1_pruned_identity'], cwd=d, capture_output=True, text=True, timeout=300)
    ok = r.returncode != 0
    print(('KILLED  ' if ok else 'SURVIVED'), i, repr(a)[:90]); rc |= not ok
sys.exit(rc)
