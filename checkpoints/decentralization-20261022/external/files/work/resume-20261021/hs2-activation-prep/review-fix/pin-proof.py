#!/usr/bin/env python3
"""ROOT-EXECUTABLE, READ-ONLY native proof of the fixed in-session pin check (NOT run by Claude).
It sends, through the helper's own ps() path (gzip bootstrap + watchdog), ONLY the exact FILL pin block - Test-Path and
Get-FileHash on the 3 files fill executes - and reports $pinsOk / $pinChecked / $pinBad. Nothing is executed, written,
started or changed: no Set-Location, no stage script, no fill.
  Case 1: the real fill pins                         -> expect pinsOk true,  pinChecked 3, pinBad []
  Case 2: the same, ONE expected hash deliberately wrong (stage-tool.mjs) -> expect pinsOk false, pinChecked 3,
          pinBad == [that one full path]
  python3 work/claude-test-queue.py --mib 256 --log <abs>/pinproof.guard.log -- python3 <this file>
Receipt: pin-proof-<UTC>.json. Exit 0 = both cases exactly as expected."""
import datetime, importlib.util, json, pathlib, sys
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("helper", HERE / "root-hs2-activate.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
L = m.L
OUT = "'RESULT '+(@{pinsOk=$pinsOk;pinChecked=$pinChecked;pinBad=@($pinBad)}|ConvertTo-Json -Compress)"
good = L.pins_for("fill")
bad_path = L.remote_path("bin/stage-tool.mjs")
bad = [(p, ("0" * 64 if p == bad_path else h)) for p, h in good]
assert sum(1 for p, h in bad if h == "0" * 64) == 1
o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "helperSha256": m.sha(HERE / "root-hs2-activate.py"), "libSha256": m.sha(HERE / "hs2lib.py"),
     "fillBlockIsExact": m.FILL.startswith(m.verify_ps("fill")) and m.verify_ps("fill") == m.verify_pairs_ps(good)}
for name, pairs in (("valid", good), ("oneBad", bad)):
    try:
        rc, out, _ = m.ps(m.verify_pairs_ps(pairs) + OUT, 60)
        o[name] = {"rc": rc, "pinsOk": out.get("pinsOk"), "pinChecked": out.get("pinChecked"), "pinBad": out.get("pinBad")}
    except Exception as e: o[name] = {"error": f"{type(e).__name__}: {e}"[:200]}
v, b = o.get("valid", {}), o.get("oneBad", {})
o["pass"] = (o["fillBlockIsExact"] and v.get("pinsOk") is True and v.get("pinChecked") == 3 and (v.get("pinBad") or []) == []
             and b.get("pinsOk") is False and b.get("pinChecked") == 3 and b.get("pinBad") == [bad_path])
o["expectedBad"] = bad_path
p = HERE / f"pin-proof-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
p.write_text(json.dumps(o, indent=1) + "\n"); print(json.dumps(o, indent=1)); sys.exit(0 if o["pass"] else 1)
