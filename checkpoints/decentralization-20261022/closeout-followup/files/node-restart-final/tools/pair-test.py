#!/usr/bin/env python3
"""Scenario tests of helper/node-pair-restart.ps1 under tools/pair-mock.ps1 on Linux pwsh 7. The two module swaps run the REAL
pinned bundle-swap.ps1 (21d85c69) in real child pwsh processes on real files (tools/swap-prelude.ps1 supplies the Windows ACL
cmdlets and the injected faults). Proves the DECISIONS (pins, order, conclusive vs unknown outcomes, proven undo, consistent-pair
start, readiness, lease/updater gates, refusals) - NOT native Windows behaviour (Task Scheduler, CIM, ACLs, timings)."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; H = T.parent
PWSH = os.environ.get('PWSH', str(H.parent.parent / 'node-hold-package-20261021/tools/pwsh/pwsh'))
SCRIPT = H / 'helper/node-pair-restart.ps1'
SWAP = H.parent.parent / 'cron-startup-20261021/respawn-activation/bundle-swap.ps1'
NODE = shutil.which('node')
RUNNER = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'
IDS = ['0x' + c * 64 for c in 'ab']
sha = lambda b: hashlib.sha256(b).hexdigest()
CLOCK0 = int(datetime.datetime(2026, 10, 22, 22, 30, 0, tzinfo=datetime.timezone.utc).timestamp())
START = '2026-10-22T03:37:27.6506510Z'; SCHED_START = '2026-10-20T08:00:01.1000000Z'
OLD = {'chain.mjs': b'export const chain = 1;\n', 'host.mjs': b'export const host = 1;\n'}
NEW = {'chain.mjs': b'export const chain = 2; // permission gate\n', 'host.mjs': b'export const host = 2; // renewal retry\n'}
assert sha(SWAP.read_bytes()) == '21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103'
LEASE = {'marginSec': 120, 'revertSec': 700, 'forwardMinSec': 835, 'startNodeSec': 600, 'reserve': 'recovery-start'}

def world(lease_offset=1790):
    base = H / 'tmp'; base.mkdir(exist_ok=True)
    r = pathlib.Path(tempfile.mkdtemp(prefix='pair-', dir=base))
    for d in ('logs', 'stage/new', 'stage/swap-chain/.bundle-swap', 'stage/swap-host/.bundle-swap', 'control/windows/node'): (r / d).mkdir(parents=True)
    for n in OLD: (r / 'control/windows/node' / n).write_bytes(OLD[n]); (r / 'stage/new' / n).write_bytes(NEW[n])
    (r / 'chain-old.sha').write_text(sha(OLD['chain.mjs']))
    shutil.copy(SWAP, r / 'stage/bundle-swap.ps1')
    (r / 'run-node.cmd').write_bytes(b'@echo off\r\nrem launcher\r\n'); (r / 'node-config.local.cmd').write_bytes(b'set X=1\r\n')
    (r / 'logs/node.log').write_text('22:00:00 boot\n'); (r / 'expected-ids.txt').write_text('\n'.join(IDS) + '\n')
    (r / 'vms.json').write_text(json.dumps([{'id': 'hv' + i[2:10], 'name': i, 'status': 'running'} for i in IDS]))
    (r / 'hyperv.json').write_text(json.dumps([{'Id': f'0000000{i}-1111-2222-3333-444444444444', 'Name': f'vm-{i}', 'State': 'Running'} for i in range(3)]))
    procs = [{'pid': 3292, 'ppid': 700, 'name': 'svchost.exe', 'cmd': r'C:\WINDOWS\system32\svchost.exe -k netsvcs -p -s Schedule', 'start': SCHED_START},
             {'pid': 23976, 'ppid': 3292, 'name': 'cmd.exe', 'cmd': r'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"', 'start': START},
             {'pid': 8644, 'ppid': 23976, 'name': 'node.exe', 'cmd': r'"node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"', 'start': START},
             {'pid': 13932, 'ppid': 3001, 'name': 'node.exe', 'cmd': r'"node.exe" "C:\Program Files\Enclave\network\privacy-agent.mjs" --config x', 'start': '2026-10-22T03:37:14.0971470Z'},
             {'pid': 4001, 'ppid': 1, 'name': 'node.exe', 'cmd': 'manager main.mjs', 'start': '2026-10-21T12:13:07.5552110Z'}]
    (r / 'procs.json').write_text(json.dumps(procs)); leases(r, lease_offset)
    return r
def leases(r, offset): (r / 'leases.json').write_text(json.dumps([{'id': i, 'status': 'running', 'leaseUntil': CLOCK0 + offset} for i in IDS]))
def vms_string(r): return ','.join(sorted(f"{v['id']}|{v['name']}|{v['status']}" for v in json.loads((r / 'vms.json').read_text())))
def hv_string(r): return ','.join(sorted(f"{v['Id']}|{v['Name']}|{v['State']}" for v in json.loads((r / 'hyperv.json').read_text())))
def tgt(r, n): return str(r / 'control/windows/node' / n)

def params(r, run, node=None, **over):
    st = str(r / 'stage')
    files = [{'name': n, 'target': tgt(r, n), 'oldSha': sha(OLD[n]), 'newSha': sha(NEW[n]), 'newFile': f'{st}/new/{n}', 'workDir': f"{st}/swap-{n.split('.')[0]}"} for n in ('host.mjs', 'chain.mjs')]
    p = {'stage': st, 'runId': run, 'boundSec': 1140, 'runner': RUNNER, 'testRoot': str(r), 'testNode': NODE, 'testPrelude': str(T / 'swap-prelude.ps1'),
         'bundleSwap': {'path': f'{st}/bundle-swap.ps1', 'sha': sha(SWAP.read_bytes())}, 'files': files,
         'unchangedFiles': [{'path': str(r / 'run-node.cmd'), 'sha': sha((r / 'run-node.cmd').read_bytes())}, {'path': str(r / 'node-config.local.cmd'), 'sha': sha((r / 'node-config.local.cmd').read_bytes())}],
         'task': {'execute': 'cmd.exe', 'arguments': r'/c "C:\ProgramData\Enclave\run-node.cmd"'},
         'node': node or {'cmdPid': 23976, 'cmdStart': START, 'agentPid': 8644, 'agentStart': START},
         'scheduler': {'pid': 3292, 'start': SCHED_START, 'name': 'svchost.exe', 'commandLike': '*-s Schedule*'},
         'manager': '4001@2026-10-21T12:13:07.5552110Z', 'privacy': {'pid': 13932, 'start': '2026-10-22T03:37:14.0971470Z'},
         'vms': vms_string(r), 'hyperv': hv_string(r), 'expectedIds': IDS, 'lease': dict(LEASE)}
    for k, v in over.items():
        if k == 'lease': p['lease'].update(v)
        else: p[k] = v
    return p

def run(r, p, mode='apply', scenario='ok', timeout=300):
    pf = r / 'stage' / f"params-{p['runId']}-{mode}.json"; pf.write_text(json.dumps(p)); ps = sha(pf.read_bytes())
    c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / 'pair-mock.ps1'), '-Script', str(SCRIPT), '-Root', str(r), '-ParamsFile', str(pf),
                        '-ParamsSha', ps, '-Mode', mode, '-Scenario', scenario], capture_output=True, text=True, timeout=timeout)
    j = r / 'stage' / f"pair-{p['runId']}.jsonl"
    lines = [json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []
    return lines, c
def final(lines): return next((l['final'] for l in reversed(lines) if 'final' in l), '') or ''
def events(r): return (r / 'node-events.txt').read_text().split('\n') if (r / 'node-events.txt').exists() else []
def starts(r): return sum(1 for e in events(r) if e.startswith('start'))
def stops(r): return sum(1 for e in events(r) if e.startswith('stop'))
def kills(r): return [e for e in events(r) if e.startswith('kill')]
def pair(r): return tuple(sha((r / 'control/windows/node' / n).read_bytes()) for n in ('chain.mjs', 'host.mjs'))
OLDP = (sha(OLD['chain.mjs']), sha(OLD['host.mjs'])); NEWP = (sha(NEW['chain.mjs']), sha(NEW['host.mjs']))
def journal(r, n): f = r / f"stage/swap-{n}/.bundle-swap/journal.json"; return json.loads(f.read_text())['state'] if f.exists() else 'absent'
def new_identities(r):   # the running node after a run (for the next run's pins)
    ps = json.loads((r / 'procs-state.json').read_text()) if (r / 'procs-state.json').exists() else None
    return ps

class Pair(unittest.TestCase):
    def setUp(self): self.r = world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def ok(self, lines, c, prefix): self.assertTrue(final(lines).startswith(prefix), (final(lines), [l.get('recovery') for l in lines if l.get('recovery')], c.stdout[-600:], c.stderr[-900:]))

    # ---- the forward window and the explicit return
    def test_apply_swaps_both_then_starts_a_new_agent_proven_ready(self):
        lines, c = run(self.r, params(self.r, 'a1')); self.ok(lines, c, 'DONE:')
        self.assertEqual(pair(self.r), NEWP); self.assertEqual((stops(self.r), starts(self.r)), (1, 1)); self.assertEqual(kills(self.r), [])
        self.assertEqual((journal(self.r, 'chain'), journal(self.r, 'host')), ('done', 'done'))
        sw = [l['detail'] for l in lines if l.get('step') == 'swap']
        self.assertEqual([(s['file'], s['op'], s['result']) for s in sw], [('chain.mjs', 'apply', 'done'), ('host.mjs', 'apply', 'done')], 'callee first')
        post = next(l for l in lines if l.get('step') == 'post'); self.assertNotEqual(post['agent']['pid'], 8644)
        pins = next(l for l in lines if l.get('step') == 'pins'); self.assertEqual(pins['reserve'], 'recovery-start')
        self.assertEqual([i['decision'] for i in pins['inspect']], ['would apply', 'would apply'], 'bundle-swap inspect (CAS + node --check) before the stop')
    def test_rollback_returns_to_the_old_pair_from_the_backups(self):
        lines, c = run(self.r, params(self.r, 'a2')); self.ok(lines, c, 'DONE:')
        agent = next(l for l in lines if l.get('step') == 'start-node')
        node = {'cmdPid': agent['cmd']['pid'], 'cmdStart': agent['cmd']['start'], 'agentPid': agent['agent']['pid'], 'agentStart': agent['agent']['start']}
        lines, c = run(self.r, params(self.r, 'r2', node=node), mode='rollback'); self.ok(lines, c, 'ROLLED_BACK:')
        self.assertEqual(pair(self.r), OLDP); self.assertEqual(starts(self.r), 2)
        self.assertEqual([(l['detail']['file'], l['detail']['op']) for l in lines if l.get('step') == 'swap'], [('host.mjs', 'rollback'), ('chain.mjs', 'rollback')], 'reverse order')
    def test_partial_return_refused_conclusively_re_applies_the_proven_step_and_restarts_the_new_pair(self):
        lines, c = run(self.r, params(self.r, 'a3')); self.ok(lines, c, 'DONE:')
        agent = next(l for l in lines if l.get('step') == 'start-node')
        node = {'cmdPid': agent['cmd']['pid'], 'cmdStart': agent['cmd']['start'], 'agentPid': agent['agent']['pid'], 'agentStart': agent['agent']['start']}
        lines, c = run(self.r, params(self.r, 'r3', node=node), mode='rollback', scenario='rollback-chain-backup-gone'); self.ok(lines, c, 'RETURN_REFUSED_NEW_PAIR_RESTARTED')
        self.assertEqual(pair(self.r), NEWP, 'the proven host rollback was undone by a proven re-apply')
        self.assertEqual([(l['detail']['file'], l['detail']['op'], l['detail']['result']) for l in lines if l.get('step') in ('swap', 'undo')],
                         [('host.mjs', 'rollback', 'done'), ('chain.mjs', 'rollback', 'unchanged'), ('host.mjs', 'apply', 'done')])

    # ---- partial forward swaps: conclusive -> proven undo + the OLD pair; unknown -> nothing more, node NOT started
    def test_second_file_refused_conclusively_undoes_the_first_and_restarts_the_old_pair(self):
        lines, c = run(self.r, params(self.r, 'p1'), scenario='host-staged-changed'); self.ok(lines, c, 'SWAP_REFUSED_OLD_PAIR_RESTARTED')
        self.assertEqual(pair(self.r), OLDP); self.assertEqual(starts(self.r), 1)
        self.assertEqual([(l['detail']['file'], l['detail']['op'], l['detail']['result']) for l in lines if l.get('step') in ('swap', 'undo')],
                         [('chain.mjs', 'apply', 'done'), ('host.mjs', 'apply', 'unchanged'), ('chain.mjs', 'rollback', 'done')])
    def test_first_file_child_crash_before_any_write_is_conclusive_and_restarts_the_old_pair(self):
        lines, c = run(self.r, params(self.r, 'p2'), scenario='chain-crash'); self.ok(lines, c, 'SWAP_REFUSED_OLD_PAIR_RESTARTED')
        self.assertEqual(pair(self.r), OLDP); self.assertEqual(journal(self.r, 'host'), 'absent', 'the host file was never attempted')
    def test_a_hung_swap_child_is_unknown_mixed_pair_and_the_node_is_not_started(self):
        lines, c = run(self.r, params(self.r, 'p3'), scenario='host-hang'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(starts(self.r), 0); self.assertEqual(pair(self.r), (NEWP[0], OLDP[1]), 'chain new, host old: never started')
        rec = next(l for l in lines if 'recovery' in l); self.assertTrue(rec['pairNow'].startswith('mixed:'))
        s = [l['detail'] for l in lines if l.get('step') == 'swap'][-1]; self.assertTrue(s['timedOut']); self.assertEqual(s['result'], 'unknown')
    def test_an_undo_that_cannot_be_proven_is_unknown_and_the_node_is_not_started(self):
        lines, c = run(self.r, params(self.r, 'p4'), scenario='host-staged-changed-undo-hangs'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(starts(self.r), 0); self.assertIn('MIXED', next(l for l in lines if 'recovery' in l)['recovery'])
    def test_acl_not_restored_leaves_the_journal_started_unknown(self):
        lines, c = run(self.r, params(self.r, 'p5'), scenario='chain-acl-mismatch'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(starts(self.r), 0); self.assertEqual(journal(self.r, 'chain'), 'started'); self.assertEqual(journal(self.r, 'host'), 'absent')
    def test_a_child_dying_after_the_replace_is_unknown(self):
        lines, c = run(self.r, params(self.r, 'p6'), scenario='host-crash-after-replace'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(starts(self.r), 0); self.assertEqual(pair(self.r), NEWP); self.assertEqual(journal(self.r, 'host'), 'started')

    # ---- process guards
    def test_stale_9600_listener_after_the_stop_writes_nothing_and_does_not_start(self):
        lines, c = run(self.r, params(self.r, 'g1'), scenario='stale-listener'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual((pair(self.r), starts(self.r)), (OLDP, 0))
    def test_a_module_or_config_changed_while_stopped_writes_nothing_and_does_not_start(self):
        for sc in ('module-changed-while-stopped', 'config-changed-while-stopped'):
            r = world(); lines, c = run(r, params(r, 'g2'), scenario=sc); self.ok(lines, c, 'RECOVERY_REQUIRED')
            self.assertEqual(starts(r), 0); self.assertEqual(journal(r, 'chain'), 'absent'); shutil.rmtree(r, ignore_errors=True)
    def test_a_launcher_of_another_parent_is_never_accepted(self):
        lines, c = run(self.r, params(self.r, 'g3'), scenario='foreign-parent'); self.ok(lines, c, 'NOT_READY')
        self.assertIn('pinned Task Scheduler', next(l for l in lines if 'recovery' in l)['recovery']); self.assertEqual(starts(self.r), 1)
    def test_a_reused_pid_with_a_new_start_is_a_new_identity(self):
        lines, c = run(self.r, params(self.r, 'g4'), scenario='pid-reuse'); self.ok(lines, c, 'DONE:')
        a = next(l for l in lines if l.get('step') == 'start-node')['agent']; self.assertEqual(a['pid'], 8644); self.assertNotEqual(a['start'], START)
    def test_an_unkillable_agent_is_killed_only_by_its_verified_pid_and_nothing_is_written(self):
        lines, c = run(self.r, params(self.r, 'g5'), scenario='agent-unkillable'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(kills(self.r), ['kill 8644']); self.assertEqual((pair(self.r), starts(self.r)), (OLDP, 0))
    def test_task_outcome_failures_are_never_retried(self):
        lines, c = run(self.r, params(self.r, 'g6'), scenario='throw-after-task-stop'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual((pair(self.r), starts(self.r), stops(self.r)), (OLDP, 0, 1))
        r = world(); lines, c = run(r, params(r, 'g7'), scenario='throw-after-task-start'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual((starts(r), stops(r)), (1, 1), 'one start, no retry'); shutil.rmtree(r, ignore_errors=True)

    # ---- readiness: the NEW agent, its own listener, a completed pass after its start, every expected app ready
    def test_readiness_failures_end_not_ready_without_retry(self):
        for sc in ('never-ready', 'stale-readiness', 'app-not-ready', 'foreign-9600'):
            r = world(); lines, c = run(r, params(r, 'n-' + sc), scenario=sc); self.ok(lines, c, 'NOT_READY')
            self.assertEqual((starts(r), stops(r)), (1, 1), sc); self.assertEqual(pair(r), NEWP, sc); shutil.rmtree(r, ignore_errors=True)

    # ---- updater, lease and budget gates (nothing stopped)
    def test_updater_and_lease_refusals_stop_nothing(self):
        cases = [('update-due', {}, 1790), ('update-in-reserve', {}, 1790), ('update-queued-before-stop', {}, 1790), ('lease-shrinks-before-stop', {}, 1790), ('ok', {}, 1000)]
        for sc, over, off in cases:
            r = world(off); lines, c = run(r, params(r, 'u-' + sc, **over), scenario=sc)
            self.assertTrue(final(lines).startswith('REFUSED'), (sc, final(lines))); self.assertEqual((stops(r), pair(r)), (0, OLDP), sc); shutil.rmtree(r, ignore_errors=True)
    def test_zero_rate_full_return_with_margin_180_can_never_fit_a_1800_s_lease(self):
        # forward 835 + full return 835 + margin 180 = 1850 > 1800: a zero-rate renew is exactly now + 1800, so no instant fits
        r = world(1800); lines, c = run(r, params(r, 'z1', lease={'reserve': 'full-return', 'revertSec': 835, 'marginSec': 180}))
        self.assertIn('lease deadline', final(lines)); self.assertEqual(stops(r), 0); shutil.rmtree(r, ignore_errors=True)
    def test_full_return_with_margin_120_needs_1790_s_left_at_the_stop(self):
        # 835 + 835 + 120 = 1790: on a zero-rate lease only the first 10 s after a renewal lands (minus preflight) qualify
        for off, ok in ((1790, True), (1789, False)):
            r = world(off); lines, c = run(r, params(r, f'z2-{off}', lease={'reserve': 'full-return', 'revertSec': 835, 'marginSec': 120}))
            self.assertEqual(final(lines).startswith('DONE:'), ok, (off, final(lines))); shutil.rmtree(r, ignore_errors=True)
    def test_recovery_start_reserve_needs_1655_s_left_at_the_stop(self):
        # 835 + (100 + 600) + 120 = 1655: on a zero-rate lease the stop must come within 145 s of a renewal landing
        for off, ok in ((1655, True), (1654, False)):
            r = world(off); lines, c = run(r, params(r, f'z3-{off}', lease={'revertSec': 700}))
            self.assertEqual(final(lines).startswith('DONE:'), ok, (off, final(lines))); shutil.rmtree(r, ignore_errors=True)
    def test_budget_params_refused(self):
        for over, word in [({'lease': {'startNodeSec': 300, 'forwardMinSec': 535}}, 'measured first-pass'), ({'lease': {'forwardMinSec': 700}}, 'forwardMinSec must cover'),
                           ({'lease': {'reserve': 'full-return'}}, 'complete return window'), ({'lease': {'reserve': 'process'}}, 'lease.reserve must be'),
                           ({'lease': {'revertSec': 600}}, 'one completed pass'), ({'boundSec': 1500}, 'boundSec above')]:
            r = world(); lines, c = run(r, params(r, 'b', **over)); self.assertIn(word, final(lines)); self.assertEqual(stops(r), 0); shutil.rmtree(r, ignore_errors=True)
    def test_slow_pins_leave_no_forward_time(self):
        lines, c = run(self.r, params(self.r, 's1'), scenario='slow-pins'); self.assertTrue(final(lines).startswith('REFUSED'), final(lines)); self.assertEqual(stops(self.r), 0)

    # ---- params, identity pins, lock
    def test_params_and_pins_refused_before_anything(self):
        p = params(self.r, 'x1'); p['files'][0]['target'] = str(self.r / 'control/windows/node/other.mjs')
        cases = [p, params(self.r, 'x2', node={'cmdPid': 23976, 'cmdStart': START, 'agentPid': 1, 'agentStart': START}),
                 params(self.r, 'x3', bundleSwap={'path': str(self.r / 'stage/bundle-swap.ps1'), 'sha': '0' * 64}),
                 params(self.r, 'x4', scheduler={'pid': 3292, 'start': SCHED_START, 'name': 'svchost.exe', 'commandLike': '*-s Other*'})]
        q = params(self.r, 'x5'); q['files'][1]['workDir'] = q['files'][0]['workDir']; cases.append(q)
        q = params(self.r, 'x6'); q['files'][0]['newFile'] = '/tmp/elsewhere/host.mjs'; cases.append(q)
        for p in cases:
            lines, c = run(self.r, p); self.assertTrue(final(lines).startswith('REFUSED'), (p['runId'], final(lines)))
        lines, c = run(self.r, params(self.r, 'x7'), scenario='task-action-changed'); self.assertIn('task action', final(lines))
        (self.r / 'stage/new/host.mjs').write_bytes(b'tampered'); lines, c = run(self.r, params(self.r, 'x8')); self.assertIn('staged host.mjs', final(lines))
        self.assertEqual((stops(self.r), pair(self.r)), (0, OLDP))
    def test_a_run_id_runs_once_and_a_wrong_params_sha_exits_4(self):
        lines, c = run(self.r, params(self.r, 'l1')); self.ok(lines, c, 'DONE:')
        lines, c = run(self.r, params(self.r, 'l1')); self.assertIn('already ran', lines[-1]['decision'])
        pf = self.r / 'stage/p.json'; pf.write_text(json.dumps(params(self.r, 'l2')))
        c = subprocess.run([PWSH, '-NoProfile', '-File', str(T / 'pair-mock.ps1'), '-Script', str(SCRIPT), '-Root', str(self.r), '-ParamsFile', str(pf), '-ParamsSha', '0' * 64], capture_output=True, text=True, timeout=60)
        self.assertEqual(c.returncode, 4)
    def test_post_checks_report_check_not_done(self):
        for sc in ('vm-replaced', 'other-task-changed'):
            r = world(); lines, c = run(r, params(r, 'v-' + sc), scenario=sc); self.ok(lines, c, 'DONE_CHECK'); shutil.rmtree(r, ignore_errors=True)

if __name__ == '__main__':
    unittest.main()
