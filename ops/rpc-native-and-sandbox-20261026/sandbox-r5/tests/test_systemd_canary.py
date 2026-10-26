"""bootstrap-systemd-canary-stage/r2: OFFLINE tests (no systemd, no guest, no network; run as uid 0 inside `unshare -Urn`).
Behavioural where a small fake can stand in: a FAKE ssh (the guest), a FAKE host /proc/meminfo, a FAKE systemctl on PATH.
Inputs (env, jobs/root-offline-tests.sh): CANARY_LIVE (captured `systemctl cat enclave-base-holder.service`), CANARY_DROPIN,
CANARY_REPROOF, CANARY_WRAPPER (the PROVISIONAL r13 files)."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, time, unittest
from unittest.mock import patch

S = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('canary_units', S / 'guest/canary_units.py'); CU = importlib.util.module_from_spec(spec); spec.loader.exec_module(CU)
ID = '20261026T090900Z-0123abcd'
cut = lambda t: t[:t.index('IPAddressDeny=10.0.2.2/32') + len('IPAddressDeny=10.0.2.2/32')] + '\n'
LIVE = cut(pathlib.Path(os.environ['CANARY_LIVE']).read_text())
DROPIN = pathlib.Path(os.environ['CANARY_DROPIN']).read_text(); REPROOF = pathlib.Path(os.environ['CANARY_REPROOF']).read_text()
WRAPPER = os.environ['CANARY_WRAPPER']; B = f'/run/enclave-sdcanary-{ID}/bundle'
GUEST = S / 'guest/systemd_canary.sh'; RUNNER = 'jobs/root-systemd-canary.sh'
props = lambda argv: [argv[i + 1] for i, a in enumerate(argv) if a == '-p']


def tmpdir(test, prefix):
    t = pathlib.Path(tempfile.mkdtemp(prefix=prefix)); test.addCleanup(shutil.rmtree, t, True); return t


def fakebin(t, name, body):
    d = t / 'bin'; d.mkdir(exist_ok=True); f = d / name; f.write_text('#!/bin/bash\n' + body); f.chmod(0o755); return d


class Render(unittest.TestCase):
    def setUp(self):
        self.u = CU.render(ID, LIVE, DROPIN, REPROOF, B)

    def test_units_are_ours_transient_bounded_waited_and_the_holder_sandbox_is_production_with_private_rw_only(self):
        self.assertEqual(set(self.u), {'busy', 'permit', 'holder', 'permitfail', 'holderfail', 'runtime', 'runtime2'})
        for n, a in self.u.items():
            self.assertIn(f'--unit=enclave-sdcanary-{ID}-{n}', a); self.assertIn('--wait', a)
            self.assertTrue(any(p.split('=')[0] == 'MemoryMax' and p.split('=')[1] in ('512M', '64M', '128M') for p in props(a)), n)
        for n in ('busy', 'holder', 'holderfail'):
            p = props(self.u[n])
            for want in ('ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'UMask=0027', 'IPAddressDeny=10.0.2.2/32',
                         'User=root', 'Group=root', 'Environment=ENCLAVE_BASE_LAUNCH_HANDSHAKE=1',
                         'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH CAP_CHOWN'):
                self.assertIn(want, p, (n, want))
            rw = [x for q in p if q.startswith('ReadWritePaths=') for x in q.split('=', 1)[1].split()]
            self.assertTrue(rw and all(x.startswith((f'/srv/enclave-sdcanary-{ID}/', f'/etc/enclave-sdcanary-{ID}/')) for x in rw), rw)
        for n in ('busy', 'holder', 'holderfail'):                                          # r5: production entry verbatim + sentinel controls
            self.assertIn('InaccessiblePaths=-/srv/enclave-l1-pair -/var/lib/enclave-rpc -/etc/enclave-rpc/jwt.hex', props(self.u[n]))
            self.assertIn(f'InaccessiblePaths=/srv/enclave-sdcanary-{ID}/sentinel-dir /srv/enclave-sdcanary-{ID}/sentinel-file', props(self.u[n]))
        rt = props(self.u['runtime']); self.assertIn(f'RuntimeDirectory=enclave-sdcanary-{ID}-rt', rt); self.assertIn('RuntimeDirectoryPreserve=yes', rt)

    def test_render_refuses_non_production_or_exposing_inputs(self):
        for live, drop, rep in ((LIVE.replace('ProtectSystem=strict', 'ProtectSystem=full'), DROPIN, REPROOF),
                                (LIVE, DROPIN.replace('base-bootstrap/journal.lock', 'base-bootstrap/journal.lock /etc/enclave-rpc'), REPROOF),
                                (LIVE, DROPIN, REPROOF.replace('RuntimeDirectoryPreserve=yes', ''))):
            with self.assertRaises(SystemExit):
                CU.render(ID, live, drop, rep, B)


class MaskMeta(unittest.TestCase):
    def test_metadata_only_never_opens_and_mountinfo_matches_exact_mount_points(self):
        t = tmpdir(self, 'sdc-m-'); f = t / 'secret'; f.write_text('TOP-SECRET'); d = t / 'dir'; d.mkdir()
        boom = lambda *a, **k: (_ for _ in ()).throw(AssertionError('a protected path was opened'))
        with patch('builtins.open', boom), patch.object(CU.os, 'open', boom):
            mf, md, mx = CU.meta(str(f)), CU.meta(str(d)), CU.meta(str(t / 'absent'))
        self.assertEqual((mf['type'], md['type'], mx['exists']), ('reg', 'dir', False)); self.assertNotIn('TOP-SECRET', json.dumps([mf, md]))
        text = ('36 25 0:31 /inaccessible/dir /srv/enclave-l1-pair ro,nosuid - tmpfs tmpfs rw\n'
                '37 25 0:31 /inaccessible/reg /etc/enclave-rpc/jwt.hex ro - tmpfs tmpfs rw\n40 25 8:1 / /srv/enclave-l1-pair2 rw - ext4 /dev/sda1 rw\n')
        self.assertEqual(CU.mountinfo('/srv/enclave-l1-pair', text), [{'root': '/inaccessible/dir', 'fstype': 'tmpfs', 'source': 'tmpfs'}])
        self.assertEqual(CU.mountinfo('/srv/enclave-l1-pair2', text)[0]['fstype'], 'ext4')


class WrapperCode(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, 'the offline job runs as uid 0 in unshare -Ur')
        self.t = tmpdir(self, 'sdc-w-'); os.chmod(self.t, 0o755); (self.t / 'bb').mkdir(mode=0o755)
        self.lock = self.t / 'bb/journal.lock'; self.lock.touch(); os.chmod(self.lock, 0o600)

    def ns(self, src=WRAPPER):
        W = CU.wrapper_ns(src); W['BOOTSTRAP_DIR'] = self.t / 'bb'; W['TRUSTED_TOP'] = self.t; return W

    def test_extracted_lock_functions_really_lock_and_refuse_legacy_and_env_less_starts(self):
        W = self.ns()
        with patch.dict(os.environ, {'ENCLAVE_BASE_LAUNCH_HANDSHAKE': '1'}):
            with self.assertRaisesRegex(AssertionError, 'legacy bin/base'):
                W['release_launch_lock']({})
            fd = W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}})
            with self.assertRaisesRegex(AssertionError, 'busy'):                     # the flock is really held (LOCK_NB second taker)
                W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}})
            os.close(fd); os.close(W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}}))
        with self.assertRaisesRegex(AssertionError, 'handshake'):
            W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}})

    def test_extraction_refuses_code_needing_a_global_the_canary_does_not_provide(self):
        src = pathlib.Path(WRAPPER).read_text()
        bad = self.t / 'w.py'; bad.write_text(src.replace('def launch_lock(directory=None, owner=None, top=None):',
                                                          'def launch_lock(directory=None, owner=None, top=None):\n    _undeclared_helper()', 1))
        self.assertIn('_undeclared_helper', bad.read_text())
        with self.assertRaises(SystemExit) as e:
            CU.wrapper_ns(bad)
        self.assertIn('_undeclared_helper', str(e.exception))


class GuestSampler(unittest.TestCase):
    """the guest script's own functions, sourced (SDC_SOURCE_ONLY) with a fake systemctl and a fake guest meminfo"""
    def setUp(self):
        self.t = tmpdir(self, 'sdc-g-'); self.log = self.t / 'systemctl.log'; self.mem = self.t / 'meminfo'
        self.mem.write_text('MemAvailable: 8388608 kB\n')
        bind = fakebin(self.t, 'systemctl', f'echo "$*" >> {self.log}\n')
        self.env = {'PATH': f'{bind}:/usr/bin:/bin', 'SDC_SOURCE_ONLY': '1', 'SDC_RUN_ROOT': str(self.t), 'MEMINFO': str(self.mem), 'GPOLL': '0.1'}

    def sh(self, body, timeout=30):
        return subprocess.run(['bash', '-c', f'. {GUEST}; init {ID}; mkdir -p $OUT; {body}'], env=self.env, capture_output=True, text=True, timeout=timeout)

    def test_flag_before_loop_samples_reserve_stop_own_only_and_kill_only_our_pid(self):
        r = self.sh(f"""sleep 30 & OTHER=$!; start_sampler; SP=$SAMPLER
            echo "flag=$([ -e $RUN/sampling ] && echo y) alive=$(kill -0 $SP 2>/dev/null && echo y)"
            sleep 0.6; printf 'MemAvailable: 1024 kB\\n' > {self.mem}; sleep 0.6; stop_sampler
            echo "after=$(kill -0 $SP 2>/dev/null && echo y || echo n) other=$(kill -0 $OTHER 2>/dev/null && echo y || echo n)"; kill $OTHER""")
        self.assertIn('flag=y alive=y', r.stdout, r.stderr); self.assertIn('after=n other=y', r.stdout)
        out = self.t / f'enclave-sdcanary-{ID}/out'
        self.assertGreaterEqual(len((out / 'guest-memavail.txt').read_text().splitlines()), 3)
        self.assertTrue((out / 'reserve.txt').exists())
        calls = self.log.read_text().splitlines()
        self.assertTrue(calls and set(calls) <= {f'stop enclave-sdcanary-{ID}-*.service', f'reset-failed enclave-sdcanary-{ID}-*.service'}, calls)

    def test_exit_trap_after_partial_setup_stops_sampler_and_own_units_and_reports_rc(self):
        r = self.sh('trap on_exit EXIT; start_sampler; echo $SAMPLER > $RUN/sp; UNITS_STARTED=1; exit 7')
        self.assertIn('## systemd-canary rc=7', r.stdout)
        sp = int((self.t / f'enclave-sdcanary-{ID}/sp').read_text()); time.sleep(0.2)
        self.assertFalse(pathlib.Path(f'/proc/{sp}').exists(), 'no orphan sampler')
        self.assertIn(f'stop enclave-sdcanary-{ID}-*.service', self.log.read_text())

    def test_main_dies_early_without_touching_units(self):
        env = {k: v for k, v in self.env.items() if k != 'SDC_SOURCE_ONLY'}
        r = subprocess.run(['bash', str(GUEST), ID], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 20); self.assertIn('upload incomplete', r.stdout); self.assertIn('## systemd-canary rc=20', r.stdout)
        self.assertNotIn('stop ', self.log.read_text() if self.log.exists() else '')


