"""Unit tests for the recovery canary harness: no QEMU, no ports, no hardware, no real state."""
import copy, hashlib, json, os, pathlib, signal, sys, tempfile, unittest
from types import SimpleNamespace

HARNESS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HARNESS / 'canary'))
import recovery_canary as rc  # noqa: E402

FIXTURE = HARNESS / 'tests/fixtures/host-a5eae96c.mjs'
HOST_SHA = 'c2923901a78f6253aa405ef051246211f97e63d8e9ea0267b00e9a836b80090f'  # a5eae96c custody/v2/host.mjs
COPY_SHA = '93c4030573aad84d826f8f5b62c0cc575d0266f65e8c59a9ee040b95b41893d1'  # its canary copy
INJECT = (HARNESS / 'canary/fault-inject.mjs.txt').read_text()
MEAS = 'e0' * 48


def sha(b): return hashlib.sha256(b).hexdigest()


class Transform(unittest.TestCase):
    def setUp(self): self.src = FIXTURE.read_bytes()

    def test_fixture_is_the_pinned_source(self):
        self.assertEqual(sha(self.src), HOST_SHA)

    def test_exactly_one_insertion_before_the_get_line(self):
        out = rc.transform_host(self.src, HOST_SHA, INJECT).decode()
        self.assertEqual(sha(out.encode()), COPY_SHA)
        self.assertEqual(out.count(rc.MARKER), 1)
        self.assertEqual(out.replace(INJECT, '', 1), self.src.decode())
        self.assertIn('  try {\n' + INJECT + rc.ANCHOR_GET, out)
        self.assertEqual(out.count('canaryStateFault'), 1)
        self.assertEqual(out.count('/state" && req.method === "PUT"'), 1)  # the PUT path is untouched

    def test_wrong_source_hash_refuses(self):
        with self.assertRaisesRegex(rc.CanaryError, 'not the pinned source'):
            rc.transform_host(self.src + b'\n', HOST_SHA, INJECT)
        with self.assertRaisesRegex(rc.CanaryError, '64 lowercase hex'):
            rc.transform_host(self.src, HOST_SHA.upper(), INJECT)

    def _refuses(self, src, msg):
        with self.assertRaisesRegex(rc.CanaryError, msg): rc.transform_host(src, sha(src), INJECT)

    def test_anchor_missing_twice_or_restructured_refuses(self):
        s = self.src.decode()
        self._refuses(s.replace(rc.ANCHOR_GET, rc.ANCHOR_GET.replace('send(404', 'send( 404')).encode(), 'exactly once')
        self._refuses((s + rc.ANCHOR_GET).encode(), 'exactly once')
        self._refuses(s.replace('  try {\n    if (req.url === "/state"', '  try  {\n    if (req.url === "/state"').encode(), 'exactly once')
        self._refuses(s.replace(rc.ANCHOR_HEAD, rc.ANCHOR_HEAD + '\n').encode(), 'exactly once')

    def test_existing_canary_lines_and_bad_inject_refuse(self):
        self._refuses((self.src.decode() + '// cfg.canaryStateFault\n').encode(), 'already carries')
        with self.assertRaisesRegex(rc.CanaryError, 'inject lines malformed'):
            rc.transform_host(self.src, HOST_SHA, INJECT.rstrip('\n'))
        with self.assertRaisesRegex(rc.CanaryError, 'inject lines malformed'):
            rc.transform_host(self.src, HOST_SHA, INJECT + INJECT)
        self._refuses(b'\xff' + self.src, 'not UTF-8')


