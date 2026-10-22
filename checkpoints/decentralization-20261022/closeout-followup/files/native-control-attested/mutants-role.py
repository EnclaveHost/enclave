#!/usr/bin/env python3
# Mutation control (immutable): each mutant edits ONE source in the checkout, runs test/native-control-attested.test.mjs offline,
# and must FAIL. Optional argv: mutant name prefixes to run (default: all). Original bytes are restored after each mutant and checked by sha256 at the end.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested'
REPO = HERE + '/repo'
FILES = ['metal/guest/platform-api-role.mjs']
orig = {f: open(os.path.join(REPO, f), 'rb').read() for f in FILES}
sha = lambda b: hashlib.sha256(b).hexdigest()
M = [
 ('R1 pin not enforced', 'metal/guest/platform-api-role.mjs', 'sha256Hex(spkiOf(s.getPeerCertificate())) === spki ? done(null, s)', 'true ? done(null, s)'),
 ('R2 SNI sent', 'metal/guest/platform-api-role.mjs', 'rejectUnauthorized: false, minVersion: "TLSv1.2" });', 'rejectUnauthorized: false, minVersion: "TLSv1.2", servername: "x.invalid" });'),
 ('R3 client abort ignored', 'metal/guest/platform-api-role.mjs', 'if (!res.writableFinished) { gone = true; pin.cancel(); if (up) up.destroy(); }', 'void 0;'),
 ('R4 handshake unbounded', 'metal/guest/platform-api-role.mjs', 'timeoutMs: forwardConnectMs });', 'timeoutMs: 600000 });'),
 ('R5 request written before the pin (old shape)', 'metal/guest/platform-api-role.mjs', '    pin.promise.then((sock) => {\n      if (gone) { sock.destroy(); return; }\n      up = http.request({ createConnection: () => sock,', '    pin.promise.catch(() => {}); Promise.resolve(tls.connect({ host: to.hostname, port: Number(to.port || 443), rejectUnauthorized: false })).then((sock) => {\n      if (gone) { sock.destroy(); return; }\n      up = http.request({ createConnection: () => sock,'),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=dot test/platform-api-forward.test.mjs']
survivors = []
sel = sys.argv[1:]
try:
  for name, f, a, b in [m for m in M if not sel or any(m[0].startswith(x) for x in sel)]:
    s = orig[f].decode(); assert s.count(a) == 1, f'{name}: anchor count {s.count(a)}'
    open(os.path.join(REPO, f), 'w').write(s.replace(a, b))
    try: r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=240); code = r.returncode
    except subprocess.TimeoutExpired: code = 'timeout'
    open(os.path.join(REPO, f), 'wb').write(orig[f])
    print(f'{name}: exit={code} {"KILLED" if code != 0 else "SURVIVED"}', flush=True)
    if code == 0: survivors.append(name)
finally:
  for f in FILES: open(os.path.join(REPO, f), 'wb').write(orig[f])
assert all(sha(open(os.path.join(REPO, f), 'rb').read()) == sha(orig[f]) for f in FILES), 'not restored'
print('restored', {f: sha(orig[f])[:16] for f in FILES}, 'survivors', survivors, flush=True)
sys.exit(1 if survivors else 0)
