#!/usr/bin/env python3
# Final-source mutation control (immutable): each mutant edits relay/native-discovery.mjs, runs test/native-discovery.test.mjs
# offline, and must FAIL; original bytes restored after each and checked by sha256.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery'
REPO = HERE + '/repo'; F = os.path.join(REPO, 'relay/native-discovery.mjs')
orig = open(F, 'rb').read(); before = hashlib.sha256(orig).hexdigest()
M = [
 ('F1 DO fallback restored', "  const row=map?.routes?.[name];\n  if(!row", "  const row=map?.routes?.[name];\n  if(!row)return {name,addresses:['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'],port:443,kind:'control'};\n  if(!row"),
 ('F2 control expiry ignored', "if(!row||!(row.expiresAt>now)||!Array.isArray(row.addresses)", "if(!row||!Array.isArray(row.addresses)"),
 ('F3 malformed addresses served', "||!row.addresses.every(publicIPv4))return null;", ")return null;"),
 ('F4 private ranges allowed', "&&!NON_PUBLIC.check(a,'ipv4')", ""),
 ('F5 deployed control source wired to route-map metadata', " return {caPem,getRoutes:async()=>{", " return {caPem,getControlRoutes:async()=>(await (await fetch(routeMapUrl)).json()),getRoutes:async()=>{"),
 ('F6 control names read the app map', "const map=control?await bounded(getControlRoutes(),timeoutMs):", "const map=control?{...await bounded(getRoutes(),timeoutMs),...await bounded(getControlRoutes(),timeoutMs)}:"),
 ('F7 unconfigured control answers 404 not unavailable', "if(control&&!getControlRoutes)return json(503,{error:'control_route_unavailable'},{'retry-after':'300'});", "if(control&&!getControlRoutes)return json(404,{error:'no_current_route'});"),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=dot test/native-discovery.test.mjs']
surv = []
try:
  for name, a, b in M:
    s = orig.decode(); assert s.count(a) == 1, f'{name}: anchor not unique'
    open(F, 'w').write(s.replace(a, b))
    r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
    open(F, 'wb').write(orig)
    print(f'{name}: exit={r.returncode} {"KILLED" if r.returncode else "SURVIVED"}', flush=True)
    if r.returncode == 0: surv.append(name)
finally:
  open(F, 'wb').write(orig)
assert hashlib.sha256(open(F, 'rb').read()).hexdigest() == before, 'not restored'
print('restored', before, 'survivors', surv, flush=True); sys.exit(1 if surv else 0)
