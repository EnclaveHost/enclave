#!/usr/bin/env python3
"""Focused test of b3/compare-config.py on synthetic names-only reads (no values exist in its input by design)."""
import json, pathlib, subprocess, sys, tempfile
B = pathlib.Path(__file__).resolve().parent.parent; res = []
def run(live):
    t = pathlib.Path(tempfile.mkstemp(suffix='.json')[1]); t.write_text(json.dumps(live))
    r = subprocess.run([sys.executable, '-B', str(B / 'b3/compare-config.py'), str(t)], capture_output=True, text=True); t.unlink(); return json.loads(r.stdout)
def s(*n): return [{'name': x, 'valueSha256': '0' * 64} for x in n]
base = {'run-node.cmd': {'present': True, 'sets': s('BASE_RPCS'), 'otherLines': 9}, 'node-config.cmd': {'present': True, 'sets': s('NODE_NAME', 'RELAY_URL', 'APP_SLOTS'), 'otherLines': 3},
        'node-config.local.cmd': {'present': True, 'sets': s('NODE_APP_RAM_GB')}, 'run-network.cmd': {'present': True, 'sets': [], 'otherLines': 10},
        'shield-config.cmd': {'present': True, 'sets': s('ENCLAVE_LIVENESS_MS', 'ENCLAVE_ROOT_HOTFIX_X'), 'otherLines': 1}, 'run-card.cmd': {'present': False}}
j = run(base)
ok1 = j['nodeSettingsToMove'] == ['BASE_RPCS'] and j['noHookFiles'] == ['shield-config.cmd'] and j['installSafe'] is False and j['report']['shield-config.cmd']['liveOnlySettings'] == ['ENCLAVE_ROOT_HOTFIX_X']
res.append(('repaired run-node.cmd BASE_RPCS -> move to local; shield-only setting -> no hook; not install-safe', ok1, j))
b2 = json.loads(json.dumps(base)); b2['node-config.local.cmd']['sets'] = s('NODE_APP_RAM_GB', 'BASE_RPCS'); b2['shield-config.cmd']['sets'] = s('ENCLAVE_LIVENESS_MS')
j = run(b2); ok2 = j['nodeSettingsToMove'] == [] and j['noHookFiles'] == [] and j['installSafe'] is True
res.append(('BASE_RPCS already in node-config.local.cmd, shield matches template -> install-safe', ok2, j))
for n, ok, j in res: print(('PASS ' if ok else 'FAIL ') + n, '' if ok else json.dumps(j)[:800])
print(json.dumps({'pass': sum(o for _, o, _ in res), 'fail': sum(not o for _, o, _ in res)})); sys.exit(0 if all(o for _, o, _ in res) else 1)
