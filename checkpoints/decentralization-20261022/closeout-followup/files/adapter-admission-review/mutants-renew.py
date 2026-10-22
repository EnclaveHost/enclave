#!/usr/bin/env python3
# Renewal keeper: negative control + mutation control (immutable). (BASE) the committed ad4a72a host.mjs AND chain.mjs (the
# admission fix, no keeper) in place of the candidate's; (H*/C*) one-change mutants of the candidate's host.mjs / chain.mjs.
# Each must FAIL test/windows-node-lease-renewal-keeper.test.mjs unless marked EXPECTED-SURVIVOR (a layer another one covers).
# r2 (after rmut2): H9 split (whole identity check / config only), H12 removes both expiry checks, H12a the local one only.
# Both files are restored after each run and checked by sha256.
import hashlib, os, subprocess, sys, re
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review'
REPO = HERE + '/candidate'
FH, FC = os.path.join(REPO, 'windows/node/host.mjs'), os.path.join(REPO, 'windows/node/chain.mjs')
sha = lambda b: hashlib.sha256(b).hexdigest()
orig = {FH: open(FH, 'rb').read(), FC: open(FC, 'rb').read()}; before = {f: sha(b) for f, b in orig.items()}
head = {f: subprocess.check_output(['git', '-C', REPO, 'show', 'HEAD:' + os.path.relpath(f, REPO)]) for f in (FH, FC)}
assert subprocess.check_output(['git', '-C', REPO, 'rev-parse', 'HEAD']).decode().startswith('ad4a72a'), 'HEAD is the admission fix'
assert sha(head[FH]) == '637fbdf6af2eedc868444c471d1d9cb7d767d8fb70ab52a2cc05b20e3c49dca3' and sha(head[FC]) == '86c81124cca6f6e1c06c25c075c03c6811bb46e9344291df080245ffdf3d6580'
DRAFT_SEEN = '''      this.#leaseSeen.set(id, { leaseUntil: Number(d.leaseUntil), owner: String(d.owner ?? "").toLowerCase(), isPublic: d.isPublic !== false,
        appRef: String(d.appRef ?? ""), configCid: String(d.configCid ?? "") });
      // THE OWNER'S EDIT'''
