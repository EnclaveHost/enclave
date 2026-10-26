#!/usr/bin/env python3
"""base-forward-sync-stage real-module tests (PREPARED; NOT run by Claude: jobs/root-forward-sync-tests.sh, exact count 8). Run INSIDE the
private recovery-r7 copy carrying the finality-r6 harness, wrapper and producer: the REAL harness (gate_static with the completed-download
receipt, head_checkpoints, read_header/header_hash, gate_watermark) on the r7 fixture's fake reth, the REAL wrapper journal/watermark
functions, and forward_sync.py. The node child is a fake release binary (help text, argv/env capture, a loopback progress RPC); its
labels are never evidence - verify proves the stopped DB. Test seams: OWNER = this uid, no privilege drop, a free progress port, the
wrapper's release pin/coverage/beacon/prune helpers (production values come from chain.json and the pinned release)."""
import json, os, pathlib, signal, socket, subprocess, sys, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, os.environ['FORWARD_SYNC_SRC'])
import test_reanchor_recovery as RR                     # the r6-ported recovery suite: its fixture only (classes not re-exported)
import forward_sync as FS
A, W, P, TA, sha = RR.A, RR.W, RR.P, RR.TA, RR.sha
FS.OWNER = os.getuid()
FL = A.SNAPSHOT_HEAD + 1000
FXF = json.loads(subprocess.run(['node', str(TA.H / 'test/make_fixture.mjs'), str(FL)], capture_output=True, text=True, check=True,
                                env=dict(os.environ, A=TA.ANCHOR.as_uri(), D=(TA.DEPS / 'node_modules/@noble/hashes/sha3.js').as_uri())).stdout)
FAKE = r'''#!/usr/bin/env python3
import http.server, json, os, pathlib, signal, sys, threading
a = sys.argv[1:]; flags = json.loads(pathlib.Path('@FLAGS@').read_text())        # run as /proc/self/fd/N: no path beside argv[0]
if a[-1:] == ['--help']:
    print('\n'.join(flags)); sys.exit(0)
home = pathlib.Path(os.environ['HOME']); (home / 'fake-node.json').write_text(json.dumps({'argv': a, 'env': dict(os.environ)}))
if (home / 'fake-crash').exists():
    sys.exit(3)
port = int(a[a.index('--http.port') + 1])
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['content-length'])); n = int((home / 'fake-finalized').read_text())
        b = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'number': hex(n)}}).encode()
        self.send_response(200); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
s = http.server.HTTPServer(('127.0.0.1', port), H)
signal.signal(signal.SIGTERM, lambda *x: ((home / 'fake-stopped').write_text('1'), os._exit(0)))
s.serve_forever()
'''


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


