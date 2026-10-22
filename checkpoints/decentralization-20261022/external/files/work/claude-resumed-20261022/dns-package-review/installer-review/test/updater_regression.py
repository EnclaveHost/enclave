#!/usr/bin/env python3
"""Worker's updater scenarios A-F (frozen/test/updater_r4.py, imported read-only; nothing written into frozen/) against SCRIPT.
Install is mocked there, so this checks that the r5 edit (inside Install) leaves the guard flow intact; it does not test the edit."""
import importlib.util, json, pathlib, sys
HERE = pathlib.Path(__file__).resolve().parent
sp = importlib.util.spec_from_file_location('u', HERE.parent / 'frozen/test/updater_r4.py'); u = importlib.util.module_from_spec(sp); sp.loader.exec_module(u)
script = pathlib.Path(sys.argv[1]).resolve(); failed = []
for name, sc in u.SCENARIOS.items():
    r = u.run(script, sc); ok = r['exit'] == sc['exit'] and r['installs'] == sc['installs'] and (sc.get('log', '') in r['log'])
    print('PASS' if ok else 'FAIL', name, '' if ok else json.dumps(r)[:400], flush=True); failed += [] if ok else [name]
print(json.dumps({'script': str(script), 'pass': len(u.SCENARIOS) - len(failed), 'failed': failed})); sys.exit(1 if failed else 0)