FAKE_SSH = r'''L=$FAKE_DIR/ssh.log; cmd="$*"; echo "CMD $cmd" >> $L
case "$cmd" in
  *"install -d"*) exit ${FAKE_STAGE_RC:-0};;
  *" tee "*) cat > /dev/null; exit ${FAKE_UPLOAD_RC:-0};;
  *"systemctl stop"*) echo "STOP $cmd" >> $L; exit 0;;
  *"bash -s"*) body=$(cat); if grep -q 'guest/cleanup.sh' <<< "$body"; then echo CLEANUP >> $L; exit ${FAKE_CLEANUP_RC:-0}; fi
     echo GUEST >> $L; [ -n "${FAKE_DELETE_MEM:-}" ] && rm -f $FAKE_MEMINFO; [ -n "${FAKE_LOWER_MEM:-}" ] && printf 'MemAvailable: 1024000 kB\n' > $FAKE_MEMINFO
     sleep ${FAKE_GUEST_SEC:-3}; echo "## systemd-canary rc=${FAKE_GUEST_RC:-0}"; exit ${FAKE_GUEST_RC:-0};;
  *"/result.tar"*) [ -s "${FAKE_RESULT:-}" ] && cat "$FAKE_RESULT" || exit 1;;
  *) exit 0;;
esac
'''


