#!/usr/bin/env python3
# Mutation control (immutable): each mutant edits ONE source in the isolated checkout, runs the two native suites offline,
# and must FAIL; the original bytes are restored after every mutant and checked by sha256 at the end.
import hashlib, os, shutil, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery'
REPO = HERE + '/repo'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
FILES = ['network/native-control-routes.mjs', 'relay/native-discovery.mjs']
orig = {f: open(os.path.join(REPO, f), 'rb').read() for f in FILES}
before = {f: sha(os.path.join(REPO, f)) for f in FILES}
M = [
 ('M1 DO fallback restored', 'relay/native-discovery.mjs', "  const row=map?.routes?.[name];\n  if(!row", "  const row=map?.routes?.[name];\n  if(!row)return {name,addresses:['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'],port:443,kind:'control'};\n  if(!row"),
 ('M2 failure domain ignored', 'network/native-control-routes.mjs', 'if (k.excluded) { excluded.push', 'if (false) { excluded.push'),
 ('M3 policy refusal ignored', 'network/native-control-routes.mjs', 'if (judged && !judged.admitted.has(lc(c.operator))) {', 'if (false) {'),
 ('M4 TLS proof skipped', 'network/native-control-routes.mjs', 'const { validTo } = await prove(', 'const { validTo } = { validTo: Date.now() + 86400_000 } || await prove('),
 ('M5 control expiry ignored', 'relay/native-discovery.mjs', "if(!row||!(row.expiresAt>now)||!Array.isArray(row.addresses)", "if(!row||!Array.isArray(row.addresses)"),
 ('M6 malformed addresses served', 'relay/native-discovery.mjs', "||row.addresses.some(a=>typeof a!=='string'||!publicIPv4(a))", ''),
 ('M7 route TTL unbounded', 'network/native-control-routes.mjs', 'expiresAt: Math.min(at + routeTtlMs, ...ok', 'expiresAt: Math.min(...ok'),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=dot test/native-control-routes.test.mjs test/native-discovery.test.mjs']
survivors = []
try:
  for name, f, a, b in M:
    p = os.path.join(REPO, f); s = orig[f].decode()
    assert s.count(a) == 1, f'{name}: anchor not unique'
    open(p, 'w').write(s.replace(a, b))
    r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
    open(p, 'wb').write(orig[f])
    fails = [l for l in r.stdout.splitlines() if l.startswith('test at ')]
    print(f'{name}: exit={r.returncode} {"KILLED" if r.returncode else "SURVIVED"} {fails[:3]}', flush=True)
    if r.returncode == 0: survivors.append(name)
finally:
  for f in FILES: open(os.path.join(REPO, f), 'wb').write(orig[f])
after = {f: sha(os.path.join(REPO, f)) for f in FILES}
assert after == before, 'sources not restored'
print('sources restored:', after, flush=True)
print('survivors:', survivors, flush=True)
sys.exit(1 if survivors else 0)