class Paths(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
        os.chmod(self.tmp, 0o700)

    def tearDown(self):
        import shutil; shutil.rmtree(self.tmp)

    def test_fresh_dir_refuses_existing_and_forces_0700(self):
        old = os.umask(0o777)  # mkdir then yields 000; the forced chmod must still give 0700
        try: d = rc.fresh_dir(self.tmp / 'a')
        finally: os.umask(old)
        self.assertEqual(oct(os.lstat(d).st_mode & 0o777), '0o700')
        with self.assertRaises(FileExistsError): rc.fresh_dir(self.tmp / 'a')

    def test_guard_dir_refuses_symlink_mode_and_file(self):
        real = rc.fresh_dir(self.tmp / 'real')
        (self.tmp / 'link').symlink_to(real)
        with self.assertRaisesRegex(rc.CanaryError, 'not a real directory'): rc.guard_dir(self.tmp / 'link')
        sub = rc.fresh_dir(real / 'sub')
        with self.assertRaisesRegex(rc.CanaryError, 'symlink component'): rc.guard_dir(self.tmp / 'link' / 'sub')
        os.chmod(sub, 0o755)
        with self.assertRaisesRegex(rc.CanaryError, 'mode'): rc.guard_dir(sub)
        (self.tmp / 'f').write_text('x')
        with self.assertRaisesRegex(rc.CanaryError, 'not a real directory'): rc.guard_dir(self.tmp / 'f')

    def test_guard_run_requires_runs_child_with_stamp_name(self):
        runs = rc.fresh_dir(self.tmp / 'runs')
        ok = rc.fresh_dir(runs / '20261023T200000Z')
        self.assertEqual(rc.guard_run(ok, runs), ok)
        for bad in (rc.fresh_dir(runs / 'x'), rc.fresh_dir(self.tmp / '20261023T200001Z')):
            with self.assertRaisesRegex(rc.CanaryError, 'not a canary run directory'): rc.guard_run(bad, runs)

    def test_snapshot_refuses_symlinks_and_reports_metadata_only(self):
        st = rc.fresh_dir(self.tmp / 'state')
        fd = os.open(st / 'state.bin', os.O_CREAT | os.O_WRONLY, 0o600); os.write(fd, b'sealed-bytes'); os.close(fd)
        snap = rc.snapshot_state(st)
        self.assertEqual(snap, {'state.bin': dict(mode='0o600', size=12, sha256=sha(b'sealed-bytes'))})
        (st / 'state.bin.1').symlink_to('/etc/hostname')
        with self.assertRaisesRegex(rc.CanaryError, 'not a regular file'): rc.snapshot_state(st)


def P(pid, ppid, pgid, start, comm='node', state='S'):
    return dict(pid=pid, ppid=ppid, pgid=pgid, starttime=start, comm=comm, state=state)


class Processes(unittest.TestCase):
    def test_proc_stat_parses_comm_with_spaces_and_parens(self):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / '42').mkdir()
        fields = ['S', '7', '42', '42'] + ['0'] * 15 + ['123456']
        (d / '42/stat').write_text('42 (qemu (x) y) ' + ' '.join(fields) + ' 0 0\n')
        st = rc.proc_stat(42, d)
        self.assertEqual((st['comm'], st['ppid'], st['pgid'], st['starttime']), ('qemu (x) y', 7, 42, 123456))

    def test_descendants_require_root_identity(self):
        procs = [P(10, 1, 10, 100), P(11, 10, 10, 101, 'qemu-system-x86'), P(12, 11, 10, 102), P(20, 1, 20, 50)]
        self.assertEqual(rc.descendants((10, 100), procs), {(10, 100), (11, 101), (12, 102)})
        self.assertEqual(rc.descendants((10, 999), procs), set())  # a reused pid is not the launcher

    def _stop(self, tables, owned, pgid=10):
        calls, t = [], [0.0]
        it = iter(tables)
        cur = [next(it)]
        def procs(): return cur[0]
        def killpg(g, s):
            calls.append((g, s))
            try: cur[0] = next(it)
            except StopIteration: pass
        def mono(): t[0] += 1; return t[0]
        ev = rc.stop_group(pgid, owned, procs=procs, killpg=killpg, reap=lambda: None, monotonic=mono, sleep=lambda s: None)
        return calls, ev

    def test_stop_signals_only_while_an_owned_member_is_alive(self):
        owned = {(10, 100), (11, 101)}
        alive = [P(10, 1, 10, 100), P(11, 10, 10, 101, 'qemu-system-x86')]
        calls, ev = self._stop([alive, []], owned)
        self.assertEqual(calls, [(10, signal.SIGTERM)]); self.assertTrue(ev['groupEmpty'])
        calls, ev = self._stop([alive, [alive[1]], []], owned)
        self.assertEqual(calls, [(10, signal.SIGTERM), (10, signal.SIGKILL)]); self.assertTrue(ev['groupEmpty'])

    def test_stop_never_signals_a_group_without_an_owned_live_member(self):
        foreign = [P(10, 1, 10, 555), P(11, 1, 10, 556)]  # pid/pgid reused by someone else
        calls, ev = self._stop([foreign], {(10, 100)})
        self.assertEqual(calls, []); self.assertFalse(ev['groupEmpty'])
        zombie = [P(10, 1, 10, 100, state='Z')]
        calls, ev = self._stop([zombie], {(10, 100)})
        self.assertEqual(calls, [])
        other_group = [P(30, 1, 30, 100)]
        calls, ev = self._stop([other_group], {(30, 100)})
        self.assertEqual(calls, []); self.assertTrue(ev['groupEmpty'])

    def test_cgroup_extra_allows_only_self_and_in_scope_ancestors(self):
        procs = [P(5, 1, 5, 1, 'node'), P(6, 5, 6, 2, 'timeout'), P(7, 6, 6, 3, 'python3'), P(9, 1, 9, 4, 'qemu-system-x86'), P(4, 1, 4, 0, 'systemd')]
        self.assertEqual(rc.cgroup_extra(7, {5, 6, 7}, procs), [])
        self.assertEqual(rc.cgroup_extra(7, {5, 6, 7, 9}, procs), [9])

    def test_listening_ports(self):
        tcp = ('  sl  local_address rem_address   st\n'
               '   0: 0100007F:4A1A 00000000:0000 0A 0\n'      # 18970 LISTEN
               '   1: 0100007F:4A1B 0100007F:9C40 01 0\n')     # 18971 ESTABLISHED only
        tcp6 = '  sl  local_address\n   0: 00000000000000000000000001000000:4A1C 0000:0000 0A 0\n'
        self.assertEqual(rc.listening_ports([tcp, tcp6]), {18970, 18972})

    def test_qemus_maps_pid_to_starttime(self):
        self.assertEqual(rc.qemus([P(9, 1, 9, 4, 'qemu-system-x86'), P(5, 1, 5, 1)]), {'9': '4'})


