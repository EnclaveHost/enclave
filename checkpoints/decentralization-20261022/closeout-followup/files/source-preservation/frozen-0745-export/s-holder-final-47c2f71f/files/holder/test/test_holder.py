"""Tests for holder.py. Run by run-tests.sh inside `unshare -rn` (loopback only).
  Validation/render: the reviewed config shape; every refusal is a real input the validator must reject.
  Lifecycle: the REAL launcher process (`holder.py run`) supervising test/standin-base.py, a STAND-IN for the `base`
  binary (not a Base client). The stand-in records the argv and environment it actually received.
  Host placement: backing_disks() against the REAL sysfs of this machine (read-only).
The maintained-client lifecycle check (upstream reth v2.8.0 --dev, also not Base) is in test_reth_dev.py."""
import copy
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOLDER = HERE.parent / 'holder.py'
spec = importlib.util.spec_from_file_location('holder', HOLDER)
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
EXAMPLE = json.loads((HERE.parent / 'holder.example.json').read_text())
SHA = H.BINARY['binary']['sha256']   # the reviewed official binary


def good():
    c = copy.deepcopy(EXAMPLE)
    c['binary']['sha256'] = SHA
    c['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
    return c


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Validation(unittest.TestCase):
    def refused(self, mutate, needle):
        c = good()
        mutate(c)
        with self.assertRaises(H.Refused) as e:
            H.validate(c)
        self.assertIn(needle, str(e.exception))

    def test_example_is_review_only(self):
        self.assertEqual(EXAMPLE['binary']['sha256'], H.BINARY['binary']['sha256'])
        with self.assertRaises(H.Refused) as e:
            H.validate(EXAMPLE)
        self.assertIn('placeholder', str(e.exception))
        v = H.validate(EXAMPLE, review=True)
        self.assertTrue(v['review'])
        with self.assertRaises(H.Refused):
            H.preflight(v)
        with self.assertRaises(H.Refused):
            H.run(v)

    def test_good_config_and_accounting(self):
        c = H.validate(good())
        acc = c['storage']['nvmeAccounting']
        self.assertEqual(acc['capBytes'], 250_000_000_000)
        self.assertEqual(acc['holderBytes'], 197_999_984_640 + 1_073_741_824 + 67_108_864)
        self.assertLessEqual(acc['holderBytes'], acc['targetBytes'])
        self.assertIn('/etc/enclave-rpc-cache/nvme-cache-budget.json', acc['enforcedBy'])
        self.assertEqual(H.budget_reservation(c)['maxBytes'], acc['holderBytes'], 'the ledger reservation is exactly this cache')

    def test_refusals(self):
        cases = [
            (lambda c: c.update(format='x'), 'format'),
            (lambda c: c.update(extra=1), 'unknown field'),
            (lambda c: c['rpc'].update(jwtSecret='x'), 'unknown field'),
            (lambda c: c['binary'].update(sha256='RECORD'), 'binary.sha256'),
            (lambda c: c['binary'].update(sha256='ab' * 32), 'reviewed official binary'),
            (lambda c: c['l1'].update(executionRpc='https://l1-execution-endpoint.invalid/'), 'placeholder'),
            (lambda c: c['binary'].update(release='v1.5.0'), 'binary.release'),
            (lambda c: c['binary'].update(releaseTarballSha256='00' * 32), 'release asset digest'),
            (lambda c: c.update(serviceUser='root'), 'serviceUser'),
            (lambda c: c['rpc'].update(port=8545), "local verifier"),
            (lambda c: c['consensusRpc'].update(port=8545), "local verifier"),
            (lambda c: c['rpc'].update(api=['eth', 'debug']), 'rpc.api'),
            (lambda c: c['rpc'].update(api=['eth', 'admin']), 'rpc.api'),
            (lambda c: c['rpc'].update(proofWindowBlocks=H.MAX_PROOF_WINDOW + 1), 'proofWindowBlocks'),
            (lambda c: c['p2p'].update(listenIp='127.0.0.1'), 'loopback'),
            (lambda c: c['p2p'].update(consensusTcpPort=30303), 'distinct'),
            (lambda c: c['l1'].update(trustRpc=True), 'trustRpc'),
            (lambda c: c['l1'].update(executionRpc='http://l1.example.org/'), 'https'),
            (lambda c: c['l1'].update(beacon='https://user:pw@beacon.example.org/'), 'credentials'),
            (lambda c: c['l1'].update(executionRpc='https://l1.example.org/?key=1'), 'query'),
            (lambda c: c.update(upgradeSignalMode='runtime-admin'), 'upgradeSignalMode'),
            (lambda c: c['txForwarding'].update(endpoint='http://seq.example.org'), 'txForwarding'),
            (lambda c: c.update(prune='archive'), 'prune'),
            (lambda c: c['limits'].update(memoryMaxBytes=1 << 30), 'memoryMaxBytes'),
            (lambda c: c['limits'].update(stopTimeoutSec=5), 'stopTimeoutSec'),
            (lambda c: c.update(datadir='/srv/elsewhere/data'), 'inside storage.mountPoint'),
            (lambda c: c.update(staticFilesDir='/vm/static'), 'staticFilesDir'),
            (lambda c: c['storage'].update(layout='raw-device'), 'loop-ext4-image'),
            (lambda c: c['storage']['cache'].update(mode='writeback'), 'writethrough'),
            (lambda c: c['storage']['cache'].update(mechanism='lvmcache'), 'mechanism'),
            (lambda c: c['storage']['cache'].update(blockBytes=100000), '32 KiB'),
            (lambda c: c['storage']['cache'].update(dataBytes=197_999_984_640 + 1), 'whole number'),
            (lambda c: c['storage']['cache'].update(metadataBytes=16 << 20), 'metadataBytes'),
            (lambda c: c['storage']['cache'].update(metadataBytes=(1 << 30) + 512), 'filesystem block'),
            (lambda c: c['storage']['cache'].update(metadataImagePath=c['storage']['cache']['dataImagePath']), 'distinct'),
            (lambda c: c['storage']['cache'].update(dataImagePath='/srv/enclave-base-holder/c.img'), 'outside the mount'),
            (lambda c: c['storage']['cache'].update(dataBytes=(250_000_000_000 // 262144) * 262144), 'operational target'),
            (lambda c: c['storage']['cache'].update(dataBytes=197_999_984_640 + 4000 * 262144), 'operational target'),
            (lambda c: c['storage'].update(otherNvmeCacheAllocations=[{'label': 'sia cache', 'bytes': 1}]), 'unknown field'),
            (lambda c: c['storage'].update(nvmeInventoryPath='/etc/enclave-base-holder/nvme-cache-inventory.tsv'), 'unknown field'),
            (lambda c: c['storage'].pop('nvmeBudget'), 'storage.nvmeBudget'),
            (lambda c: c['storage']['nvmeBudget'].update(ledgerPath='/etc/enclave-base-holder/budget.json'), 'canonical shared ledger'),
            (lambda c: c['storage']['nvmeBudget'].update(reservationId='Bad Id'), 'reservation id'),
            (lambda c: c['storage'].update(cache={'mechanism': 'none'}), 'applies only to a cache'),
            (lambda c: c['storage']['origin'].update(bytes=10 ** 12), 'origin.bytes'),
        ]
        for mutate, needle in cases:
            with self.subTest(needle=needle):
                self.refused(mutate, needle)

    def test_budget_example_is_a_valid_ledger_once_root_fills_the_host(self):
        ex = H.budget_example(H.validate(good()))
        with self.assertRaises(H.BUDGET.BudgetError):
            H.BUDGET.validate(ex)                       # placeholder machine id: not valid as rendered
        mid = 'ab' * 16
        ex['hosts'][0]['machineId'] = mid
        ex['reservations'][0]['host'] = mid
        self.assertEqual(H.BUDGET.validate(ex)['reservations'][0]['maxBytes'], 199_140_835_328)
        self.assertEqual(ex['reservations'][0]['blockBytes'], 4096)
        self.assertGreaterEqual(ex['reservations'][0]['slackBytes'], H.BUDGET.required_headroom(ex['reservations'][0]))

    def test_no_cache_layout(self):
        c = good()
        c['storage']['cache'] = {'mechanism': 'none'}
        c['storage'].pop('nvmeBudget')
        v = H.validate(c)
        self.assertEqual(v['storage']['nvmeAccounting']['holderBytes'], 0)


class Render(unittest.TestCase):
    def test_argv_is_exact_loopback_and_every_flag_is_pinned(self):
        c = H.validate(good())
        a = H.argv(c)
        self.assertEqual(a[:4], ['/opt/enclave-base-holder/bin/base', '--chain', 'mainnet', 'rpc'])
        self.assertEqual(a[a.index('--http.addr') + 1], '127.0.0.1')
        self.assertEqual(a[a.index('--rpc.addr') + 1], '127.0.0.1')
        self.assertEqual(a[a.index('--http.api') + 1], 'eth,net,web3')
        self.assertEqual(a[a.index('--upgrade-signal.mode') + 1], 'metrics-only')
        self.assertNotIn('--rpc.forwarding-endpoint', a, 'no sequencer route unless configured')
        self.assertNotIn('--ws', a)
        self.assertFalse({'--minimal', '--full'} & set(a), 'the prune profile comes from the download-generated reth.toml')
        self.assertEqual({x for x in a if x.startswith('--')} - {'--chain'} - set(H.BINARY['flagsInRpcHelp']), set(),
                         'every rendered flag was seen in the official binary help')
        flags = {x for x in a if x.startswith('--')}
        self.assertEqual(flags - set(H.FLAGS['flags']), set(), 'every rendered flag has a pinned source location')
        for f in flags:
            self.assertEqual(a.count(f), 1, f)
        c2 = good()
        c2['txForwarding']['endpoint'] = 'https://mainnet-sequencer.base.org'
        a2 = H.argv(H.validate(c2))
        self.assertEqual(a2[a2.index('--rpc.forwarding-endpoint') + 1], 'https://mainnet-sequencer.base.org')

    def test_child_env_is_whole_and_closed(self):
        env = H.child_env(H.validate(good()))
        self.assertEqual(set(env), {'PATH', 'LANG', 'HOME', 'TMPDIR', 'BASE_NODE_L1_TRUST_RPC'})
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')
        self.assertEqual(env['TMPDIR'], '/srv/enclave-base-holder/tmp', 'node temp/spill stays on the HDD-backed mount')

    def test_render_files(self):
        tmp = Path(tempfile.mkdtemp(prefix='hr-'))
        try:
            m = H.render(H.validate(good()), tmp / 'out')
            out = tmp / 'out'
            self.assertEqual(sorted(p.name for p in out.iterdir()), sorted(list(m['files']) + ['manifest.json']))
            for n, h in m['files'].items():
                self.assertEqual(hashlib.sha256((out / n).read_bytes()).hexdigest(), h)
            unit = (out / 'enclave-base-holder.service').read_text()
            for line in ('Type=notify', 'KillMode=mixed', 'MemoryMax=34359738368', 'MemorySwapMax=0', 'TasksMax=4096',
                         'LimitNOFILE=65536', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
                         'ReadWritePaths=/srv/enclave-base-holder', 'User=enclave-holder', 'TimeoutStopSec=630',
                         'Requires=enclave-base-holder-storage.service'):
                self.assertIn(line + '\n', unit)
            script = (out / 'holder-storage.sh').read_text()
            self.assertIn('cache $(mm "$M") $(mm "$D") $(mm "$O") $BLOCK_SECTORS 1 writethrough smq 0', script)
            self.assertNotIn('writeback', script)
            self.assertIn("LEDGER='/etc/enclave-rpc-cache/nvme-cache-budget.json'", script)
            self.assertIn("RESERVATION='base-holder-dm-cache'", script)
            self.assertNotIn('INVENTORY', script)
            self.assertIn('"$PY" -I "$BUDGET_TOOL" allocate "$LEDGER" "$RESERVATION"', script)
            self.assertNotIn('fallocate -l "$CDATA_BYTES"', script, 'cache files are allocated only through the budget ledger')
            r = subprocess.run(['bash', '-n', str(out / 'holder-storage.sh')], capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            drill = (HERE.parent / 'drill-cache.sh').read_text()
            self.assertIn('cache $M $D $O 512 1 writethrough smq 0', drill, 'the drill exercises the rendered table form')
            self.assertEqual(subprocess.run(['bash', '-n', str(HERE.parent / 'drill-cache.sh')]).returncode, 0)
            frag = json.loads((out / 'b-proof-source.json').read_text())
            self.assertEqual(frag['proofSources']['untrusted'], ['http://127.0.0.1:18545/'])
        finally:
            shutil.rmtree(tmp)


class RethToml(unittest.TestCase):
    """check_reth_toml on SYNTHETIC files shaped like the two cases (the real download-generated file needs a snapshot
    download, which is not authorized here)."""
    def check(self, text, prune='minimal'):
        tmp = Path(tempfile.mkdtemp(prefix='ht-'))
        try:
            if text is not None:
                (tmp / 'reth.toml').write_text(text)
            c = dict(H.validate(good()), datadir=str(tmp), prune=prune)
            return H.check_reth_toml(c)
        finally:
            shutil.rmtree(tmp)

    def test_download_like_config_passes_and_default_or_missing_fails(self):
        dl = ('[prune]\nblock_interval = 5\n[prune.segments]\nsender_recovery = "full"\ntransaction_lookup = "full"\n'
              'receipts = { distance = 64 }\n[static_files.blocks_per_file]\nheaders = 500000\ntransactions = 500000\n')
        self.assertIn('500000', self.check(dl))
        for text, needle in ((None, 'missing'), ('[stages]\n[prune]\nblock_interval = 5\n', 'prune segments'),
                             (dl.replace('transaction_lookup = "full"\n', ''), 'prune segments'),
                             (dl.split('[static_files')[0], 'static-file segment sizes')):
            with self.subTest(needle=needle):
                with self.assertRaises(H.Refused) as e:
                    self.check(text)
                self.assertIn(needle, str(e.exception))
        self.assertIn('full', self.check(dl.replace('transaction_lookup = "full"\n', ''), prune='full'))


class Placement(unittest.TestCase):
    """backing_disks() on this machine's real sysfs (read-only)."""
    def test_real_devices(self):
        for path, rot in (('/vm', False), ('/mnt/usb', True), ('/', False)):
            if not os.path.exists(path):
                continue
            leaves = H.backing_disks(path)
            with self.subTest(path=path, leaves=leaves):
                self.assertTrue(leaves)
                self.assertTrue(all(l['rotational'] == rot for l in leaves), leaves)


class Lifecycle(unittest.TestCase):
    """The real launcher process supervising the stand-in."""
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='hl-'))
        self.rec = self.tmp / 'rec'
        self.rec.mkdir()
        self.bin = self.tmp / 'bin' / 'base'
        self.bin.parent.mkdir()
        shutil.copy(HERE / 'standin-base.py', self.bin)
        os.chmod(self.bin, 0o755)
        # a copy of the package whose BINARY.json pins the STAND-IN (the real package pins only the official binary)
        self.pkg = self.tmp / 'pkg'
        self.pkg.mkdir()
        for f in ('holder.py', 'budget.py', 'FLAGS.json', 'holder-storage.sh.in'):
            shutil.copy(HERE.parent / f, self.pkg / f)
        b = dict(H.BINARY, binary=dict(H.BINARY['binary'], sha256=hashlib.sha256(self.bin.read_bytes()).hexdigest()))
        (self.pkg / 'BINARY.json').write_text(json.dumps(b))
        spec2 = importlib.util.spec_from_file_location('holder_standin', self.pkg / 'holder.py')
        self.H = importlib.util.module_from_spec(spec2)
        spec2.loader.exec_module(self.H)
        (self.tmp / 'mnt' / 'data').mkdir(parents=True)
        os.chmod(self.tmp / 'mnt' / 'data', 0o700)
        (self.tmp / 'run').mkdir()
        self.port = free_port()
        c = good()
        c['binary'].update(path=str(self.bin), sha256=hashlib.sha256(self.bin.read_bytes()).hexdigest())
        c['datadir'] = str(self.tmp / 'mnt' / 'data')
        c['storage'].update(mountPoint=str(self.tmp / 'mnt'), cache={'mechanism': 'none'})
        c['storage'].pop('nvmeBudget', None)
        c['rpc']['port'] = self.port
        c['consensusRpc']['port'] = free_port()
        c['limits']['stopTimeoutSec'] = 30
        c['limits']['readyTimeoutSec'] = 10
        self.cfg = self.tmp / 'holder.json'
        self.cfg.write_text(json.dumps(c))
        self.c = self.H.validate(c)

    def tearDown(self):
        if getattr(self, 'notify', None):
            self.notify.close()
        if getattr(self, 'proc', None) and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(10)
        if getattr(self, 'proc', None) and self.proc.stdout:
            self.proc.stdout.close()
        for f in ('child.pid', 'grandchild.pid'):
            p = self.rec / f
            if p.exists():
                try:
                    os.kill(int(p.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        shutil.rmtree(self.tmp)

    def mode(self, **m):
        Path(str(self.bin) + '.mode').write_text(json.dumps(dict(m, recordDir=str(self.rec))))

    def launch(self):
        self.notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        name = 'holder-test-%d-%s' % (os.getpid(), os.urandom(6).hex())
        self.notify.bind('\0' + name)
        self.notify.settimeout(15)
        env = {'PATH': os.environ['PATH'], 'NOTIFY_SOCKET': '@' + name, 'RUNTIME_DIRECTORY': str(self.tmp / 'run'),
               'OP_RETH_SEQUENCER_HTTP': 'https://hidden-sequencer.invalid', 'BASE_NODE_L1_ETH_RPC': 'https://hidden-l1.invalid',
               'RETH_CHAIN': 'sepolia'}
        self.proc = subprocess.Popen([sys.executable, '-I', str(self.pkg / 'holder.py'), 'run', str(self.cfg)], env=env, stdout=subprocess.PIPE, text=True)
        return self.proc

    def wait_file(self, name, secs=10):
        end = time.monotonic() + secs
        while time.monotonic() < end and not (self.rec / name).exists():
            time.sleep(0.05)
        return (self.rec / name).read_text()

    def alive(self, pid):
        try:
            os.kill(pid, 0)
            return open(f'/proc/{pid}/stat').read().split()[2] != 'Z'
        except (ProcessLookupError, FileNotFoundError):
            return False

    def test_ready_notify_exact_argv_closed_env_and_clean_stop(self):
        self.mode(grandchild=True)
        p = self.launch()
        msg = self.notify.recv(4096).decode()
        self.assertIn('READY=1', msg)
        child, grand = int(self.wait_file('child.pid')), int(self.wait_file('grandchild.pid'))
        self.assertEqual(json.loads((self.rec / 'argv.json').read_text()), self.H.argv(self.c))
        env = json.loads((self.rec / 'env.json').read_text())
        self.assertEqual({k: v for k, v in env.items() if k not in ('PWD',)}, self.H.child_env(self.c), 'nothing inherited')
        self.assertEqual((self.rec / 'cwd.txt').read_text(), self.c['datadir'], 'the child runs in its datadir (engine secrets land there)')
        st = json.loads((self.tmp / 'run' / 'status.json').read_text())
        self.assertEqual((st['state'], st['ready'], st['pid']), ('ready', True, child))
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(30), 0)
        self.assertFalse(self.alive(child))
        self.assertFalse(self.alive(grand), 'the child process group is reaped after the child exits')
        self.assertIn('STOPPING=1', self.notify.recv(4096).decode())

    def test_child_failure_propagates_exit_code_and_its_group_is_reaped(self):
        self.mode(exitAfter=1, exitCode=3, grandchild=True)
        p = self.launch()
        self.assertEqual(p.wait(30), 3)
        self.assertFalse(self.alive(int(self.wait_file('grandchild.pid'))), 'a child that exits by itself leaves nothing in its group')

    def test_wrong_chain_never_ready_is_a_failure(self):
        self.mode(chain='0x1')
        p = self.launch()
        self.assertEqual(p.wait(40), 70)
        self.assertFalse(self.alive(int(self.wait_file('child.pid'))))

    def test_tampered_binary_never_starts(self):
        self.mode()
        with open(self.bin, 'a') as f:
            f.write('\n# tampered\n')
        p = self.launch()
        self.assertEqual(p.wait(30), 2)
        self.assertIn('binary hash differs', p.stdout.read())
        self.assertFalse((self.rec / 'child.pid').exists(), 'nothing was executed')

    def test_supervisor_death_kills_the_child(self):
        self.mode()
        p = self.launch()
        self.notify.recv(4096)
        child = int(self.wait_file('child.pid'))
        p.kill()
        p.wait(10)
        end = time.monotonic() + 10
        while time.monotonic() < end and self.alive(child):
            time.sleep(0.05)
        self.assertFalse(self.alive(child), 'PDEATHSIG: the child does not outlive its supervisor')

    def test_term_ignoring_child_is_killed_after_grace(self):
        self.mode(termDelay='ignore')
        sup = self.H.Supervisor(self.H.argv(self.c), self.H.child_env(self.c), self.port, self.H.CHAIN_ID_HEX, stop_timeout=1,
                           ready_timeout=10, nofile=4096, log=lambda m: None)
        import threading
        t = threading.Thread(target=lambda: setattr(self, 'rc', sup.run()))
        t.start()
        end = time.monotonic() + 10
        while time.monotonic() < end and not sup.ready:
            time.sleep(0.05)
        self.assertTrue(sup.ready)
        t0 = time.monotonic()
        sup.stop()
        t.join(15)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual(self.rc, 1, 'killed after the grace period: not a clean stop')
        self.assertFalse(self.alive(int(self.wait_file('child.pid'))))

    def test_preflight_refuses_tmpfs_and_nvme_placement_and_sees_busy_ports(self):
        self.mode()
        self.H.check_binary = lambda c, run_help=False: None   # the stand-in has no real help; the official binary's is tested in test_base_offline.py
        with self.assertRaises(self.H.Refused) as e:
            self.H.preflight(self.c)
        self.assertIn('cannot resolve the datadir backing device', str(e.exception))   # /tmp is tmpfs (RAM)
        scratch = Path(tempfile.mkdtemp(prefix='hp-', dir=os.environ['HOLDER_NVME_SCRATCH']))   # a directory on this machine's NVMe
        try:
            os.chmod(scratch, 0o700)
            c = dict(self.c, datadir=str(scratch))
            with self.assertRaises(self.H.Refused) as e:
                self.H.preflight(c)
            self.assertIn('HDD-backed', str(e.exception))                              # the workspace is on NVMe
        finally:
            shutil.rmtree(scratch)
        self.assertFalse(H.port_in_use(self.port, 'tcp'))
        s = socket.socket()
        s.bind(('127.0.0.1', self.port))
        s.listen(1)
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.bind(('127.0.0.1', 0))
        try:
            self.assertTrue(H.port_in_use(self.port, 'tcp'))
            self.assertTrue(H.port_in_use(u.getsockname()[1], 'udp'))
        finally:
            s.close()
            u.close()


class BInterface(unittest.TestCase):
    """B's committed URL policy (rpc-runtime-composition 61a639f2 network/rpc-identity.mjs, read via git show) accepts the
    holder's proof-source URL as a loopback source; B's runtime additionally refuses its own verifier port (validated
    here by holder.py's verifierPort rule)."""
    def test_b_accepts_the_rendered_proof_source(self):
        repo = Path(os.environ.get('B_REPO', ''))
        if not (repo / '.git').exists() or not shutil.which('node'):
            self.skipTest('B repository or node unavailable')
        tmp = Path(tempfile.mkdtemp(prefix='hb-'))
        try:
            src = subprocess.run(['git', '-C', str(repo), 'show', '61a639f2609d449316422349364a153a851afe95:network/rpc-identity.mjs'],
                                 capture_output=True, check=True).stdout
            (tmp / 'rpc-identity.mjs').write_bytes(src)
            url = json.loads(json.dumps({'u': f"http://127.0.0.1:{H.validate(good())['rpc']['port']}/"}))['u']
            js = ("import('./rpc-identity.mjs').then((m) => { const e = m.rpcEndpoint(process.argv[1]); "
                  "console.log(JSON.stringify({ loopback: e.loopback, port: String(e.port), href: e.url.href })); })")
            r = subprocess.run(['node', '--input-type=module', '-e', js, url], cwd=tmp, capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual((out['loopback'], out['port']), (True, '18545'))
            bad = subprocess.run(['node', '--input-type=module', '-e', js, 'http://203.0.113.9:18545/'], cwd=tmp, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(bad.returncode, 0, 'B refuses plain http to a non-loopback source')
        finally:
            shutil.rmtree(tmp)


if __name__ == '__main__':
    unittest.main(verbosity=2)