class ForwardSync(RR.Recovery):
    def setUp(self):
        super().setUp()
        self.fake = self.d / 'fake-base-release'; self.fake.write_text(FAKE.replace('@FLAGS@', str(self.d / 'fake-base-release.flags'))); self.fake.chmod(0o755)
        self.flags = sorted({x for x in FS.node_argv('x', 'd', []) if x.startswith('--')})
        (self.d / 'fake-base-release.flags').write_text(json.dumps(self.flags))
        ports = dict(FS.SYNC_PORTS, http=free_port())
        for obj, k, v in ((FS, 'SYNC_PORTS', ports), (W, 'BASE_RELEASE_PATH', self.fake), (W, 'BASE_RELEASE_SHA256', sha(self.fake.read_bytes())),
                          (W, 'prune_args', lambda *a: []),
                          # r2 fix (root 0605: all 8 errored in the inherited start(): the wrapper compares history_from <= snap, and
                          # this fixture had stubbed history_from_block/state_history_from_block to None module-wide). They are no
                          # longer stubbed: start() AND forward_sync read the SAME real functions over the recovery fixture's config.
                          (W, 'coverage_activation', lambda *a, **k: {'blobSlot': 123}), (W, 'MANIFEST', {'binaries': {}})):
            p = patch.object(obj, k, v); p.start(); self.addCleanup(p.stop)
        self.blobs = [{'blob': 'x'}]
        p = patch.object(W, 'beacon', lambda path: {'message': {'body': {'blob_kzg_commitments': ['c']}}} if 'blocks' in path else self.blobs)
        # r2 fixture seams (fixture-scoped stand-ins; never evidence): the beacon's retained range follows self.blobs (empty = pruned),
        # and the fake reth's checkpoint labels are rendered in the PINNED `db stage-checkpoints get` format forward_sync r2 parses
        ldb = patch.object(FS, 'lighthouse_db_info', lambda: {'anchor': {'oldest_block_slot': '0'}, 'data_info': {'oldest_data_slot': '0' if self.blobs else str(10 ** 12)}})
        ldb.start(); self.addCleanup(ldb.stop)
        NAMES = {'headers': 'Headers', 'bodies': 'Bodies', 'execution': 'Execution', 'merkle-execute': 'MerkleExecute', 'finish': 'Finish'}
        rst = patch.object(FS, 'read_stage_text', lambda base: '\n'.join(f'{NAMES[k]}: StageCheckpoint {{ block_number: {v}, stage_checkpoint: None }}'
                                                                           for k, v in A.head_checkpoints(None, base).items()))
        rst.start(); self.addCleanup(rst.stop)
        p.start(); self.addCleanup(p.stop)

    def scenario(self, rolled_back=True, floor=FL):
        self.launched(); self.assertEqual(self.start(), 'exec'); self.node_ran()
        if rolled_back:
            self.rollback('crash')
        # a FRESH pinned snapshot download into the launch datadir: the fake DB back at the snapshot head (the receipt binds the dir)
        self.state['cp'] = {k: A.SNAPSHOT_HEAD for k in self.state['cp']}; self.state['headersTip'] = A.SNAPSHOT_HEAD; self.write()
        c = A.load_config(self.d / 'cfg.json'); self.fh = A.header_hash(c, FXF['header'])
        os.makedirs(self.store, mode=0o755, exist_ok=True)
        W.watermark_append(self.store, self.uid, W.watermark_entries(self.store, self.uid, self.top), floor, self.fh, 'finality-proof', 'ab' * 32, 'at', self.top)
        self.root = self.d / 'recovery'; self.root.mkdir(mode=0o755); self.dd = pathlib.Path(c['datadir'])
        (self.dd / 'reth.toml').exists() or (self.dd / 'reth.toml').write_text('[static_files]\nblocks_per_file = 500000\n')
        self.cfgf = self.d / 'forward-sync.json'
        self.cfgf.write_text(json.dumps({'format': FS.FORMAT, 'recoveryRoot': str(self.root), 'harnessConfig': str(self.d / 'cfg.json'),
                                         'productionLaunchDir': str(self.out), 'watermarkStore': str(self.store), 'serviceUser': 'nobody', 'targetMarginBlocks': 10}))
        self.cfgf.chmod(0o644)

    def op(self, name, **kw):
        return getattr(FS, name)(str(self.cfgf), A=A, W=W, top=self.top, **kw)

    def fsrefused(self, code, name, **kw):
        with self.assertRaises(FS.Refused) as cm:
            self.op(name, **kw)
        self.assertEqual(cm.exception.code, code, str(cm.exception))

    def events(self):
        return [r['event'] for r in FS.journal(self.root)]

    def synced_db(self, n=FL + 10, header=None):
        self.state['cp'] = {k: n for k in self.state['cp']}; self.state['headersTip'] = n
        self.state['headers'][str(FL)] = header or FXF['header']; self.write()

    def runs(self):
        (self.dd / 'fake-finalized').write_text(str(FL + 10)); return self.op('run', user=False, poll=0.2)

    def test_authenticated_isolated_run_stops_at_target(self):
        self.scenario(); self.op('authenticate')
        self.assertEqual(self.runs(), 0); self.assertEqual(self.events(), ['authenticated', 'started', 'stopped'])
        self.assertEqual(FS.journal(self.root)[-1]['evidence']['reason'], 'target'); self.assertTrue((self.dd / 'fake-stopped').exists())
        rec = json.loads((self.dd / 'fake-node.json').read_text()); argv = rec['argv']
        self.assertEqual(argv[:3], ['--chain', 'mainnet', 'rpc']); self.assertEqual(argv[argv.index('--datadir') + 1], str(self.dd))
        ports = {int(argv[i + 1]) for i, x in enumerate(argv) if x.endswith('port') or x in ('--p2p.listen.tcp', '--p2p.listen.udp')}
        self.assertFalse(ports & FS.PRODUCTION_PORTS, 'no production / readiness / lease / L1 port')
        for absent in ('--rpc.forwarding-endpoint', '--bootstrap.anchor'):
            self.assertNotIn(absent, argv)
        self.assertEqual((argv[argv.index('--l1-eth-rpc') + 1], argv[argv.index('--l1-beacon') + 1]), FS.L1)
        self.assertEqual(argv[argv.index('--http.addr') + 1], '127.0.0.1'); self.assertEqual(argv[argv.index('--http.api') + 1], 'eth')
        self.assertEqual(set(rec['env']) - {'PWD', 'SHLVL', '_', 'LC_CTYPE'}, {'PATH', 'LANG', 'HOME', 'TMPDIR', 'BASE_NODE_L1_TRUST_RPC'})

    def test_authenticate_refuses_live_production_moved_db_floor_not_above_and_missing_blobs(self):
        self.scenario(rolled_back=False); self.fsrefused('production_live', 'authenticate')
        self.rollback('crash'); self.blobs = []; self.fsrefused('blob_history_missing', 'authenticate'); self.blobs = [{'blob': 'x'}]
        self.state['cp'] = {k: A.SNAPSHOT_HEAD + 5 for k in self.state['cp']}; self.write(); self.fsrefused('not_snapshot', 'authenticate')
        self.assertEqual(self.events(), [])

    def test_floor_not_above_the_snapshot_uses_the_normal_reanchor(self):
        self.scenario(floor=A.SNAPSHOT_HEAD); self.fsrefused('not_below_floor', 'authenticate')

    def test_a_flag_absent_from_the_pinned_binary_help_never_runs(self):
        self.scenario(); self.op('authenticate')
        (self.d / 'fake-base-release.flags').write_text(json.dumps([f for f in self.flags if f != '--upgrade-signal.mode']))
        self.fsrefused('capability', 'run', user=False, poll=0.2); self.assertEqual(self.events(), ['authenticated'])

    def test_crash_is_recorded_and_the_retry_resumes(self):
        self.scenario(); self.op('authenticate'); (self.dd / 'fake-crash').write_text('1')
        self.assertEqual(self.runs(), 1); self.assertEqual(FS.journal(self.root)[-1]['evidence']['reason'], 'exited')
        (self.dd / 'fake-crash').unlink(); self.assertEqual(self.runs(), 0)
        self.assertEqual(self.events(), ['authenticated', 'started', 'stopped', 'started', 'stopped'])

    def test_verify_proves_the_floor_block_then_handoff_and_the_floor_stays(self):
        self.scenario(); self.op('authenticate'); self.runs()
        self.synced_db(n=FL - 5); self.fsrefused('below_floor', 'verify')
        self.synced_db(header=dict(FXF['header'], parentHash='0x' + '42' * 32)); self.fsrefused('floor_conflict', 'verify')
        self.synced_db(); self.op('verify'); self.op('handoff'); self.assertEqual(self.events()[-2:], ['synced', 'handed-off'])
        with self.assertRaisesRegex(A.Refused, '^watermark_below'):                    # the re-anchor still needs N >= the retained floor
            A.gate_watermark({'N': FL - 1, 'reanchor': {'watermarkStore': str(self.store)}}, None)

    def test_db_changed_after_verify_refuses_the_handoff(self):
        self.scenario(); self.op('authenticate'); self.runs(); self.synced_db(); self.op('verify')
        (self.dd / 'db/mdbx.dat').write_bytes(b'written after verify'); self.fsrefused('datadir_changed', 'handoff')

    def test_abandon_quarantines_the_datadir_and_keeps_the_floor(self):
        self.scenario(); self.op('authenticate'); before = W.watermark_entries(self.store, self.uid, self.top)
        r = self.op('abandon'); self.assertFalse(self.dd.exists()); self.assertTrue(pathlib.Path(r['evidence']['quarantined']).is_dir())
        self.assertEqual(W.watermark_entries(self.store, self.uid, self.top), before); self.fsrefused('transition', 'run', user=False)


for _n in [n for n in dir(RR.Recovery) if n.startswith('test_')]:     # only this suite's own tests
    setattr(ForwardSync, _n, None)


if __name__ == '__main__':
    unittest.main()