def events(*rows):
    out = []
    for method, url, status in rows:
        out.append(dict(ev='req', at='t', method=method, url=url))
        if status is not None: out.append(dict(ev='res', at='t', method=method, url=url, status=status, finished=True))
    return '\n'.join(json.dumps(e) for e in out) + '\n'


class Events(unittest.TestCase):
    def test_parse_and_summarize(self):
        s = rc.summarize_events(rc.parse_events(events(('GET', '/state', 404), ('PUT', '/state', 200), ('GET', '/receipts', 200))))
        self.assertEqual((s['stateGet404'], s['statePut200'], s['stateWriteRequests'], s['otherRequests']), (1, 1, 1, ['GET /receipts']))
        s = rc.summarize_events(rc.parse_events(events(('DELETE', '/state', 404))))
        self.assertEqual(s['stateWriteRequests'], 1)  # any non-GET /state counts as a write attempt

    def test_partial_or_malformed_lines(self):
        text = events(('GET', '/state', 503))
        self.assertEqual(len(rc.parse_events(text + '{"ev":"r')), 2)  # a line being written is ignored while running
        with self.assertRaisesRegex(rc.CanaryError, 'partial'): rc.parse_events(text + '{"ev":"r', final=True)
        with self.assertRaises(rc.CanaryError): rc.parse_events('{"ev":"res","method":"GET","url":"/state"}\n')
        with self.assertRaises(ValueError): rc.parse_events('not json\n')


INFO = dict(v=2, identity='0xaa', encKey='0xbb', hostSig=None, epochs=[], chainId=8453,
            machine=dict(identity='0xaa', encKey='0xbb', endpoint=rc.ENDPOINT, chipId='0xcc', registryId='0xdd', measurement='0xee'))