M = [
 ('H1 eligibility published from the OBSERVED row before serving reconciliation (the draft)', FH, "      // THE OWNER'S EDIT", DRAFT_SEEN, 1),
 ('H2 no permit re-check after the lead read AND none at the send', FH,
  "      const stale = permit();\n      if (stale) return { superseded: stale };\n      await chain.renewDeployment(id, { gate: permit });", "      await chain.renewDeployment(id);", 1),
 ('H2a no permit re-check after the lead read (covered by the send-time gate; can be killed only by the log wording)', FH,
  "      const stale = permit();\n      if (stale) return { superseded: stale };\n", "", 1),
 ('H2b no permit at the send (queued intent acts on stale permission)', FH, "await chain.renewDeployment(id, { gate: permit });", "await chain.renewDeployment(id);", 1),
 ('H3 a wallet withdrawal does not void the permit', FH, "  #walletRevoke(id) {\n    this.#renewVoid(id);\n", "  #walletRevoke(id) {\n", 1),
 ('H4 a release does not wait for a renewal in flight', FH, "      await this.#renewing.get(id)?.catch(() => {});\n", "", 1),
 ('H5 no per-deployment join (pass and keeper both send)', FH, "    for (let busy; (busy = this.#renewing.get(id));) {", "    for (let busy; false;) {", 1),
 ('H6 no renewed-lease fence (a lagging read renews again)', FH, "    this.#renewedFrom.set(id, untilS); this.#renewFailed.delete(id);", "    this.#renewFailed.delete(id);", 1),
 ('H7 an outer timeout releases the in-flight slot (overlap)', FH, "    const p = run().finally(", "    const p = Promise.race([run(), new Promise((r) => setTimeout(() => r({ failed: new Error(\"timeout\") }), 300))]).finally(", 1),
 ('H8 the keeper ignores the host wallet decision', FH, "    if (wallet.refusal || wallet.unknown) return { skipped: `host wallet policy ${wallet.refusal ? \"refusal\" : \"unknown\"}: the pass decides` };\n", "", 1),
 ('H9 the keeper ignores identity changes on the fresh row', FH, "    if (lc(d.owner) !== seen.owner || (d.isPublic !== false) !== seen.isPublic || String(d.appRef ?? \"\") !== seen.appRef\n        || String(d.configCid ?? \"\") !== seen.configCid) return { skipped: \"the row changed since the pass served it\" };\n", "", 1),
 ('H9b the keeper ignores a config change only', FH, "        || String(d.configCid ?? \"\") !== seen.configCid) return { skipped: \"the row changed since the pass served it\" };", "        || false) return { skipped: \"the row changed since the pass served it\" };", 1),
 ('H10 the lead is read on every pass (no cache)', FH, "    if (c && c.leaseUntil === untilS && Date.now() - c.at < RENEW_LEAD_CACHE_MS) return c.ms;\n", "", 1),
 ('H11 a wallet-held deployment counts as served', FH, "rec.status === \"running\" && !rec.walletHeld && rec.boundaryHeld", "rec.status === \"running\" && rec.boundaryHeld", 1),
 ('H12 the keeper acts on an expired lease (both its local and its fresh-row expiry checks removed)', FH, "      return seen && !early && until > now && until - now", "      return seen && !early && until - now", 1,
  "    if (!(d.active === true && lc(d.runner) === lc(this.enclaveId) && untilS * 1000 > Date.now()))", "    if (!(d.active === true && lc(d.runner) === lc(this.enclaveId)))"),
 ('H12a only the local expiry pre-filter removed (EXPECTED-SURVIVOR: the fresh-row check covers it)', FH, "      return seen && !early && until > now && until - now", "      return seen && !early && until - now", 1),
 ('H13 no retry pause after a failure', FH, "Date.now() + RENEW_RETRY_MS", "Date.now()", 2),
 ('C1 an app-funded renew falls back to the operator\'s ETH', FC, "    try { result = await leaseSender()[fn](...args); }",
  "    try { try { result = await leaseSender()[fn](...args); } catch (x) { if (fn === \"renew\") return send(addresses.deployments, DEP_ABI, fn, args); throw x; } }", 1),
]
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
cmd = ['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec test/windows-node-lease-renewal-keeper.test.mjs']
def restore():
  for f, b in orig.items(): open(f, 'wb').write(b)
def run(name, files):
  for f, b in files.items(): open(f, 'wb').write(b)
  try: r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=240); code, outp = r.returncode, r.stdout
  except subprocess.TimeoutExpired as e: code, outp = 'timeout', (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
  finally: restore()
  fails = re.findall(r'^✖ (.{0,60})', outp, re.M)
  print(f'{name}: exit={code} {"KILLED" if code != 0 else "SURVIVED"}; failing: {sorted(set(fails))[:10]}', flush=True)
  return code
surv = []
sel = sys.argv[1:]
try:
  if (not sel or 'BASE' in sel) and run('BASE committed ad4a72a host.mjs 637fbdf6 + chain.mjs 86c81124 (no keeper)', head) == 0: surv.append('BASE')
  for name, f, a, b, n, *more in [m for m in M if not sel or any(m[0].startswith(x) for x in sel)]:
    s = orig[f].decode(); assert s.count(a) == n, f'{name}: anchor count {s.count(a)}'
    s = s.replace(a, b)
    for a2, b2 in zip(more[0::2], more[1::2]): assert s.count(a2) == 1, f'{name}: anchor2'; s = s.replace(a2, b2)
    if run(name, {f: s.encode()}) == 0 and 'EXPECTED-SURVIVOR' not in name: surv.append(name)
finally:
  restore()
assert all(sha(open(f, 'rb').read()) == h for f, h in before.items()), 'not restored'
print('restored', {os.path.basename(f): h[:16] for f, h in before.items()}, 'survivors', surv, flush=True); sys.exit(1 if surv else 0)
