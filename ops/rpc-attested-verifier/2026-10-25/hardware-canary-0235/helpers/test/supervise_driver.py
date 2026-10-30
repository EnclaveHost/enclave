#!/usr/bin/env python3
"""TEST ONLY: run canary/run-canary.py supervise() around a DISPOSABLE command in its own uniquely named transient user scope.
  supervise_driver.py <run dir> <unit> <mode: sleep|exit3>"""
import importlib.util, json, os, pathlib, sys
D = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rc', D / 'canary/run-canary.py'); rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
run, unit, mode = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
inner = {'sleep': f'echo $$ > {run}/inner.pid; exec sleep 300', 'exit3': 'exit 3'}[mode]
cmd = ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', f'--unit={unit}', 'bash', '-c', inner]
rec = rc.supervise(cmd, unit, run, dict(os.environ))
print(json.dumps(rec), flush=True)
sys.exit(rec['code'])