STATE = {'fwcfg.json': dict(mode='0o600', size=9, sha256='1' * 64), 'state.bin': dict(mode='0o600', size=99, sha256='2' * 64)}


def verdict(nonce, info=INFO):
    return dict(ok=True, reasons=[], nonce=nonce, observed=dict(measurement=MEAS, machine=copy.deepcopy(info['machine'])))


def boundary(**kw):
    return dict(dict(stop=dict(groupEmpty=True), portsAfter=[], cgroupExtraAfter=[], protectedUnchanged=True, pinsOk=True,
                     portsBefore=[], cgroupExtraBefore=[]), **kw)


def fresh_phase():
    return boundary(stateBefore={}, stateAfter=copy.deepcopy(STATE), stateDirMode='0o700', info=copy.deepcopy(INFO), verifierExit=0,
                    verdict=verdict('1' * 64), serial='... new custodian identity sealed ... custodian-v2 on :8787',
                    events=rc.summarize_events(rc.parse_events(events(('GET', '/state', 404), ('PUT', '/state', 200)))))


def saved():
    return dict(stateFiles=rc.sealed_files(STATE), identity=rc.public_identity(INFO), nonce='1' * 64)


def fault_phase():
    return boundary(stateBefore=copy.deepcopy(STATE), stateAfter=copy.deepcopy(STATE), mgmtResponses=[], mgmtProbes=30, heldS=45.2,
                    launcherExit=None, serial='FATAL Error: sealed state read failed: HTTP 503 ... custodian exited code=1',
                    events=rc.summarize_events(rc.parse_events(events(('GET', '/state', 503), ('GET', '/state', 503)))))


def reopen_phase():
    return boundary(stateBefore=copy.deepcopy(STATE), stateAfter=copy.deepcopy(STATE), info=copy.deepcopy(INFO), verifierExit=0,
                    verdict=verdict('3' * 64), serial='sealed state opened ... custodian-v2 on :8787',
                    events=rc.summarize_events(rc.parse_events(events(('GET', '/state', 200)))))


