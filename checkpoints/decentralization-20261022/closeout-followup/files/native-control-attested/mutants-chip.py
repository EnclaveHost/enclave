#!/usr/bin/env python3
# Mutation control (immutable): each mutant edits ONE source in the checkout, runs test/native-control-attested.test.mjs offline,
# and must FAIL. Optional argv: mutant name prefixes to run (default: all). Original bytes are restored after each mutant and checked by sha256 at the end.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested'
REPO = HERE + '/repo'
FILES = ['metal/measured-control-verify.mjs', 'network/native-control-routes.mjs']
orig = {f: open(os.path.join(REPO, f), 'rb').read() for f in FILES}
sha = lambda b: hashlib.sha256(b).hexdigest()
M = [
 ('C1 verifier exposes no chip', 'metal/measured-control-verify.mjs', "identity.chipId = policyChipIdOf(v.claims);", "identity.chipId = null;"),
 ('C2 discovery drops the verified chip', 'network/native-control-routes.mjs', "decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null })", "decideHost(v.identity.registryId, { chipId: null })"),
 ('C3 chip replaces chain facts', 'network/native-control-routes.mjs', "const host = { ...decision.host, chipId: chip };", "const host = { registryId: decision.host.registryId, chipId: chip };"),
 ('C4 unproven chip admitted', 'network/native-control-routes.mjs', "if (j.admit && !chip && Array.isArray(acceptedPolicy.deny)", "if (false && Array.isArray(acceptedPolicy.deny)"),
 ('C5 masked chip accepted', 'metal/measured-control-verify.mjs', "|| claims.maskChipKey === true) return null;", ") return null;"),
 ('C6 non-policy outcomes re-judged', 'network/native-control-routes.mjs', "if (!judged) return decision;", ""),
 ('C7 chip from runtime decision only (no re-judgement)', 'network/native-control-routes.mjs', "  const j = judgeHost(acceptedPolicy, host, Math.floor(now() / 1000), { previouslyAdmitted: false });", "  const j = decision;"),
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