class HostRunner(unittest.TestCase):
    """the REAL host runner from a private copy of this stage (pins filled for a private fake 'final' stage), a FAKE ssh guest, a FAKE host meminfo"""
    def setUp(self):
        self.t = tmpdir(self, 'sdc-h-'); proj = self.t / 'proj'; self.st = proj / 'bootstrap-systemd-canary-stage/r2'
        shutil.copytree(S, self.st, ignore=shutil.ignore_patterns('logs', '__pycache__'))
        ff = proj / 'fakefinal'; files = {'bootstrap/holder_gate.py': None, 'wrapper/chain_service.py': WRAPPER, 'src/finality_state.py': None,
                                          'units/enclave-base-holder.service.d/60-release-mode.conf': os.environ['CANARY_DROPIN'],
                                          'units/enclave-base-finality-reproof.service': os.environ['CANARY_REPROOF']}
        sh = lambda b: __import__('hashlib').sha256(b).hexdigest(); pins = {}
        for rel, src in files.items():
            d = ff / rel; d.parent.mkdir(parents=True, exist_ok=True); d.write_bytes(pathlib.Path(src).read_bytes() if src else f'# fake {rel}\n'.encode()); pins[rel] = sh(d.read_bytes())
        (ff / 'SHA256SUMS').write_text(''.join(f'{v}  {k}\n' for k, v in pins.items()))
        (self.st / 'FINAL-PINS.json').write_text(json.dumps({'stage': 'fakefinal', 'stageSha256sums': sh((ff / 'SHA256SUMS').read_bytes()),
                                                             'canaryUnits': sh((self.st / 'guest/canary_units.py').read_bytes()), 'files': pins}))
        self.refreeze()
        self.mem = self.t / 'meminfo'; self.mem.write_text('MemAvailable: 20480000 kB\n'); self.fd = self.t / 'fake'; self.fd.mkdir()
        fakebin(self.t, 'fake-ssh', FAKE_SSH); self.ssh = self.t / 'bin/fake-ssh'

    def refreeze(self):
        subprocess.run(['bash', '-c', "find . -type f ! -name SHA256SUMS ! -path './logs/*' | sort | xargs sha256sum > SHA256SUMS"], cwd=self.st, check=True)

    def result_tar(self, passed=True):
        r = self.t / 'res'; shutil.rmtree(r, ignore_errors=True); (r / 'out').mkdir(parents=True); (r / 'out/verdict.json').write_text(json.dumps({'pass': passed, 'required': {}, 'informational': {}}))
        with tarfile.open(self.t / 'result.tar', 'w') as tf:
            tf.add(r / 'out', arcname='out')
        return self.t / 'result.tar'

    def run_(self, **env):
        e = {'PATH': '/usr/bin:/bin', 'TMPDIR': os.environ.get('TMPDIR', '/tmp'), 'SDC_TEST_FAKE_SSH': str(self.ssh), 'SDC_TEST_MEMINFO': str(self.mem),
             'SDC_TEST_POLL': '1', 'FAKE_DIR': str(self.fd), 'FAKE_MEMINFO': str(self.mem), **env}
        r = subprocess.run(['bash', str(self.st / RUNNER)], env=e, capture_output=True, text=True, timeout=120)
        runs = sorted((self.st / 'logs').glob('run-*'), key=lambda q: q.stat().st_mtime_ns); v = json.loads((runs[-1] / 'HOST-VERDICT.json').read_text()) if runs and (runs[-1] / 'HOST-VERDICT.json').exists() else None
        log = (self.fd / 'ssh.log').read_text() if (self.fd / 'ssh.log').exists() else ''
        return r, v, log, (runs[-1] if runs else None)

    def test_success_needs_guest_pass_and_host_samples(self):
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar()), FAKE_GUEST_SEC='3')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertTrue(v['pass'], v); self.assertGreaterEqual(v['hostSamples'], 2)
        self.assertIn('CLEANUP', log); self.assertNotIn('sudo -n systemctl stop enclave-', log.replace("'enclave-sdcanary-", ''))
        for l in log.splitlines():
            if l.startswith('STOP'):
                self.assertIn(f"systemctl stop 'enclave-sdcanary-", l)

    def test_host_floor_breach_stops_only_own_units_and_is_never_a_pass(self):
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar()), FAKE_LOWER_MEM='1', FAKE_GUEST_SEC='4')
        self.assertEqual(r.returncode, 20, r.stdout); self.assertFalse(v['pass']); self.assertTrue((o / 'floor.txt').exists())
        stops = [l for l in log.splitlines() if l.startswith('STOP')]
        self.assertTrue(stops and all("systemctl stop 'enclave-sdcanary-" in l and l.count('enclave-') == 1 for l in stops), stops)
        self.assertIn('CLEANUP', log)

    def test_upload_failure_after_staging_still_cleans_up_owned_only(self):
        r, v, log, o = self.run_(FAKE_UPLOAD_RC='1')
        self.assertEqual(r.returncode, 20); self.assertIn('upload', r.stdout); self.assertFalse(v['pass'])
        self.assertIn('STOP', log); self.assertIn('CLEANUP', log); self.assertNotIn('GUEST', log)

    def test_guest_timeout_and_guest_failure_are_failures_with_cleanup(self):
        r, v, log, o = self.run_(FAKE_GUEST_SEC='20', SDC_TEST_GUEST_TIMEOUT='2')
        self.assertNotEqual(r.returncode, 0); self.assertFalse(v['pass']); self.assertIn('CLEANUP', log)
        (self.fd / 'ssh.log').unlink()
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar(passed=False)), FAKE_GUEST_SEC='2', FAKE_GUEST_RC='1')
        self.assertEqual(r.returncode, 1); self.assertFalse(v['pass']); self.assertIn('CLEANUP', log)

    def test_fast_guest_success_has_real_start_and_end_host_samples(self):
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar()), FAKE_GUEST_SEC='0', SDC_TEST_POLL='30')   # r5: no periodic sample happens
        self.assertEqual(r.returncode, 0, r.stdout); self.assertTrue(v['pass'], v); self.assertGreaterEqual(v['hostSamples'], 2)
        rows = [l.split() for l in (o / 'host-memavail.txt').read_text().splitlines()]
        self.assertEqual([x[2] for x in rows], ['start', 'end']); self.assertTrue(all(x[1] == '20000' for x in rows), rows)   # real readings of the fake host

    def test_guest_rc0_with_an_unreadable_host_sample_exits_nonzero_and_host_false(self):
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar()), FAKE_GUEST_SEC='0', SDC_TEST_POLL='30', FAKE_DELETE_MEM='1')
        self.assertIn('## systemd-canary rc=0', (o / 'guest.out').read_text())
        self.assertNotEqual(r.returncode, 0, r.stdout); self.assertFalse(v['pass']); self.assertIn('unreadable end', (o / 'host-memavail.txt').read_text())
        self.assertIn('CLEANUP', log)

    def test_guest_rc0_without_a_fetchable_guest_result_exits_nonzero(self):
        r, v, log, o = self.run_(FAKE_GUEST_SEC='3')                                                           # no result.tar
        self.assertEqual(r.returncode, 22, r.stdout); self.assertFalse(v['pass']); self.assertFalse(v['checks']['guest verdict pass'])

    def test_cleanup_failure_after_a_passing_run_exits_nonzero_and_a_prior_failure_is_kept(self):
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar()), FAKE_GUEST_SEC='3', FAKE_CLEANUP_RC='1')
        self.assertEqual(r.returncode, 21, r.stdout); self.assertIn('CLEANUP FAILED', r.stdout)
        (self.fd / 'ssh.log').unlink()
        r, v, log, o = self.run_(FAKE_RESULT=str(self.result_tar(passed=False)), FAKE_GUEST_SEC='2', FAKE_GUEST_RC='3', FAKE_CLEANUP_RC='1')
        self.assertEqual(r.returncode, 3, 'the original guest failure is kept, never replaced')

    def test_null_pins_refuse_before_any_guest_contact(self):
        # r4: EXPLICIT null pins in the PRIVATE stage copy (the shipped FINAL-PINS.json may be bound by root; it is never modified here)
        shipped = (S / 'FINAL-PINS.json').read_bytes()
        null = {'stage': None, 'stageSha256sums': None, 'canaryUnits': None, 'files': {k: None for k in json.loads(shipped)['files']}}
        (self.st / 'FINAL-PINS.json').write_text(json.dumps(null, indent=1)); self.refreeze()
        self.assertTrue(all(v is None for v in json.loads((self.st / 'FINAL-PINS.json').read_text())['files'].values()))
        r, v, log, o = self.run_()
        self.assertEqual(r.returncode, 20); self.assertIn('assembly refused', r.stdout); self.assertEqual(log, ''); self.assertFalse(v['pass'])
        self.assertIn('not qualified', (o / 'assemble.json').read_text())
        self.assertEqual((S / 'FINAL-PINS.json').read_bytes(), shipped, 'the shipped pins are untouched by the test')