class Verdicts(unittest.TestCase):
    def failed(self, r): return sorted(k for k, v in r.items() if not v)

    def test_happy_paths_pass_every_required_check(self):
        self.assertEqual(self.failed(rc.verdict_fresh(fresh_phase(), MEAS)), [])
        self.assertEqual(self.failed(rc.verdict_fault(fault_phase(), saved())), [])
        self.assertEqual(self.failed(rc.verdict_reopen(reopen_phase(), saved(), '1' * 64, MEAS)), [])

    def test_fresh_failures(self):
        p = fresh_phase(); p['stateBefore'] = {'state.bin': STATE['state.bin']}
        self.assertIn('fresh.stateAbsentAtLaunch', self.failed(rc.verdict_fresh(p, MEAS)))
        p = fresh_phase(); p['events'] = rc.summarize_events(rc.parse_events(events(('GET', '/state', 503), ('GET', '/state', 404), ('PUT', '/state', 200))))
        self.assertEqual(self.failed(rc.verdict_fresh(p, MEAS)), ['fresh.firstStateGet404', 'fresh.no503'])
        p = fresh_phase(); p['stateAfter']['state.bin']['mode'] = '0o644'
        self.assertEqual(self.failed(rc.verdict_fresh(p, MEAS)), ['fresh.stateModes'])
        p = fresh_phase(); p['verdict']['observed']['measurement'] = 'ff' * 48
        self.assertEqual(self.failed(rc.verdict_fresh(p, MEAS)), ['fresh.quote.measurementPinned'])
        p = fresh_phase(); p['info']['hostSig'] = '0x01'
        self.assertEqual(self.failed(rc.verdict_fresh(p, MEAS)), ['fresh.infoIsQuoteOnlyCanary'])

    def test_fault_failures(self):
        cases = {
            'fault.noStateWrite': lambda p: p.update(events=rc.summarize_events(rc.parse_events(events(('GET', '/state', 503), ('PUT', '/state', 400))))),
            'fault.everyStateGetAnswered503': lambda p: p.update(events=rc.summarize_events(rc.parse_events(events(('GET', '/state', 503), ('GET', '/state', 200))))),
            'fault.neverHttpReady': lambda p: p.update(mgmtResponses=[500]),
            'fault.sealedStateUnchanged': lambda p: p['stateAfter'].update({'state.bin.1761250000000': STATE['state.bin']}),
            'fault.serialRefusal': lambda p: p.update(serial='custodian exited code=1'),
            'fault.serialNoReplacement': lambda p: p.update(serial=p['serial'] + ' new custodian identity sealed'),
            'fault.launcherAliveThroughout': lambda p: p.update(launcherExit=1),
            'fault.heldForWindow': lambda p: p.update(heldS=10),
            'fault.stop.protectedQemusUnchanged': lambda p: p.update(protectedUnchanged=False),
            'fault.stop.groupEmpty': lambda p: p.update(stop=dict(groupEmpty=False)),
        }
        for name, mutate in cases.items():
            p = fault_phase(); mutate(p)
            self.assertIn(name, self.failed(rc.verdict_fault(p, saved())), name)
        p = fault_phase(); p['events'] = rc.summarize_events([])
        self.assertEqual(self.failed(rc.verdict_fault(p, saved())), ['fault.everyStateGetAnswered503', 'fault.observed503'])
        p = fault_phase(); p['stateAfter']['state.bin'] = dict(STATE['state.bin'], sha256='3' * 64)
        self.assertEqual(self.failed(rc.verdict_fault(p, saved())), ['fault.sealedStateUnchanged'])

    def test_reopen_failures(self):
        other = copy.deepcopy(INFO); other['identity'] = other['machine']['identity'] = '0x99'
        p = reopen_phase(); p['info'] = other; p['verdict'] = verdict('3' * 64, other)
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.sameIdentity', 'reopen.sameMachineRecord'])
        other = copy.deepcopy(INFO); other['encKey'] = other['machine']['encKey'] = '0x98'
        p = reopen_phase(); p['info'] = other; p['verdict'] = verdict('3' * 64, other)
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.sameEncKey', 'reopen.sameMachineRecord'])
        p = reopen_phase(); p['verdict']['observed']['machine']['encKey'] = '0x97'
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.quote.bindsServedMachine'])
        p = reopen_phase(); p['verdict']['nonce'] = '1' * 64
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.nonceDiffersFromFresh'])
        p = reopen_phase(); p['events'] = rc.summarize_events(rc.parse_events(events(('GET', '/state', 404), ('PUT', '/state', 200))))
        p['serial'] = 'new custodian identity sealed'
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.firstStateGet200', 'reopen.no404or503', 'reopen.serialOpened'])
        p = reopen_phase(); p['verifierExit'] = 1
        self.assertEqual(self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)), ['reopen.quote.verified'])
        p = reopen_phase(); p['info'] = None
        self.assertIn('reopen.httpReady', self.failed(rc.verdict_reopen(p, saved(), '1' * 64, MEAS)))


