#!/usr/bin/env python3
# Negative control + mutation control (immutable): (0) the FROZEN INSTALLED host.mjs (baseline commit, sha 9634cb40) in
# place of the candidate; (M*) one-line mutants of the candidate. Each must FAIL test/windows-node-wallet-grant-refresh
# (except where the expected per-case result is printed). The candidate bytes are restored after each and checked by sha256.
import hashlib, os, subprocess, sys, re
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review'
REPO = HERE + '/candidate'; F = os.path.join(REPO, 'windows/node/host.mjs')
orig = open(F, 'rb').read(); sha = lambda b: hashlib.sha256(b).hexdigest(); before = sha(orig)
base = subprocess.check_output(['git', '-C', REPO, 'show', 'HEAD:windows/node/host.mjs'])
assert sha(base) == '9634cb40c60b74f92eff8497f687dcaa1ec04a33c21cbd22dc745d773b1da396', 'baseline is the installed host'
M = [
 ('M1 no fence after the decision', "      if (fenced()) return { id, outcome: \"superseded\" };\n      if (r?.refusal) {", "      if (r?.refusal) {"),
 ('M2 fresh row not compared (stale identity refreshed)', "      if (!same) return { id, outcome: \"lapsing\" };", ""),
 ('M3 forPrivate from the cached grant, not the row', "decision({ deploymentId: id, appRef: d.appRef, forPrivate: d.isPublic === false })", "decision({ deploymentId: id, appRef: g.appRef, forPrivate: false })"),
 ('M4 refusal not withdrawn', "        this.#walletRevoke(id);\n        this.log(`${id.slice(0, 10)} wallet policy refusal at grant refresh", "        this.log(`${id.slice(0, 10)} wallet policy refusal at grant refresh"),
 ('M5 revoke keeps the grant (resurrection)', "    this.#walletGrants.delete(String(id).toLowerCase());\n    try { this.walletChannel.hold(String(id).toLowerCase()); }", "    try { this.walletChannel.hold(String(id).toLowerCase()); }"),
 ('M6 hold keeps the grant (resurrection)', "    this.#walletGrants.delete(String(id).toLowerCase());   // a refresh in flight must not re-grant a held deployment\n", ""),
 ('M7 one deployment per round (a slow app stalls the rest)', ".sort((a, b) => a[1].validUntil - b[1].validUntil).slice(0, Math.max(0, free));", ".sort((a, b) => a[1].validUntil - b[1].validUntil).slice(0, Math.min(1, Math.max(0, free)));"),
 ('M8 unknown extends the old grant', "    } catch (e) { return { id, outcome: \"unknown\", why: String(e.message).slice(0, 200) }; }\n  }", "    } catch (e) { try { this.walletChannel.allow(id, { appRef: g.appRef, configCid: g.configCid, validUntil: Date.now() + 80_000 }); } catch {} return { id, outcome: \"unknown\" }; }\n  }"),
 ('M9 no per-app in-flight guard', "    const due = [...this.#walletGrants].filter(([id, g]) => !this.#walletInflight.has(id) && ", "    const due = [...this.#walletGrants].filter(([id, g]) => "),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec test/windows-node-wallet-grant-refresh.test.mjs']
def run(name, data):
  open(F, 'wb').write(data)
  try: r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=180); code, outp = r.returncode, r.stdout
  except subprocess.TimeoutExpired as e: code, outp = 'timeout', (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
  finally: open(F, 'wb').write(orig)
  fails = re.findall(r'^✖ (.{0,70})', outp, re.M)
  print(f'{name}: exit={code} {"KILLED" if code != 0 else "SURVIVED"}; failing: {sorted(set(fails))[:9]}', flush=True)
  return code
surv = []
sel = sys.argv[1:]   # optional: mutant name prefixes (and/or BASE) to run; default all
try:
  if (not sel or 'BASE' in sel) and run('BASE frozen installed host.mjs 9634cb40', base) == 0: surv.append('BASE')
  for name, a, b in [m for m in M if not sel or any(m[0].startswith(x) for x in sel)]:
    s = orig.decode(); assert s.count(a) == 1, f'{name}: anchor count {s.count(a)}'
    if run(name, s.replace(a, b).encode()) == 0: surv.append(name)
finally:
  open(F, 'wb').write(orig)
assert sha(open(F, 'rb').read()) == before, 'not restored'
print('restored', before[:16], 'survivors', surv, flush=True); sys.exit(1 if surv else 0)
