#!/usr/bin/env python3
# Mutation control (immutable): each mutant edits ONE source in the checkout, runs test/native-control-attested.test.mjs offline,
# and must FAIL. Optional argv: mutant name prefixes to run (default: all). Original bytes are restored after each mutant and checked by sha256 at the end.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested'
REPO = HERE + '/repo'
FILES = ['metal/guest/measured-control.mjs', 'network/native-control-routes.mjs', 'scripts/native-control-certificate.mjs']
orig = {f: open(os.path.join(REPO, f), 'rb').read() for f in FILES}
sha = lambda b: hashlib.sha256(b).hexdigest()
M = [
 ('N1 native leaf not bound to the attested key', 'network/native-control-routes.mjs', "if (n.spkiSha256 !== n.statement.keys.controlTls.spkiSha256) throw", "if (false) throw"),
 ('N2 admission decision ignored', 'network/native-control-routes.mjs', "if (!dec || dec.admit !== true) throw", "if (!dec) throw"),
 ('N3 chipId denial not failed closed', 'network/native-control-routes.mjs', "acceptedPolicy.deny.some((e) => e && e.kind === 'chipId')", "false"),
 ('N4 failure domain ignored', 'network/native-control-routes.mjs', "if (exclude.has(c.address)) {", "if (false) {"),
 ('N5 policy off accepted', 'network/native-control-routes.mjs', "if (!runtime) throw new Error('native control routes need the platform host policy: it is explicitly off');", ""),
 ('N6 decision row operator not checked', 'network/native-control-routes.mjs', "if (!dec.host || lc(dec.host.operator) !== v.identity.operator || dec.host.active === false) throw", "if (false) throw"),
 ('G1 no leaf falls back to another key', 'metal/guest/measured-control.mjs', "return ctx ? cb(null, ctx) : cb(new Error(`no current native certificate for ${lname}`)); }", "if (ctx) return cb(null, ctx); }"),
 ('G2 SNI/Host disagreement served', 'metal/guest/measured-control.mjs', "if (h !== sn) return json(res, 421,", "if (false) return json(res, 421,"),
 ('G3 expiry may roll back', 'metal/guest/measured-control.mjs', "c.validTo <= nativeCert.validTo) bad(", "false) bad("),
 ('G4 installs not exclusive', 'metal/guest/measured-control.mjs', "if (installing) throw new ControlError('another native certificate install is in progress');", ""),
 ('G5 body slot not enforced', 'metal/guest/measured-control.mjs', "if (installing || bodyHeld) return json(res, 429, { error: 'busy' });", ""),
 ('G6 leaf CA not pinned', 'metal/guest/measured-control.mjs', "if (sha256Hex(ca.raw) !== caSha256 || !ca.ca) bad(", "if (!ca.ca) bad("),
 ('T1 pin not enforced on the socket', 'scripts/native-control-certificate.mjs', "if (got !== spkiSha256) { s.destroy(); return reject(new Error('the endpoint is not the attested key')); }", ""),
 ('T2 issuance accepts another CA', 'scripts/native-control-certificate.mjs', "if (sha256Hex(ca.raw) !== request.caSha256) throw", "if (false) throw"),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=dot test/native-control-attested.test.mjs']
survivors = []
sel = sys.argv[1:]
try:
  for name, f, a, b in [m for m in M if not sel or any(m[0].startswith(x) for x in sel)]:
    s = orig[f].decode(); assert s.count(a) == 1, f'{name}: anchor count {s.count(a)}'
    open(os.path.join(REPO, f), 'w').write(s.replace(a, b))
    try: r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=150); code = r.returncode
    except subprocess.TimeoutExpired: code = 'timeout'
    open(os.path.join(REPO, f), 'wb').write(orig[f])
    print(f'{name}: exit={code} {"KILLED" if code != 0 else "SURVIVED"}', flush=True)
    if code == 0: survivors.append(name)
finally:
  for f in FILES: open(os.path.join(REPO, f), 'wb').write(orig[f])
assert all(sha(open(os.path.join(REPO, f), 'rb').read()) == sha(orig[f]) for f in FILES), 'not restored'
print('restored', {f: sha(orig[f])[:16] for f in FILES}, 'survivors', survivors, flush=True)
sys.exit(1 if survivors else 0)