class Config(unittest.TestCase):
    def test_only_the_fault_phase_commands_a_fault_and_no_key_material_is_configured(self):
        base = rc.base_config(dict(vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5'), '/d')
        cfgs = {ph: rc.phase_config(base, ph, '/s', f'/e-{ph}') for ph in rc.PHASES}
        self.assertEqual([ph for ph, c in cfgs.items() if 'canaryStateFault' in c], ['fault'])
        self.assertEqual(cfgs['fault']['canaryStateFault'], 'get-503')
        strip = lambda c: {k: v for k, v in c.items() if k not in ('canaryStateFault', 'canaryEventLog')}
        self.assertTrue(strip(cfgs['fresh']) == strip(cfgs['fault']) == strip(cfgs['reopen']))
        for c in cfgs.values():
            self.assertFalse({'registryKeyFile', 'committeeId', 'vcekFile', 'receiptsFile', 'relayUrl', 'rpcs', 'qemu'} & set(c))
            self.assertIs(c['genesis'], False); self.assertEqual(c['memMiB'], 3072)
            self.assertEqual((c['hostPort'], c['mgmtPort']), (18970, 18971))
            self.assertTrue(c['endpoint'].endswith('.invalid'))
        self.assertNotIn('ENCLAVE_QUOTE_ONLY_NO_KEY', os.environ)
        with self.assertRaises(rc.CanaryError): rc.phase_config(base, 'other', '/s', '/e')
        with self.assertRaises(rc.CanaryError): rc.base_config(dict(vault='0xE48699B8401564AACE7A814AE4569B67A3F7EEF5'), '/d')

    def test_public_phase_keeps_selected_metadata_only(self):
        ev = fresh_phase(); ev['verdict']['observed'].update(hostData='0' * 64, policy='0x30000', vmpl=0, chipIdSha256='0x' + '4' * 64)
        out = rc.public_phase(ev)
        self.assertNotIn('serial', out)
        self.assertEqual(set(out['verdict']['observed']), {'measurement', 'hostData', 'policy', 'vmpl', 'chipIdSha256'})
        self.assertEqual(out['identity'], rc.public_identity(INFO))
        self.assertNotIn('report', json.dumps(out)); self.assertNotIn('auxblob', json.dumps(out))


class Pins(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
        self.dist, self.repo = self.tmp / 'dist', self.tmp / 'repo'
        (self.repo / 'custody/v2').mkdir(parents=True); self.dist.mkdir()
        (self.repo / 'custody/v2/host.mjs').write_bytes(FIXTURE.read_bytes())
        self.m = dict(role='enclave-custodian-v2', transport='direct', measurement=MEAS, commit='c' * 40, vault='0x' + '1' * 40)
        (self.dist / 'manifest.json').write_text(json.dumps(self.m))
        self.a = dict(dist=str(self.dist), repo=str(self.repo), expected_commit='c' * 40, expected_host_sha256=HOST_SHA, expected_copy_sha256=COPY_SHA,
                      expected_measurement=MEAS, expected_manifest_sha256=rc.sha256(self.dist / 'manifest.json'))

    def tearDown(self):
        import shutil; shutil.rmtree(self.tmp)

    def git(self, head='c' * 40, dirty='', blob=None):
        blob = FIXTURE.read_bytes() if blob is None else blob
        def run(cmd, **kw):
            out = {'rev-parse': head + '\n', 'status': dirty, 'show': blob}[cmd[3]]
            return SimpleNamespace(returncode=0, stdout=out)
        return run

    def test_all_pins_pass(self):
        self.assertEqual(rc.check_pins(self.a, git=self.git())['commit'], 'c' * 40)

    def test_each_pin_refuses(self):
        cases = [
            (dict(self.a, expected_manifest_sha256='0' * 64), {}, 'manifest sha256'),
            (dict(self.a, expected_measurement='ab' * 48), {}, 'measurement'),
            (dict(self.a, expected_commit='d' * 40), {}, 'manifest commit'),
            (self.a, dict(head='d' * 40), 'HEAD'),
            (self.a, dict(dirty=' M custody/v2/chain.mjs\n'), 'modified tracked'),
            (self.a, dict(blob=b'x'), 'committed host.mjs'),
            (dict(self.a, expected_host_sha256='zz'), {}, 'malformed'),
            (dict(self.a, expected_copy_sha256=COPY_SHA.upper()), {}, 'malformed'),
            (dict(self.a, dist='relative/dist'), {}, 'absolute'),
        ]
        for a, g, msg in cases:
            with self.assertRaisesRegex(rc.CanaryError, msg): rc.check_pins(a, git=self.git(**g))
        (self.repo / 'custody/v2/host.mjs').write_bytes(FIXTURE.read_bytes() + b'\n')
        with self.assertRaisesRegex(rc.CanaryError, 'on disk'): rc.check_pins(self.a, git=self.git())

    def test_reviewed_helpers_are_pinned_to_the_reviewed_files(self):
        self.assertEqual({p.name for p in rc.REVIEWED}, {'verify-custodian-quote.mjs', 'headroom-check.sh'})
        for p, want in rc.REVIEWED.items(): self.assertEqual(rc.sha256(p), want)


if __name__ == '__main__':
    unittest.main()
