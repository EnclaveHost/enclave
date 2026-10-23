"""Mutation check: each mutant weakens ONE guard of common.py; the unchanged python suite must FAIL on it. Copies live BESIDE
this folder (relative paths stay valid), and an UNMUTATED control copy must pass first, else the run is invalid."""
import shutil, subprocess, sys
from pathlib import Path
A = Path(__file__).resolve().parent; SRC = (A/'common.py').read_text()
OTHER = {   # name: (file, from, to) - run against the python suite AND the node tests
 'block-hash-ignored': ('boot-funding.mjs', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash", "timestamp"];', 'export const CANONICAL_BLOCK = ["number", "parentHash", "timestamp"];'),
 'block-timestamp-ignored': ('boot-funding.mjs', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash", "timestamp"];', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash"];'),
 'block-number-unchecked': ('boot-funding.mjs', '  if (BigInt(blocks[0].number) !== n) throw', '  if (false) throw'),
 'block-null-accepted': ('boot-funding.mjs', '  return !!x && !!y && CANONICAL_BLOCK.every(', '  return (!x || !y) || CANONICAL_BLOCK.every('),
 'supervisor-hash-unchecked': ('boot-funding.mjs', '  if (got !== wantSupervisor) throw new Error', '  if (false) throw new Error'),
 'decision-hash-unchecked': ('boot-funding.mjs', '  if (dec !== wantDecision) throw new Error', '  if (false) throw new Error'),
 'pending-not-asked': ('boot-funding.mjs', 'pending: decide(row, { ...desired, gpuPricePerSec6: null })', 'pending: decide(row, desired)'),
 'wrapper-any-observed': ('attest-price.mjs', '    && v.observedMeasurement === t.measurement && Array.isArray', '    && Array.isArray'),
 'wrapper-failed-checks-ok': ('attest-price.mjs', ' && Array.isArray(v.failedChecks) && v.failedChecks.length === 0;', ';'),
 'wrapper-image-unchecked': ('attest-price.mjs', '    for (const [f, h] of Object.entries(t.files)) if (fileSha', '    for (const [f, h] of Object.entries({})) if (fileSha'),
 'wrapper-unapproved-ok': ('attest-price.mjs', "  if (fs.readFileSync(path.join(dir, 'APPROVED-BUILD.txt'), 'utf8') !== `build-sha256 ${h}\\n`) throw", "  if (false) throw"),
 'wrapper-prior-ok': ('attest-price.mjs', ' || PRIORS.includes(m)) throw', ') throw'),
 'activate-watchdog-stop-ignored': ('activate.py', "    if wd['outcome'] != 'exited': raise RuntimeError(", "    if False: raise RuntimeError("),
 'activate-after-gate-unchecked': ('activate.py', "    if probs: raise RuntimeError('lease margin after the gate: '", "    if False: raise RuntimeError('lease margin after the gate: '"),
 'activate-pregate-unchecked': ('activate.py', "    if probs: raise RuntimeError('lease margin before the gate: '", "    if False: raise RuntimeError('lease margin before the gate: '"),
 'activate-signals-unhandled': ('activate.py', "for _s in (signal.SIGHUP, signal.SIGTERM): signal.signal(_s, _signalled)\n", "\n"),
 'activate-rollback-interruptible': ('activate.py', "    for _s in (signal.SIGHUP, signal.SIGTERM): signal.signal(_s, signal.SIG_IGN)   # the rollback", "    pass   # the rollback"),
 'sender-hash-unchecked': ('boot-funding.mjs', '  if (got !== wantSender) throw new Error', '  if (false) throw new Error'),
 'sender-model-not-run': ('boot-funding.mjs', '  return { sender: pick(sent.request), prepared: { ...pick(sent.prepared), type', '  return { sender: pick(sent.request), prepared: { ...pick(sent.request), type'),
 'sender-not-prepared': ('boot-funding.mjs', '    const prepared = await walletClient.prepareTransactionRequest({ ...rest, account, chain, to: address,', '    const prepared = rest || await walletClient.prepareTransactionRequest({ ...rest, account, chain, to: address,'),
}
MUT = {
 # the first attempt's (unchanged code)
 'config-before-stop': ("    ops.systemctl('stop', UNIT)\n", "    atomic_config(old_config, config.stat().st_mode & 0o777, config)\n    ops.systemctl('stop', UNIT)\n"),
 'no-deadline-wait': ("    if deadlines:\n        wait", "    if False:\n        wait"),
 'no-concurrent-config-cas': ("    assert config.read_bytes() == new_config, 'config changed concurrently: refuse overwriting it'\n", ""),
 'no-dropin-check': ("    assert ops.read_dropins() == CURRENT['dropins'], 'drop-ins changed concurrently: refuse restarting into an unknown unit'\n", ""),
 'non-additive-admission': ("','.join(existing + [new])", "','.join([new])"),
 'cas-no-restore': ("    e.write_bytes(old); subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)\n    print('ADMISSION-RESTORED after failure')", "    print('ADMISSION-RESTORED after failure')"),
 'small-margin-ok': ("<= ROLLBACK_MARGIN_S + ADOPT_S", "<= 0"),
 # this attempt's
 'admission-count-ignored': ("    if len(existing) != expected: raise", "    if False: raise"),
 'build-marker-at-least-once': ("        if lines.count(w) != 1: out.append", "        if lines.count(w) < 1: out.append"),
 'approval-unchecked': ("    if appr != f'build-sha256 {sha(raw)}\\n': raise", "    if False: raise"),
 'plan-unchecked': ("    if plan.get('buildSha256') != h or plan.get('measurement') != rec['measurement'] or plan.get('files') != rec['files']:\n        raise", "    if False:\n        raise"),
 'guestd-replacement-adopted': ("        if str(r.get('id')) != want['guest']: out.append", "        if False: out.append"),
 'guestd-starting-ok': ("        if r.get('status') != 'running': out.append", "        if False: out.append"),
 'guestd-no-record-ok': ("        if not re.fullmatch(r'[0-9a-f]{64}', str(r.get('recordSha256') or '')): out.append", "        if False: out.append"),
 'guestd-history-ignored': ("        if hist != want['history']: out.append", "        if False: out.append"),
 'guestd-two-live-ok': ("        if len(live) != 1: out.append", "        if not live: out.append"),
 'guestd-stale-listing-ok': ("    if now - st.st_mtime > max_age or", "    if False or"),
 'guestd-public-listing-ok': ("    if st.st_mode & 0o077: raise", "    if False: raise"),
 'availability-pretends-adopted': ("    if held is None: return 'absent: the old control is not registered and adopted nothing', []", "    if held is None: return 'present and agrees with guestd', []"),
 'funding-fields-ignored': ("            out.append('the registered fields are not exactly", "            pass  # out.append('the registered fields are not exactly"),
 'funding-pending-ignored': ("or [int(x) for x in o['pending']] != [n, n]: out.append", ": out.append"),
 'funding-no-headroom': ("'maxAgeS': 360, 'headroomPct': 125,", "'maxAgeS': 360, 'headroomPct': 100,"),
 'funding-delegation-ignored': ("        if lc(f['operator']['code']) != P['operatorCode']: out.append", "        if False: out.append"),
 'funding-stale-ok': ("        if age >= P['maxAgeS'] or age < -30: out.append", "        if False: out.append"),
 'keep-any-measurement': ("or v.get('expectedMeasurement') != want or v.get('observedMeasurement') != want or", "or"),
 'keep-failed-verdict-ok': ("    if v.get('pass') is not True: out.append('pass is not true')\n    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append", "    if False: out.append"),
 'keep-raw-unchecked': ("        if file_sha(raw) != v.get('rawSha256'): out.append", "        if False: out.append"),
 'keep-before-attach-ok': ("        if not attached_at or at <= datetime.datetime.fromisoformat(attached_at).timestamp(): out.append", "        if False: out.append"),
 'admission-drops-prior': ("    if any(p not in existing for p in priors): raise", "    if False: raise"),
 'build-other-source-ok': ("    if {k: brec.get(k) for k in keys} != {k: src[k] for k in keys}: out.append", "    if False: out.append"),
 'build-08d1-image-ok': ("        if inv[f] == NINE['files'][f]: out.append", "        if False: out.append"),
 'build-kernel-may-change': ("        if inv[f] != NINE['files'][f]: out.append", "        if False: out.append"),
 'build-measurement-file-unchecked': ("    if m is not None and (measurement_text != m + '\\n' or brec.get('measurement') != m): out.append", "    if False: out.append"),
 'source-expectation-unchecked': ("    if b'SHIELDED_GPU_EXPECTED' not in gs or", "    if False and b'SHIELDED_GPU_EXPECTED' not in gs or"),
 'source-gsup-unchanged-ok': ("    if not rec['gsupReviewed']: raise", "    if False: raise"),
 'precheck-unpinned': ("    if sha(p.read_bytes()) != want: raise", "    if False: raise"),
 'funding-register-accepted': ("        if f['actions'] != {'pending': SET, 'discovered': SET}: out.append", "        if f['actions'].get('discovered') != SET: out.append"),
 'funding-pending-fields-unchecked': ("        if f['desiredPending'] != {**d, 'gpuPricePerSec6': None}: out.append", "        if False: out.append"),
 'funding-decision-hash-ignored': ("        if f['source'] != {'commit': new['commit'], 'supervisorSha256': new['supervisorSha256'], 'bootDecisionSha256': new['bootDecisionSha256'], 'senderSha256': new['senderSha256']}:", "        if f['source']['commit'] != new['commit']:"),
 'margin-900-inclusive': ("        if left <= need: out.append", "        if left < need: out.append"),
 'expectation-ignored': ("    if iso.get('shieldedInference') is not True: return 0", "    if False: return 0"),
 'watchdog-floor-ignored': ("e - now <= WATCH_FLOOR_S}", "e - now <= 0}"),
 'watchdog-stale-ignored': ("        elif last is None or now - last['blockTs'] > WATCH_STALE_S:", "        elif last is None:"),
 'watchdog-no-stop': ("            stop(proc)\n            return {'outcome': 'stopped'", "            return {'outcome': 'stopped'"),
 'watchdog-stop-reported-exited': ("            return {'outcome': 'stopped', 'why': why,", "            return {'outcome': 'exited', 'why': why,"),
 'after-gate-unchecked': ("    return fresh_lease(read, holder, ROLLBACK_MARGIN_S, 'after the gate', **kw)", "    return fresh_lease(read, holder, 0, 'after the gate', **kw)"),
 'keep-target-any': ("    if v.get('target') != 'priceRecovery' or v.get('accepted') is not True:", "    if False:"),
 'keep-failedchecks-missing-ok': ("    if v.get('failedChecks') != []:", "    if v.get('failedChecks'):"),
 'keep-build-any': ("    if v.get('buildSha256') != build_sha or", "    if False or"),
 'watchdog-block-age-unchecked': ("    stale = [] if -30 <= now - r['blockTs'] <= WATCH_STALE_S else", "    stale = [] if True else"),
 'watchdog-holder-unchecked': ("    moved = [] if first is None or r.get('holder') == first.get('holder') else", "    moved = [] if True else"),
 'stop-no-descendant-sweep': ("        try: proc.wait(timeout=wait); break\n        except subprocess.TimeoutExpired: continue\n    try: os.killpg(proc.pid, signal.SIGKILL)", "        try: proc.wait(timeout=wait); break\n        except subprocess.TimeoutExpired: continue\n    try: pass"),
 'after-gate-holder-unchecked': ("    if holder is None: moved = ['no lease holder to compare with']", "    pass"),
 'feasibility-ignored': ("    need = max(CUTOVER_MARGIN_S, CUTOVER_FEASIBLE_S) if need is None else need", "    need = CUTOVER_MARGIN_S if need is None else need"),
 'feasibility-1020': ("CUTOVER_FEASIBLE_S = WATCH_FLOOR_S + GATE_WINDOW_S + ATTACH_S + ADOPT_S   # = 1440", "CUTOVER_FEASIBLE_S = WATCH_FLOOR_S + GATE_WINDOW_S   # = 1440"),
 'seed-blessed-fresh-now': ("        last = first = initial; nxt = initial['readAt'] + WATCH_POLL_S", "        last = first = {**initial, 'blockTs': wall()}; nxt = wall() + WATCH_POLL_S"),
 'stale-from-readAt': ("now - last['blockTs'] > WATCH_STALE_S: why", "now - last['readAt'] > WATCH_STALE_S: why"),
 'pre-gate-floor-unchecked': ("    return fresh_lease(read, holder, WATCH_FLOOR_S, 'before the gate', **kw)", "    return fresh_lease(read, holder, 0, 'before the gate', **kw)"),
 'after-gate-holder-retried': ("            if not p or not all(x.startswith('agreed block is') for x in p): return (r if not p else None), p", "            if not p: return r, p"),
 'after-gate-no-retry': ("        sleep(tick)\n\ndef lease_before_gate", "        return None, errs\n\ndef lease_before_gate"),
 'sender-contract-unchecked': ("    if p: raise AssertionError('the approved sendOperatorTx breaks the fee contract: '", "    if False: raise AssertionError('the approved sendOperatorTx breaks the fee contract: '"),
 'contract-no-fee-read': ("    if 'chainClient.estimateFeesPerGas(' not in text:", "    if False:"),
 'contract-no-gas-read': ("    if 'chainClient.estimateContractGas(' not in text:", "    if False:"),
 'contract-writecontract-any': ("    elif not all(re.search(r'\\b' + k + r'\\b', w.group(1)) for k in ('gas', 'maxFeePerGas', 'maxPriorityFeePerGas')):", "    elif False:"),
 'contract-queue-any': ("    if '_txChain.then(' not in text:", "    if False:"),
 'funding-sender-silent-ok': ("            if any(x is None or not str(x).isdigit() or int(x) <= 0 for x in sent):", "            if False:"),
 'funding-reprice-ok': ("            elif (r['gas'], r['maxFeePerGas'], r['maxPriorityFeePerGas']) != sent:", "            elif False:"),
 'funding-worst-min': ("        worst = max(worsts) if worsts else 0", "        worst = min(worsts) if worsts else 0"),
 'funding-one-rpc-ok': ("        if [r['rpc'] for r in rows] != list(f['rpcs']):", "        if not rows:"),
}
def run(name, src, file='common.py'):
    d = A.parent / f'{A.name}.mut-{name}'
    if d.exists(): shutil.rmtree(d)
    # never root's runtime files: evidence/ carries only the pinned original baseline into the copy
    shutil.copytree(A, d, ignore=shutil.ignore_patterns('.git', 'logs', '__pycache__', '*.mut-*', '*private*', 'boot-funding*.json', 'guestd-baseline*.json',
                                                         'lease-preflight*.json', 'ROOT-*', 'result.json', 'private-backup', '.attest-price-test-*', 'build.json', 'STATUS.txt'))
    (d/file).write_text(src)
    r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests'], cwd=d, capture_output=True, text=True, timeout=600)
    if r.returncode == 0:
        r = subprocess.run(['node', '--test', '--test-concurrency=1', 'tests/boot-funding.test.mjs', 'tests/attest-price.test.mjs'], cwd=d, capture_output=True, text=True, timeout=600)
    shutil.rmtree(d); return r
c = run('control', SRC)
if c.returncode != 0: print('CONTROL FAILED: the run is invalid\n' + c.stderr[-2000:]); sys.exit(2)
print('control (unmutated copy) passes')
bad = 0
for name, (a, b) in MUT.items():
    assert SRC.count(a) == 1, (name, a[:70])
    r = run(name, SRC.replace(a, b)); killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name)
for name, (f, a, b) in OTHER.items():
    s = (A/f).read_text(); assert s.count(a) == 1, (name, a[:70])
    r = run(name, s.replace(a, b), f); killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name)
print(f'mutants {len(MUT) + len(OTHER)} survived {bad}'); sys.exit(1 if bad else 0)
