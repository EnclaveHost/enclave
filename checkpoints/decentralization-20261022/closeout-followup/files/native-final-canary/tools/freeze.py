#!/usr/bin/env python3
"""freeze.py: write FROZEN-PINS.json = the CURRENT value of every pin run-canary.py re-verifies at the launch boundary
(canary helpers incl. qemu-restrict.sh, ssh stubs, the exact image files, OVMF, QEMU, node, the build receipt and inputs,
the staged source tree and its node_modules). Root reviews this file's sha256; any later change makes --run refuse."""
import datetime, importlib.util, json, pathlib, sys
D = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rc', D / 'canary/run-canary.py'); rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
out = D / 'FROZEN-PINS.json'
if out.exists() and '--replace' not in sys.argv: raise SystemExit('FROZEN-PINS.json exists (pass --replace to re-freeze after a reviewed change)')
pins = {k: f() for k, f in sorted(rc.pin_targets().items())}
doc = {'format': 'direct-control-canary-frozen-pins/1', 'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'sourceCommit': '493ee9ee07497c94159ec4f6916e9ea920d31959', 'sourceTree': 'b21163723ea789db13ff84d148e309e2709a89f4',
       'expectedMeasurement': rc.expected_measurement(), 'pins': pins}
out.write_text(json.dumps(doc, indent=1) + '\n')
print(json.dumps({'pins': len(pins), 'file': str(out)}))
