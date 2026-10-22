#!/usr/bin/env python3
"""Focused scenario tests of helper/node-pair-activate.ps1 under tools/pair-mock.ps1 on Linux pwsh 7. The two module swaps run
the REAL pinned bundle-swap.ps1 (21d85c69) in real child pwsh processes on real files. Proves the DECISIONS (M1/M2 split, honest
finals, restart-sized reserve, stopped-node CAS, partial/unknown swap outcomes, ownership, no VM/manager/privacy change) - NOT
native Windows behaviour (Task Scheduler, CIM, ACLs, timings). The world/params/run helpers are 656d's pair-test.py's."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; H = T.parent
PWSH = os.environ.get('PWSH', str(H.parent.parent / 'node-hold-package-20261021/tools/pwsh/pwsh'))
SCRIPT = pathlib.Path(os.environ.get('ACT_SCRIPT') or H / 'helper/node-pair-activate.ps1')   # ACT_SCRIPT: mutants only
SWAP = H.parent.parent / 'cron-startup-20261021/respawn-activation/bundle-swap.ps1'
NODE = shutil.which('node')
RUNNER = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'
IDS = ['0x' + c * 64 for c in 'ab']
sha = lambda b: hashlib.sha256(b).hexdigest()
CLOCK0 = int(datetime.datetime(2026, 10, 22, 22, 30, 0, tzinfo=datetime.timezone.utc).timestamp())
START = '2026-10-22T03:37:27.6506510Z'; SCHED_START = '2026-10-20T08:00:01.1000000Z'
OLD = {'chain.mjs': b'export const chain = 1;\n', 'host.mjs': b'export const host = 1;\n'}
NEW = {'chain.mjs': b'export const chain = 2; // permission gate\n', 'host.mjs': b'export const host = 2; // renewal keeper\n'}
assert sha(SWAP.read_bytes()) == '21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103'
# INITIAL.md row 1: U 120, S 660, P 60, M 120 -> F = 135 + 100 + 120 + 660 = 1015, R = 60 + 135 + 100 + 120 = 415; needs 1550
APPLY = {'marginSec': 120, 'revertSec': 415, 'forwardMinSec': 1015, 'startNodeSec': 660, 'processUpSec': 120, 'returnPinsSec': 60}
# a rollback: F = 135 + 100 + 120 = 355, R = 0; needs 475
BACK = {'marginSec': 120, 'revertSec': 0, 'forwardMinSec': 355, 'startNodeSec': 660, 'processUpSec': 120}

def world(lease_offset=1790):
    base = H / 'tmp'; base.mkdir(exist_ok=True)
    r = pathlib.Path(tempfile.mkdtemp(prefix='act-', dir=base))
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

def params(r, run, node=None, lease=None, mode='apply', **over):
    st = str(r / 'stage')
    files = [{'name': n, 'target': tgt(r, n), 'oldSha': sha(OLD[n]), 'newSha': sha(NEW[n]), 'newFile': f'{st}/new/{n}', 'workDir': f"{st}/swap-{n.split('.')[0]}"} for n in ('host.mjs', 'chain.mjs')]
    p = {'stage': st, 'runId': run, 'boundSec': 1140, 'runner': RUNNER, 'testRoot': str(r), 'testNode': NODE, 'testPrelude': str(T / 'swap-prelude.ps1'),
         'bundleSwap': {'path': f'{st}/bundle-swap.ps1', 'sha': sha(SWAP.read_bytes())}, 'files': files,
         'unchangedFiles': [{'path': str(r / 'run-node.cmd'), 'sha': sha((r / 'run-node.cmd').read_bytes())}, {'path': str(r / 'node-config.local.cmd'), 'sha': sha((r / 'node-config.local.cmd').read_bytes())}],
         'task': {'execute': 'cmd.exe', 'arguments': r'/c "C:\ProgramData\Enclave\run-node.cmd"'},
         'node': node or {'cmdPid': 23976, 'cmdStart': START, 'agentPid': 8644, 'agentStart': START},
         'scheduler': {'pid': 3292, 'start': SCHED_START, 'name': 'svchost.exe', 'commandLike': '*-s Schedule*'},
         'manager': '4001@2026-10-21T12:13:07.5552110Z', 'privacy': {'pid': 13932, 'start': '2026-10-22T03:37:14.0971470Z'},
         'vms': vms_string(r), 'hyperv': hv_string(r), 'expectedIds': IDS, 'lease': dict(APPLY if mode == 'apply' else BACK, **(lease or {}))}
    p.update(over)
    return p

def run(r, p, mode='apply', scenario='ok', timeout=300):
    pf = r / 'stage' / f"params-{p['runId']}-{mode}.json"; pf.write_text(json.dumps(p)); ps = sha(pf.read_bytes())
    c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / 'pair-mock.ps1'), '-Script', str(SCRIPT), '-Root', str(r), '-ParamsFile', str(pf),
                        '-ParamsSha', ps, '-Mode', mode, '-Scenario', scenario], capture_output=True, text=True, timeout=timeout)
    j = r / 'stage' / f"pair-{p['runId']}.jsonl"
    lines = [json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []
    return lines, c
def final(lines): return next((l['final'] for l in reversed(lines) if 'final' in l), '') or ''
def step(lines, name): return next(l for l in lines if l.get('step') == name)
def events(r): return (r / 'node-events.txt').read_text().split('\n') if (r / 'node-events.txt').exists() else []
def starts(r): return sum(1 for e in events(r) if e.startswith('start'))
def stops(r): return sum(1 for e in events(r) if e.startswith('stop'))
def kills(r): return [e for e in events(r) if e.startswith('kill')]
def pair(r): return tuple(sha((r / 'control/windows/node' / n).read_bytes()) for n in ('chain.mjs', 'host.mjs'))
OLDP = (sha(OLD['chain.mjs']), sha(OLD['host.mjs'])); NEWP = (sha(NEW['chain.mjs']), sha(NEW['host.mjs']))
def journal(r, n): f = r / f"stage/swap-{n}/.bundle-swap/journal.json"; return json.loads(f.read_text())['state'] if f.exists() else 'absent'
def started_node(lines):
    a = step(lines, 'start-node'); return {'cmdPid': a['cmd']['pid'], 'cmdStart': a['cmd']['start'], 'agentPid': a['agent']['pid'], 'agentStart': a['agent']['start']}

class Activate(unittest.TestCase):
    def setUp(self): self.r = world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def ok(self, lines, c, prefix): self.assertTrue(final(lines).startswith(prefix), (final(lines), [l.get('recovery') for l in lines if l.get('recovery')], c.stdout[-600:], c.stderr[-900:]))
    def fresh(self, off=1790): r = world(off); self.addCleanup(shutil.rmtree, r, True); return r

    # ---- M1 + M2: the forward window
    def test_apply_restarts_then_serves_with_the_pass_still_in_flight(self):
        lines, c = run(self.r, params(self.r, 'a1')); self.ok(lines, c, 'DONE:')
        self.assertIn('Not activation-complete until the new process renews a lease', final(lines))
        self.assertEqual(pair(self.r), NEWP); self.assertEqual((stops(self.r), starts(self.r)), (1, 1)); self.assertEqual(kills(self.r), [])
        self.assertEqual((journal(self.r, 'chain'), journal(self.r, 'host')), ('done', 'done'))
        self.assertEqual([(s['detail']['file'], s['detail']['result']) for s in lines if s.get('step') == 'swap'], [('chain.mjs', 'done'), ('host.mjs', 'done')], 'callee first')
        pins = step(lines, 'pins'); self.assertEqual(pins['reserve'], 'restart'); self.assertEqual([i['decision'] for i in pins['inspect']], ['would apply', 'would apply'])
        self.assertEqual(pins['lease']['rollbackBy'], CLOCK0 + 1790 - 120 - 415)
        self.assertEqual(step(lines, 'start-node')['milestone'], 'M1 restarted'); self.assertNotEqual(step(lines, 'start-node')['agent']['pid'], 8644)
        sv = step(lines, 'serving'); self.assertEqual(sv['result'], 'serving')
        self.assertIs(sv['evidence']['inFlight'], True, 'accepted mid-pass: the completed pass is not awaited')
        self.assertEqual(sv['evidence']['rows'], {IDS[0]: 'ready', IDS[1]: 'ready'})
        post = step(lines, 'post'); self.assertTrue(all(post[k] for k in ('identityUnchanged', 'privacyUnchanged', 'schedulerUnchanged', 'pairUnchanged', 'unchangedFiles')))
        self.assertTrue(post['hypervUnchanged'] and post['managerVmsUnchanged'] and post['managerUnchanged'] and post['othersUnchanged'], 'no VM/manager/task touched')
    def test_a_slow_sweep_is_not_awaited_once_every_expected_row_is_ready(self):
        lines, c = run(self.r, params(self.r, 'a2'), scenario='sweep-midpass'); self.ok(lines, c, 'DONE:')
        ev = step(lines, 'serving')['evidence']; self.assertIs(ev['inFlight'], True); self.assertEqual(set(ev['rows'].values()), {'ready'})

    # ---- honest state: M1 without M2 is reported, never DONE; nothing is stopped, retried or rolled back automatically
    def test_restarted_but_not_serving_is_a_check_with_the_rows_and_rollbackBy(self):
        lines, c = run(self.r, params(self.r, 'h1'), scenario='row-pending'); self.ok(lines, c, 'DONE_NOT_SERVING_CHECK:')
        self.assertIn('root decides by rollbackBy', final(lines))
        post = step(lines, 'post'); self.assertEqual(post['serving'], 'not-yet'); self.assertEqual(post['rollbackBy'], CLOCK0 + 1790 - 535)
        self.assertEqual(post['evidence']['rows'], {IDS[0]: 'ready', IDS[1]: 'status pending'})
        self.assertEqual((stops(self.r), starts(self.r), kills(self.r), pair(self.r)), (1, 1, [], NEWP), 'the new node keeps running; nothing automatic')
        self.assertTrue(post['identityUnchanged'] and post['privacyUnchanged'])
        # the observation ended at the bound (S = 660 s after M1), not earlier and not on the completed pass
        t1 = datetime.datetime.fromisoformat(step(lines, 'start-node')['at'].replace('Z', '+00:00')); t2 = datetime.datetime.fromisoformat(step(lines, 'serving')['at'].replace('Z', '+00:00'))
        self.assertGreaterEqual((t2 - t1).total_seconds(), 655); self.assertLessEqual((t2 - t1).total_seconds(), 665)
    def test_rows_that_do_not_prove_serving_are_never_accepted(self):
        for sc, why in (('row-not-ready', 'status not-ready'), ('row-old-sequence', 'a row of another pass'), ('row-lease-mismatch', 'host-state record not running or another lease'),
                        ('row-other-runner', 'another runner')):
            r = self.fresh(); lines, c = run(r, params(r, 'h-' + sc), scenario=sc); self.ok(lines, c, 'DONE_NOT_SERVING_CHECK:')
            self.assertEqual(step(lines, 'post')['evidence']['rows'][IDS[0]], why, sc); self.assertEqual((starts(r), stops(r)), (1, 1), sc)
    def test_a_lease_inside_the_margin_is_not_serving(self):
        # after the restart the host-state lease reads now + 60 s (row and record agree): inside margin 120, never accepted
        lines, c = run(self.r, params(self.r, 'm1'), scenario='lease-shrinks-after-start'); self.ok(lines, c, 'DONE_NOT_SERVING_CHECK:')
        self.assertEqual(set(step(lines, 'post')['evidence']['rows'].values()), {'lease within the margin'})

    # ---- M1 failures and the lost listener: NOT_READY, one start, no retry, no stop, no swap
    def test_no_m1_ends_not_ready_without_retry(self):
        for sc, word in (('stale-readiness', 'M1'), ('no-pass-loop', 'M1'), ('foreign-9600', 'M1'), ('foreign-parent', 'pinned Task Scheduler')):
            r = self.fresh(); lines, c = run(r, params(r, 'n-' + sc), scenario=sc); self.ok(lines, c, 'NOT_READY')
            self.assertIn(word, next(l for l in lines if 'recovery' in l)['recovery'], sc)
            self.assertEqual((starts(r), stops(r), kills(r), pair(r)), (1, 1, [], NEWP), sc)
    def test_a_listener_lost_after_m1_is_not_ready(self):
        lines, c = run(self.r, params(self.r, 'n-lost'), scenario='listener-lost'); self.ok(lines, c, 'NOT_READY')
        rec = next(l for l in lines if 'recovery' in l); self.assertIn('restarted (M1)', rec['recovery']); self.assertIn('rollbackBy', rec)
        self.assertEqual(step(lines, 'serving')['result'], 'lost'); self.assertEqual((starts(self.r), stops(self.r)), (1, 1))

    # ---- stopped-node CAS, partial and unknown outcomes (656d's reused functions under the new flow)
    def test_a_module_or_config_changed_while_stopped_writes_nothing_and_does_not_start(self):
        for sc in ('module-changed-while-stopped', 'config-changed-while-stopped'):
            r = self.fresh(); lines, c = run(r, params(r, 'c-' + sc), scenario=sc); self.ok(lines, c, 'RECOVERY_REQUIRED')
            self.assertEqual((starts(r), journal(r, 'chain'), journal(r, 'host')), (0, 'absent', 'absent'), sc)
    def test_a_stale_listener_after_the_stop_writes_nothing_and_does_not_start(self):
        lines, c = run(self.r, params(self.r, 'c3'), scenario='stale-listener'); self.ok(lines, c, 'RECOVERY_REQUIRED'); self.assertEqual((pair(self.r), starts(self.r)), (OLDP, 0))
    def test_second_file_refused_conclusively_undoes_the_first_and_restarts_the_old_pair(self):
        lines, c = run(self.r, params(self.r, 'p1'), scenario='host-staged-changed'); self.ok(lines, c, 'SWAP_REFUSED_OLD_PAIR_RESTARTED:')
        self.assertEqual(pair(self.r), OLDP); self.assertEqual(starts(self.r), 1)
        self.assertEqual([(l['detail']['file'], l['detail']['op'], l['detail']['result']) for l in lines if l.get('step') in ('swap', 'undo')],
                         [('chain.mjs', 'apply', 'done'), ('host.mjs', 'apply', 'unchanged'), ('chain.mjs', 'rollback', 'done')])
    def test_unknown_swap_or_undo_outcomes_never_start(self):
        for sc, pr in (('host-hang', (NEWP[0], OLDP[1])), ('host-staged-changed-undo-hangs', None), ('host-crash-after-replace', NEWP), ('chain-acl-mismatch', None)):
            r = self.fresh(); lines, c = run(r, params(r, 'u-' + sc), scenario=sc); self.ok(lines, c, 'RECOVERY_REQUIRED')
            self.assertEqual(starts(r), 0, sc)
            if pr: self.assertEqual(pair(r), pr, sc)
    def test_task_outcome_failures_are_never_retried(self):
        lines, c = run(self.r, params(self.r, 't1'), scenario='throw-after-task-stop'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual((pair(self.r), starts(self.r), stops(self.r)), (OLDP, 0, 1))
        r = self.fresh(); lines, c = run(r, params(r, 't2'), scenario='throw-after-task-start'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual((starts(r), stops(r)), (1, 1), 'one start, no retry')

    # ---- ownership
    def test_ownership_kill_only_the_verified_pid_and_a_reused_pid_is_a_new_identity(self):
        lines, c = run(self.r, params(self.r, 'o1'), scenario='agent-unkillable'); self.ok(lines, c, 'RECOVERY_REQUIRED')
        self.assertEqual(kills(self.r), ['kill 8644']); self.assertEqual((pair(self.r), starts(self.r)), (OLDP, 0))
        r = self.fresh(); lines, c = run(r, params(r, 'o2'), scenario='pid-reuse'); self.ok(lines, c, 'DONE:')
        a = step(lines, 'start-node')['agent']; self.assertEqual(a['pid'], 8644); self.assertNotEqual(a['start'], START)
    def test_post_checks_catch_a_replaced_vm_or_another_task(self):
        for sc in ('vm-replaced', 'other-task-changed'):
            r = self.fresh(); lines, c = run(r, params(r, 'v-' + sc), scenario=sc); self.ok(lines, c, 'DONE_CHECK:')
    def test_the_running_set_is_still_exact_immediately_before_the_stop(self):
        lines, c = run(self.r, params(self.r, 'rs'), scenario='running-added-before-stop')
        self.assertTrue(final(lines).startswith('REFUSED') and 'running but not expected' in final(lines), final(lines)); self.assertEqual(stops(self.r), 0)

    # ---- the budget: restart-sized reserve, never 0 for apply; zero-rate leases fit
    def test_apply_needs_forward_plus_one_restart_reserve_plus_margin(self):
        for off, ok in ((1550, True), (1549, False), (1800, True)):
            r = self.fresh(off); lines, c = run(r, params(r, f'z-{off}'))
            self.assertEqual(final(lines).startswith('DONE:'), ok, (off, final(lines)))
            if not ok: self.assertIn('lease deadline', final(lines)); self.assertEqual(stops(r), 0)
    def test_a_lease_shrinking_before_the_stop_refuses_at_beforestop(self):
        lines, c = run(self.r, params(self.r, 'ls'), scenario='lease-shrinks-before-stop')
        self.assertIn('immediately before stop', final(lines)); self.assertTrue(any(l.get('step') == 'pins' for l in lines), 'passed the pins; refused at the later layer')
        self.assertEqual((stops(self.r), pair(self.r)), (0, OLDP))
    def test_budget_params_refused_before_anything(self):
        cases = [({'revertSec': 0}, 'ONE rollback run'), ({'revertSec': 414}, 'ONE rollback run'), ({'returnPinsSec': 0}, 'ONE rollback run'),
                 ({'startNodeSec': 602, 'forwardMinSec': 957}, 'measured completed pass'), ({'processUpSec': 30, 'forwardMinSec': 925, 'revertSec': 325}, 'two 30-s ticks'),
                 ({'forwardMinSec': 1014}, 'forwardMinSec must cover'), ({'reserve': 'full-return'}, 'not a key of this variant'), ({'marginSec': 0}, 'marginSec must be positive'),
                 ({'processUpSec': None}, 'missing or not integers')]
        for lease, word in cases:
            r = self.fresh(); lines, c = run(r, params(r, 'b', lease=lease)); self.assertIn(word, final(lines), lease); self.assertEqual(stops(r), 0, lease)
        r = self.fresh(); lines, c = run(r, params(r, 'b2', boundSec=1500)); self.assertIn('boundSec above', final(lines))
    def test_updater_due_inside_the_bound_plus_the_reserve_refuses(self):
        for sc in ('update-due', 'update-in-reserve', 'update-queued-before-stop'):
            r = self.fresh(); lines, c = run(r, params(r, 'up-' + sc), scenario=sc)
            self.assertTrue(final(lines).startswith('REFUSED'), (sc, final(lines))); self.assertEqual(stops(r), 0, sc)

    # ---- the rollback: R = 0, acceptance M1, M2 observed
    def applied(self, scenario='ok'):
        lines, c = run(self.r, params(self.r, 'ta'), scenario=scenario)
        self.assertTrue(final(lines).startswith('DONE'), final(lines)); return started_node(lines)
    def test_rollback_returns_the_old_pair_and_needs_only_a_restart(self):
        node = self.applied(); leases(self.r, 474)
        lines, c = run(self.r, params(self.r, 'r474', node=node, mode='rollback'), mode='rollback'); self.assertIn('lease deadline', final(lines)); self.assertEqual(stops(self.r), 1)
        leases(self.r, 475)
        lines, c = run(self.r, params(self.r, 'r475', node=node, mode='rollback'), mode='rollback'); self.ok(lines, c, 'ROLLED_BACK:')
        self.assertEqual((pair(self.r), stops(self.r), starts(self.r)), (OLDP, 2, 2))
        self.assertEqual([(l['detail']['file'], l['detail']['op']) for l in lines if l.get('step') == 'swap'], [('host.mjs', 'rollback'), ('chain.mjs', 'rollback')], 'reverse order')
        self.assertNotIn('rollbackBy', step(lines, 'post'))
    def test_rollback_reserves_nothing_after_itself(self):
        node = self.applied()
        lines, c = run(self.r, params(self.r, 'rr', node=node, mode='rollback', lease={'revertSec': 60}), mode='rollback'); self.assertIn('must be 0', final(lines))
        self.assertEqual(stops(self.r), 1)
    def test_rollback_from_a_running_new_node_that_was_not_yet_serving(self):
        node = self.applied('row-pending')
        lines, c = run(self.r, params(self.r, 'rp', node=node, mode='rollback'), mode='rollback'); self.ok(lines, c, 'ROLLED_BACK:')
        self.assertEqual((pair(self.r), stops(self.r), starts(self.r)), (OLDP, 2, 2))
    def test_a_rollback_whose_old_node_is_not_yet_serving_says_so(self):
        node = self.applied()
        lines, c = run(self.r, params(self.r, 'rn', node=node, mode='rollback'), mode='rollback', scenario='row-pending'); self.ok(lines, c, 'ROLLED_BACK_NOT_SERVING_CHECK:')
        self.assertNotIn('rollbackBy', final(lines)); self.assertEqual(pair(self.r), OLDP)
    def test_a_partial_return_refused_conclusively_restarts_the_new_pair(self):
        node = self.applied()
        lines, c = run(self.r, params(self.r, 'r3', node=node, mode='rollback'), mode='rollback', scenario='rollback-chain-backup-gone')
        self.ok(lines, c, 'RETURN_REFUSED_NEW_PAIR_RESTARTED:'); self.assertEqual(pair(self.r), NEWP)

    # ---- run id lock and params sha
    def test_a_run_id_runs_once_and_a_wrong_params_sha_exits_4(self):
        lines, c = run(self.r, params(self.r, 'l1')); self.ok(lines, c, 'DONE:')
        lines, c = run(self.r, params(self.r, 'l1')); self.assertIn('already ran', lines[-1]['decision'])
        pf = self.r / 'stage/p.json'; pf.write_text(json.dumps(params(self.r, 'l2')))
        c = subprocess.run([PWSH, '-NoProfile', '-File', str(T / 'pair-mock.ps1'), '-Script', str(SCRIPT), '-Root', str(self.r), '-ParamsFile', str(pf), '-ParamsSha', '0' * 64], capture_output=True, text=True, timeout=60)
        self.assertEqual(c.returncode, 4)

if __name__ == '__main__':
    unittest.main()