class Verdict(unittest.TestCase):
    def setUp(self):
        self.t = tmpdir(self, 'sdc-v-')
        self.p = {k: (str(self.t / k) if k not in ('rt', 'unit') else v) for k, v in CU.paths(ID).items()}
        for k in ('run', 'data', 'out'):
            pathlib.Path(self.p.get(k, self.t / k)).mkdir(parents=True, exist_ok=True)
        self.ctx = self.t / 'ctx.json'; self.ctx.write_text(json.dumps({'id': ID, 'bundle': B, 'out': str(self.t / 'out')}))
        pp = patch.object(CU, 'paths', lambda i: self.p); pp.start(); self.addCleanup(pp.stop)

    PROD = ['/srv/enclave-l1-pair', '/var/lib/enclave-rpc', '/etc/enclave-rpc/jwt.hex']
    SENT = [f'/srv/enclave-sdcanary-{ID}/sentinel-dir', f'/srv/enclave-sdcanary-{ID}/sentinel-file']
    HOST = {PROD[0]: ('dir', 100, '0o750'), PROD[2]: ('reg', 200, '0o640'), SENT[0]: ('dir', 300, '0o755'), SENT[1]: ('reg', 301, '0o644')}

    def node(self, t):
        return {'exists': True, 'type': t, 'mode': '0o0', 'dev': 5, 'ino': 10 if t == 'dir' else 11, 'uid': 0}

    def host_paths(self, over):
        out = {x: {'exists': False, 'errno': 2} for x in self.PROD + self.SENT}
        for x, (t, ino, mode) in self.HOST.items():
            out[x] = {'exists': True, 'type': t, 'mode': mode, 'dev': 1, 'ino': ino, 'uid': 0}
        return {**out, **over}

    def mask_in(self, over):
        out = {}
        for x, m in self.host_paths({}).items():
            out[x] = {'meta': self.node(m['type']) if m['exists'] else {'exists': False, 'errno': 2}, 'mounts': []}
        for x, m in over.items():
            out[x] = {'meta': m, 'mounts': []}
        return out

    def evidence(self, **over):
        uid, gid = 994, 985; bnd = sum(1 << CU.CAPS[x] for x in ('CAP_SETUID', 'CAP_SETGID', 'CAP_DAC_READ_SEARCH', 'CAP_CHOWN'))
        no = lambda e: {'ok': False, 'errno': e, 'msg': ''}
        root = {'probe': 'holder-root', 'identity': {'startNs': 10 ** 19, 'euid': 0, 'handshakeEnv': '1', 'capBnd': bnd, 'capEff': bnd, 'noNewPrivs': 1},
                'readRpcbaseSecret': {'ok': True}, 'journalAppend': {'ok': True}, 'releaseLock': {'ok': True}, 'roEtcWrite': no(30), 'launchBootstrapWrite': no(30),
                'mask': self.mask_in(over.get('mask', {})), 'maskNodes': {'dir': self.node('dir'), 'reg': self.node('reg')},
                'sentinelFileLen': {'ok': True, 'value': over.get('sentinelLen', 0)}, 'ownDatadir': {'ok': True, 'value': [0, '1 entry']}, 'rootfileOwner': {'ok': True, 'value': uid},
                'legacyRefusal': {'ok': False, 'msg': 'legacy bin/base under the root release-mode unit drop-in: refusing'}, 'waitL1': {'ok': True, 'value': [0, 'L1 ready']},
                **over.get('root', {})}
        dropped = {'probe': 'holder-dropped', 'identity': {'resuid': [uid] * 3, 'resgid': [gid] * 3, 'capEff': 0, 'capPrm': 0}, 'setuid0': no(1),
                   'dataWrite': {'ok': True}, 'tmpWrite': {'ok': True}, 'journalWrite': no(13), 'rootOnlyRead': no(13),
                   'maskOpen': {x: ({'ok': False, 'errno': 13} if m['exists'] else None) for x, m in self.host_paths(over.get('host', {})).items() if m['exists']} | over.get('maskOpen', {})}
        o = self.t / 'out'
        (o / 'journal-holder.txt').write_text(f'SDCANARY {json.dumps(root)}\nSDCANARY {json.dumps(dropped)}\n')
        (o / 'journal-runtime.txt').write_text(''.join('SDCANARY ' + json.dumps({'probe': 'runtime', 'before': {'ok': True}, 'fileBefore': fb, 'publish': {'ok': True}}) + '\n' for fb in (False, True)))
        (o / 'runtime.json').write_text(json.dumps({'mode': '0o755', 'uid': 0, 'fileMode': '0o644'}))
        (o / 'busy.json').write_text(json.dumps({'downloaderState': 'activating', 'startRan': False, 'conditionMsg': True, 'conditionResult': 'no',
                                                 'skippedExecCondition': True, **over.get('busy', {})}))
        hp = self.host_paths(over.get('host', {}))
        (o / 'mask-host.json').write_text(json.dumps({'paths': hp, 'production': self.PROD, 'sentinels': self.SENT, 'nodes': {'dir': self.node('dir'), 'reg': self.node('reg')}}))
        inv = {'pidsUnchanged': True, 'configUnchanged': True, 'guestSamples': 5, 'guestSamplesReadable': True, 'guestMinAvailMiB': 40000,
               'guestReserveMiB': 4096, 'guestReserveBreach': False, **over.get('inv', {})}
        (o / 'invariants.json').write_text(json.dumps(inv))
        (self.t / 'run/permit.stamps').write_text('1\n2\n'); (self.t / 'run/permitfail.stamps').write_text('1\n2\n')
        with patch.object(CU.pwd, 'getpwnam', lambda n: type('pw', (), {'pw_uid': uid, 'pw_gid': gid})()):
            return CU.verdict(self.ctx)

    def test_l1_and_guest_reserve_evidence_are_required(self):
        self.assertEqual(self.evidence(), 0)
        for bad in ({'root': {'waitL1': {'ok': True, 'value': [1, 'L1 not ready within 300 s']}}}, {'root': {'waitL1': {'ok': False, 'errno': None, 'msg': 'x'}}},
                    {'inv': {'guestSamples': 1}}, {'inv': {'guestSamplesReadable': False}}, {'inv': {'guestMinAvailMiB': 100}}, {'inv': {'guestReserveBreach': True}},
                    {'inv': {'pidsUnchanged': False}}):
            with self.subTest(bad=bad):
                self.assertEqual(self.evidence(**bad), 1)

    def test_mask_identity_positive_and_deliberate_unmasked_or_leaky_paths_reject(self):
        self.assertEqual(self.evidence(), 0)
        info = json.loads((self.t / 'out/verdict.json').read_text())['informational']['InaccessiblePaths per path']
        self.assertEqual(info, {x: True for x in self.PROD + self.SENT})                  # incl. an absent production path: absent inside too
        P, S_ = self.PROD, self.SENT; host = lambda x: {**self.host_paths({})[x]}
        for bad in ({'mask': {P[0]: host(P[0])}},                                            # unmasked directory: the host object itself
                    {'mask': {P[2]: host(P[2])}},                                            # unmasked file
                    {'mask': {P[2]: {**self.node('reg'), 'mode': '0o644'}}},                 # node identity but not 0000
                    {'mask': {P[0]: {**self.node('reg')}}},                                  # the wrong node type
                    {'maskOpen': {P[2]: {'ok': True}}},                                      # rpcbase could open the protected file
                    {'mask': {P[1]: self.node('dir')}},                                      # absent on the host but present inside
                    {'host': {S_[0]: {'exists': False, 'errno': 2}}},                         # positive control missing
                    {'sentinelLen': 9}):                                                     # the sentinel's bytes were readable
            with self.subTest(bad=bad):
                self.assertEqual(self.evidence(**bad), 1)

    def test_busy_uses_the_gate_states_and_requires_the_actual_condition_evidence(self):
        for st in ('activating', 'active', 'deactivating'):
            self.assertEqual(self.evidence(busy={'downloaderState': st}), 0, st)
        for bad in ({'startRan': True}, {'conditionResult': 'yes'}, {'skippedExecCondition': False}, {'conditionMsg': False}):
            with self.subTest(bad=bad):
                self.assertEqual(self.evidence(busy=bad), 1)
        self.assertEqual(self.evidence(busy={'downloaderState': 'inactive', 'startRan': True}), 0)
        self.assertIn('NOT EXERCISED', json.loads((self.t / 'out/verdict.json').read_text())['informational']['datadir-idle busy refusal'])

    def test_host_verdict_requires_host_samples_floor_and_guest_pass(self):
        o = self.t / 'hv'; (o / 'result/out').mkdir(parents=True); (o / 'result/out/verdict.json').write_text('{"pass": true}')
        (o / 'guest.out').write_text('...\n## systemd-canary rc=0\n')
        hv = lambda rc=0: json.loads(subprocess.run([sys.executable, '-I', str(S / 'tools/host_verdict.py'), str(o), str(rc), '16384'], capture_output=True, text=True).stdout)
        (o / 'host-memavail.txt').write_text('1 20000 start\n')
        self.assertFalse(hv()['pass'], 'one sample is not watchdog evidence')
        (o / 'host-memavail.txt').write_text('1 20000 start\n2 19000 end\n'); self.assertTrue(hv()['pass'])
        (o / 'host-memavail.txt').write_text('1 20000 start\n2 19000 periodic\n'); self.assertFalse(hv()['pass'], 'no END sample')
        (o / 'host-memavail.txt').write_text('1 20000\n2 19000\n'); self.assertFalse(hv()['pass'], 'untagged samples are not start/end')
        (o / 'host-memavail.txt').write_text('1 20000 start\n2 unreadable end\n'); self.assertFalse(hv()['pass'])
        (o / 'host-memavail.txt').write_text('1 20000 start\n2 16000 end\n'); self.assertFalse(hv()['pass'])
        (o / 'host-memavail.txt').write_text('1 20000 start\n2 19000 end\n'); self.assertFalse(hv(rc=1)['pass'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
