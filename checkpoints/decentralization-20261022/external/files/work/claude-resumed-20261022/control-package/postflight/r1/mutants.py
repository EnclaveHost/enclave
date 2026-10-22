#!/usr/bin/env python3
"""Negative controls for the evaluator itself: re-create a falsely-green guard in a copy; the suite must fail each."""
import pathlib, shutil, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent; src = (H / "postflight.py").read_text()
MUT = {"no-configCid-binding": ('("configCid", x.get("configCidMatch")),', ''),
       "platform-off-accepted": ('elif any(c in ("off", "empty", "other") for c in set_):', 'elif False:'),
       "null-hashes-compared": ('unread = [k for k in BLOCKS if not (shaok(b0.get(k)) and shaok(bl.get(k)))]', 'unread = []'),
       "stale-status-accepted": ('0 <= x["ageMs"] < 5000', '0 <= x["ageMs"]')}
rc = 0
for name, (a, b) in MUT.items():
    assert src.count(a) == 1, name
    d = pathlib.Path(tempfile.mkdtemp(dir=H)); shutil.copy2(H / "test_postflight.py", d); shutil.copy2(H / "run-postflight.py", d)
    (d / "postflight.py").write_text(src.replace(a, b))
    t = (d / "test_postflight.py").read_text().replace("W = H.parents[2]", "W = H.parents[3]", 1); (d / "test_postflight.py").write_text(t)
    (d / "postflight.py").write_text((d / "postflight.py").read_text().replace("W = pathlib.Path(__file__).resolve().parents[3]", "W = pathlib.Path(__file__).resolve().parents[4]", 1))
    r = subprocess.run([sys.executable, "-m", "unittest", "test_postflight"], cwd=d, capture_output=True, text=True)
    failed = sorted({l.split(" (")[0].split(": ")[1] for l in r.stderr.splitlines() if l.startswith(("FAIL:", "ERROR:"))})
    print(f"{name}: rc={r.returncode} failing={failed}"); rc |= (r.returncode == 0); shutil.rmtree(d)
sys.exit(rc)
