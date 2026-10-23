"""Unit tests for l1pair.py: validation refusals, exact rendering, hidden-default checks, reuse pins, checkpoint
inspection, JWT shape, and the readiness gate's failure handling. No client binary runs here (see test_reth_offline.py
and test_base_l1_offline.py for the real-binary tests). Synthetic SSZ bytes are labelled as such."""
import copy, glob, hashlib, importlib.util, json, os, re, socket, subprocess, sys, tempfile, time, unittest, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
ROOT = PKG.parent
spec = importlib.util.spec_from_file_location('l1pair', os.environ.get('L1PAIR_UNDER_TEST', str(PKG / 'l1pair.py')))
L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
EXAMPLE = json.loads((PKG / 'l1pair.example.json').read_text())
RETH_HELP = sorted(glob.glob(str(ROOT / 'evidence' / 'reth-help-*' / 'node-help.txt')))[-1]
LH_HELP = ROOT / 'evidence/sources/lighthouse-v8.3.2/book/src/help_bn.md'
GENESIS_ZIP = ROOT / 'evidence/sources/lighthouse-v8.3.2/common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip'
ROOT_HEX = '0x' + '11' * 32
EPOCH = 430000


def good():
    c = copy.deepcopy(EXAMPLE)
    assert c['consensus']['binary']['sha256'] == L.PINS['consensus']['binarySha256']
    k = c['consensus']['checkpoint']
    k.update(stateSha256='cd' * 32, blockSha256='ef' * 32, wss=f'{ROOT_HEX}:{EPOCH}',
             provenance=[{'source': 'own pair export 2026-10-20', 'observedRoot': ROOT_HEX, 'observedAt': '2026-10-20T00:00:00Z'},
                         {'source': 'independent operator B', 'observedRoot': ROOT_HEX, 'observedAt': '2026-10-20T00:05:00Z'}])
    return c


def cache(data, meta=64 << 20):
    return {'mechanism': 'dm-cache', 'mode': 'writethrough', 'dataImagePath': '/vm/l1c/d.img', 'dataBytes': data,
            'metadataImagePath': '/vm/l1c/m.img', 'metadataBytes': meta, 'blockBytes': 262144}


def refused(test, mutate, match):
    c = good(); mutate(c)
    with test.assertRaises(L.Refused) as cm:
        L.validate(c)
    test.assertRegex(str(cm.exception), match)


class Validation(unittest.TestCase):
    def test_example_as_shipped_is_refused_until_pins_are_recorded(self):
        with self.assertRaises(L.Refused) as cm:
            L.validate(EXAMPLE)
        self.assertIn('consensus.checkpoint', str(cm.exception))

    def test_good_config_validates(self):
        c = L.validate(good())
        self.assertEqual(c['execution']['datadir'], '/srv/enclave-l1-pair/data/el')
        self.assertEqual(c['consensus']['datadir'], '/srv/enclave-l1-pair/data/cl')
        self.assertEqual(c['storage']['nvmeAccounting']['holderBytes'], 0)

    def test_refusals(self):
        cases = [
            ('format', lambda c: c.update(format='x'), 'format'),
            ('network', lambda c: c.update(network='sepolia'), 'mainnet'),
            ('el client', lambda c: c['execution'].update(client='geth'), 'reth'),
            ('cl client', lambda c: c['consensus'].update(client='prysm'), 'lighthouse'),
            ('admin api', lambda c: c['execution'].update(httpApi=['eth', 'admin']), 'httpApi'),
            ('debug api', lambda c: c['execution'].update(httpApi=['eth', 'debug']), 'httpApi'),
            ('no eth api', lambda c: c['execution'].update(httpApi=['net']), 'httpApi'),
            ('receipts full default', lambda c: c['execution'].update(receiptsRetentionBlocks=10064), 'receiptsRetentionBlocks'),
            ('receipts one short', lambda c: c['execution'].update(receiptsRetentionBlocks=139999), 'receiptsRetentionBlocks'),
            ('custody default', lambda c: c['consensus'].update(custody='default'), 'semi-supernode or supernode'),
            ('nat any', lambda c: c['p2p'].update(nat='any'), 'ipinfo'),
            ('nat upnp', lambda c: c['p2p'].update(nat='upnp'), 'ipinfo'),
            ('nat publicip', lambda c: c['p2p'].update(nat='publicip'), 'ipinfo'),
            ('nat extip loopback', lambda c: c['p2p'].update(nat='extip:127.0.0.1'), 'extip'),
            ('dns discovery implicit', lambda c: c['p2p'].pop('dnsDiscovery'), 'dnsDiscovery'),
            ('listen loopback', lambda c: c['p2p'].update(listenIp='127.0.0.1'), 'listenIp'),
            ('dup tcp port', lambda c: c['consensus'].update(httpPort=18645), 'distinct'),
            ('avoid port', lambda c: c['execution'].update(httpPort=18545), 'co-resident'),
            ('verifier port', lambda c: c['consensus'].update(httpPort=8545), 'co-resident'),
            ('jwt outside etc', lambda c: c.update(engineAuthPath='/srv/enclave-l1-pair/jwt.hex'), '/etc'),
            ('no co-resident list', lambda c: c.update(otherServicePaths=[]), 'otherServicePaths'),
            ('mount inside holder', lambda c: c['storage'].update(mountPoint='/srv/enclave-base-holder/l1'), 'overlaps'),
            ('origin inside holder dir', lambda c: c['storage']['origin'].update(imagePath='/mnt/usb/enclave-base-holder/l1.img'), 'overlaps'),
            ('mount root', lambda c: c['storage'].update(mountPoint='/'), 'dedicated'),
            ('mount array root', lambda c: c['storage'].update(mountPoint='/mnt/usb'), 'dedicated'),
            ('mount tmp', lambda c: c['storage'].update(mountPoint='/tmp/l1'), 'inside /tmp'),
            ('mount nvme vm', lambda c: c['storage'].update(mountPoint='/vm/l1'), 'inside /vm'),
            ('origin not on array', lambda c: c['storage']['origin'].update(imagePath='/vm/l1/origin.img'), 'HDD array'),
            ('origin too small', lambda c: c['storage']['origin'].update(bytes=10 ** 12), 'origin.bytes'),
            ('wrong reth release', lambda c: c['execution']['binary'].update(release='v2.7.0'), 'release/commit'),
            ('wrong lh commit', lambda c: c['consensus']['binary'].update(commit='0' * 40), 'release/commit'),
            ('wrong tarball', lambda c: c['execution']['binary'].update(releaseTarballSha256='0' * 64), 'asset digest'),
            ('wrong reth binary', lambda c: c['execution']['binary'].update(sha256='0' * 64), 'reviewed binary'),
            ('wrong lighthouse binary', lambda c: c['consensus']['binary'].update(sha256='0' * 64), 'reviewed binary'),
            ('wss malformed', lambda c: c['consensus']['checkpoint'].update(wss='0x12:1'), 'wss'),
            ('wss pre-fulu', lambda c: c['consensus']['checkpoint'].update(wss=f'{ROOT_HEX}:100'), 'Fulu'),
            ('one provenance', lambda c: c['consensus']['checkpoint']['provenance'].pop(), '>= 2'),
            ('provenance root differs', lambda c: c['consensus']['checkpoint']['provenance'][1].update(observedRoot='0x' + '22' * 32), 'does not equal'),
            ('provenance same source', lambda c: c['consensus']['checkpoint']['provenance'][1].update(source='OWN PAIR EXPORT 2026-10-20'), 'distinct'),
            ('state sha placeholder', lambda c: c['consensus']['checkpoint'].update(stateSha256='RECORD'), 'stateSha256'),
            ('checkpoint inside datadir', lambda c: c['consensus']['checkpoint'].update(statePath='/srv/enclave-l1-pair/data/cl/s.ssz'), 'outside the beacon datadir'),
            ('genesis sync', lambda c: c['consensus'].update(checkpoint={'mode': 'genesis'}), 'DO NOT use on mainnet'),
            ('url without ack', lambda c: c['consensus'].update(checkpoint={'mode': 'url', 'url': 'https://bn.example/', 'wss': f'{ROOT_HEX}:{EPOCH}',
                                                                           'provenance': c['consensus']['checkpoint']['provenance'],
                                                                           'oneTimeBootstrapUrlAcknowledged': False}), 'oneTimeBootstrapUrlAcknowledged'),
            ('url plain http', lambda c: c['consensus'].update(checkpoint={'mode': 'url', 'url': 'http://bn.example/', 'wss': f'{ROOT_HEX}:{EPOCH}',
                                                                          'provenance': c['consensus']['checkpoint']['provenance'],
                                                                          'oneTimeBootstrapUrlAcknowledged': True}), 'https'),
            ('writeback cache', lambda c: c['storage'].update(nvmeBudget={'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}, cache={'mechanism': 'dm-cache', 'mode': 'writeback', 'dataImagePath': '/vm/l1c/d.img',
                                                                     'dataBytes': 1 << 30, 'metadataImagePath': '/vm/l1c/m.img',
                                                                     'metadataBytes': 64 << 20, 'blockBytes': 262144}), 'writethrough'),
            ('cache alone over target', lambda c: c['storage'].update(nvmeBudget={'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}, cache=cache(200_000_000_000 // 262144 * 262144, meta=256 << 20)), 'operational target'),
            ('cache without ledger', lambda c: c['storage'].update(cache=cache(2 << 30)), 'nvmeBudget'),
            ('ledger not canonical', lambda c: c['storage'].update(nvmeBudget={'ledgerPath': '/etc/my-own-ledger.json', 'reservationId': 'x'}, cache=cache(2 << 30)), 'canonical shared ledger'),
            ('holder reservation reused', lambda c: c['storage'].update(nvmeBudget={'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'base-holder-dm-cache'}, cache=cache(2 << 30)), 'OWN ledger reservation'),
            ('ledger with no cache', lambda c: c['storage'].update(nvmeBudget={'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}), 'applies only to a cache'),
            ('old inventory field', lambda c: c['storage'].update(nvmeInventoryPath='/etc/enclave-base-holder/nvme-cache-inventory.tsv'), 'unknown field'),
            ('el memory tiny', lambda c: c['limits']['execution'].update(memoryMaxBytes=1 << 30), 'memoryMaxBytes'),
            ('co-resident implicit', lambda c: c['limits'].pop('coResidentMemoryBytes'), 'coResidentMemoryBytes'),
            ('root user', lambda c: c.update(serviceUser='root'), 'serviceUser'),
            ('unknown key', lambda c: c.update(checkpointSyncUrl='https://x/'), 'unknown|not allowed|config'),
        ]
        for name, mut, match in cases:
            with self.subTest(name):
                refused(self, mut, match)

    def test_boundaries_accepted(self):
        c = good(); c['execution']['receiptsRetentionBlocks'] = L.MIN_RECEIPTS
        L.validate(c)
        c = good(); c['storage']['nvmeBudget'] = {'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}; c['storage']['cache'] = cache(45 << 30)
        v = L.validate(c)
        r = L.budget_reservation(v)
        self.assertEqual((r['id'], r['owner'], r['maxBytes']), ('l1-pair-dm-cache', 'enclave-l1-pair', (45 << 30) + (64 << 20) + (64 << 20)))
        s = L.storage_script(v)
        self.assertIn("LEDGER='/etc/enclave-rpc-cache/nvme-cache-budget.json'", s); self.assertIn("RESERVATION='l1-pair-dm-cache'", s)
        self.assertIn("MECHANISM='dm-cache'", s)
        with tempfile.TemporaryDirectory() as d:
            self.assertIn('nvme-budget-reservation.json', L.render(v, Path(d) / 'o')['files'])
        c = good(); c['consensus']['checkpoint'] = {'mode': 'resume'}
        self.assertNotIn('--checkpoint-state', L.cl_argv(L.validate(c)))
        c = good(); c['p2p']['nat'] = 'extip:203.0.113.7'
        a = L.cl_argv(L.validate(c))
        self.assertEqual(a[a.index('--enr-address') + 1], '203.0.113.7')


class Rendering(unittest.TestCase):
    def setUp(self):
        self.c = L.validate(good())

    def test_exact_el_argv(self):
        self.assertEqual(L.el_argv(self.c), [
            '/opt/enclave-l1-pair/bin/reth', 'node', '--chain', 'mainnet', '--datadir', '/srv/enclave-l1-pair/data/el',
            '--full', '--prune.receipts.distance', '140000',
            '--http', '--http.addr', '127.0.0.1', '--http.port', '18645', '--http.api', 'eth,net,web3', '--rpc.max-connections', '64',
            '--authrpc.addr', '127.0.0.1', '--authrpc.port', '18651', '--authrpc.jwtsecret', '/etc/enclave-l1-pair/jwt.hex',
            '--ipcdisable', '--addr', '0.0.0.0', '--port', '30313', '--discovery.addr', '0.0.0.0', '--discovery.port', '30313',
            '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', '30314', '--nat', 'none',
            '--txpool.disable-transactions-backup',
            '--log.file.directory', '/srv/enclave-l1-pair/data/el/logs', '--log.file.max-files', '5', '--disable-dns-discovery',
            '--disable-tx-gossip', '--txpool.no-local-transactions-propagation'])

    def test_tx_broadcast_is_explicit_opt_in(self):
        c = good(); c['execution'].pop('txBroadcast')
        self.assertEqual(L.validate(c)['execution']['txBroadcast'], 'disabled')       # absent = disabled
        c = good(); c['execution']['txBroadcast'] = 'local-raw-propagate'
        e = L.el_argv(L.validate(c))
        self.assertNotIn('--disable-tx-gossip', e); self.assertNotIn('--txpool.no-local-transactions-propagation', e)
        self.assertEqual([x for x in L.el_argv(self.c) if x not in ('--disable-tx-gossip', '--txpool.no-local-transactions-propagation')], e)
        for x in (e, L.el_argv(self.c)):
            self.assertNotIn('--rpc.forwarder', x)
            self.assertEqual(x[x.index('--http.addr') + 1], '127.0.0.1')
        for bad in ('enabled', 'auto', True, 'forward'):
            c = good(); c['execution']['txBroadcast'] = bad
            with self.assertRaisesRegex(L.Refused, 'txBroadcast'):
                L.validate(c)
        help_ = Path(RETH_HELP).read_text()
        for f in ('--disable-tx-gossip', '--txpool.no-local-transactions-propagation', '--txpool.disable-transactions-backup'):
            self.assertTrue(L._help_has(help_, f), f)

    def test_exact_cl_argv(self):
        self.assertEqual(L.cl_argv(self.c), [
            '/opt/enclave-l1-pair/bin/lighthouse', 'beacon_node', '--network', 'mainnet', '--datadir', '/srv/enclave-l1-pair/data/cl',
            '--http', '--http-address', '127.0.0.1', '--http-port', '15052',
            '--execution-endpoint', 'http://127.0.0.1:18651', '--execution-jwt', '/etc/enclave-l1-pair/jwt.hex',
            '--listen-address', '0.0.0.0', '--port', '9310', '--quic-port', '9311', '--disable-upnp', '--target-peers', '100',
            '--semi-supernode', '--prune-blobs', 'true', '--blob-prune-margin-epochs', '0',
            '--checkpoint-state', '/srv/enclave-l1-pair/anchor/state.ssz', '--checkpoint-block', '/srv/enclave-l1-pair/anchor/block.ssz',
            '--wss-checkpoint', f'{ROOT_HEX}:{EPOCH}'])

    def test_every_reth_flag_is_in_the_executed_binary_help(self):
        text = Path(RETH_HELP).read_text()
        for f in [x for x in L.el_argv(self.c) if x.startswith('--')]:
            self.assertTrue(L._help_has(text, f), f)
        self.assertIn('Reth Version: 2.8.0', Path(RETH_HELP).with_name('version.txt').read_text())

    def test_every_lighthouse_flag_is_in_the_pinned_source_help(self):   # SOURCE-ONLY until the binary is extracted
        text = LH_HELP.read_text()
        c = good(); c['p2p']['nat'] = 'extip:203.0.113.7'
        for cfg in (self.c, L.validate(c)):
            for f in [x for x in L.cl_argv(cfg) if x.startswith('--')]:
                self.assertTrue(L._help_has(text, f), f)
        c = good(); c['consensus']['custody'] = 'supernode'
        self.assertIn('--supernode', L.cl_argv(L.validate(c)))
        self.assertTrue(L._help_has(text, '--supernode'))

    def test_no_hidden_external_default(self):
        for a in (L.el_argv(self.c), L.cl_argv(self.c)):
            urls = [x for x in a if '://' in x]
            self.assertTrue(all(u.startswith('http://127.0.0.1:') for u in urls), urls)
        a = L.cl_argv(self.c)
        self.assertNotIn('--checkpoint-sync-url', a); self.assertNotIn('--genesis-state-url', a)
        self.assertNotIn('--allow-insecure-genesis-sync', a); self.assertNotIn('--ignore-ws-check', a); self.assertIn('--disable-upnp', a)
        self.assertNotIn('--builder', a); self.assertNotIn('--monitoring-endpoint', a)
        e = L.el_argv(self.c)
        self.assertEqual(e[e.index('--nat') + 1], 'none'); self.assertNotIn('--ethstats', e)
        self.assertIn('--disable-tx-gossip', e)
        for flag, want in (('--http.addr', '127.0.0.1'), ('--authrpc.addr', '127.0.0.1')):
            self.assertEqual(e[e.index(flag) + 1], want)
        self.assertEqual(a[a.index('--http-address') + 1], '127.0.0.1')
        # the source-confirmed reason --nat must be explicit (reth v2.8.0 crates/net/nat/src/lib.rs)
        nat = (ROOT / 'evidence/sources/reth-v2.8.0/crates/net/nat/src/lib.rs').read_text()
        self.assertIn('"https://ipinfo.io/ip", "https://icanhazip.com", "https://ifconfig.me"', nat)
        self.assertIn('NatResolver::Any | NatResolver::Upnp | NatResolver::PublicIp => resolve_external_ip()', nat)
        c = good(); c['consensus']['checkpoint'] = {'mode': 'url', 'url': 'https://bn.example/', 'wss': f'{ROOT_HEX}:{EPOCH}',
                                                    'provenance': good()['consensus']['checkpoint']['provenance'],
                                                    'oneTimeBootstrapUrlAcknowledged': True}
        a = L.cl_argv(L.validate(c))
        self.assertEqual(a[a.index('--checkpoint-sync-url') + 1], 'https://bn.example/')
        self.assertIn('--wss-checkpoint', a)

    def test_closed_env(self):
        for side in ('el', 'cl'):
            env = L.child_env(self.c, side)
            self.assertEqual(sorted(env), ['HOME', 'LANG', 'PATH', 'TMPDIR'])
            self.assertTrue(env['TMPDIR'].startswith('/srv/enclave-l1-pair/'))

    def test_units(self):
        for side in ('el', 'cl'):
            u = L.unit_text(self.c, side, '/opt/enclave-l1-pair/l1pair.py', '/etc/enclave-l1-pair/l1pair.json')
            for line in ('Type=notify', 'KillMode=mixed', 'MemorySwapMax=0', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
                         'ReadWritePaths=/srv/enclave-l1-pair', 'Requires=enclave-l1-pair-storage.service', 'PrivateTmp=yes',
                         f'ExecStart=/usr/bin/python3 -I /opt/enclave-l1-pair/l1pair.py run-{side} /etc/enclave-l1-pair/l1pair.json'):
                self.assertIn(line, u.splitlines(), (side, line))
        self.assertIn('MemoryMax=17179869184', L.unit_text(self.c, 'el', 'x', 'y'))
        self.assertIn('MemoryMax=12884901888', L.unit_text(self.c, 'cl', 'x', 'y'))
        self.assertIn('enclave-l1-el.service', L.unit_text(self.c, 'cl', 'x', 'y').split('[Service]')[0])

    def test_storage_script_is_S_template_with_this_pairs_constants(self):
        s = L.storage_script(self.c)
        tpl = (PKG / 'vendor/holder/holder-storage.sh.in').read_text()
        head, tail = tpl.split('@CONSTANTS@')
        self.assertTrue(s.startswith(head) and s.endswith(tail))
        consts = s[len(head):len(s) - len(tail)]
        self.assertIn("NAME='enclave-l1-pair'", consts); self.assertIn("MNT='/srv/enclave-l1-pair'", consts)
        self.assertIn("ORIGIN='/mnt/usb/enclave-l1-pair/origin.img'", consts); self.assertIn("MECHANISM='none'", consts)
        self.assertIn("LEDGER=''", consts); self.assertIn("RESERVATION=''", consts)
        self.assertIn("BUDGET_TOOL='/opt/enclave-l1-pair/vendor/holder/budget.py'", consts)
        names = set(re.findall(r'^([A-Z_]+)=', consts, re.M))
        used = set(re.findall(r'\$\{?([A-Z_]{2,})', tail)) - {'EXIT'}
        self.assertTrue(used <= names | {'O', 'D', 'M', 'DEV', 'REMOVE_MAPPING', 'H', 'OTHER', 'TOTAL', 'ALLOC', 'MAPPED', 'MOUNTED', 'CREATED', 'ATTACHED'}, used - names)
        with tempfile.TemporaryDirectory() as d:
            self.assertNotIn('nvme-budget-reservation.json', L.render(self.c, Path(d) / 'o')['files'])
        with tempfile.NamedTemporaryFile('w', suffix='.sh') as f:
            f.write(s); f.flush()
            self.assertEqual(subprocess.run(['bash', '-n', f.name]).returncode, 0)

    def test_vendor_files_match_their_pins(self):
        v = json.loads((PKG / 'vendor/VENDOR.json').read_text())
        self.assertIn('92b71784c9452056eeeb6a97b8e1fcb8ef1815ca', v['source'])
        for rel, sha in v['files'].items():
            self.assertEqual(hashlib.sha256((PKG / 'vendor' / rel).read_bytes()).hexdigest(), sha, rel)

    def test_render(self):
        with tempfile.TemporaryDirectory() as d:
            m = L.render(self.c, Path(d) / 'out')
            for name, sha in m['files'].items():
                p = Path(d) / 'out' / name
                self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), sha)
                self.assertEqual(p.stat().st_mode & 0o077, 0, name)
            frag = json.loads((Path(d) / 'out/holder-l1-fragment.json').read_text())
            self.assertEqual(frag['l1'], {'executionRpc': 'http://127.0.0.1:18645/', 'beacon': 'http://127.0.0.1:15052/', 'trustRpc': False})
            # S's committed URL policy accepts the fragment as self-hosted loopback L1
            self.assertEqual(L.H.l1_url('l1.executionRpc', frag['l1']['executionRpc']), ('http://127.0.0.1:18645/', True))
            self.assertEqual(L.H.l1_url('l1.beacon', frag['l1']['beacon']), ('http://127.0.0.1:15052/', True))


def synthetic_state(slot, gvr=None, gtime=None):
    """SYNTHETIC SSZ prefix (not a real state): genesis_time, genesis_validators_root, slot."""
    return (gtime if gtime is not None else L.MAIN['clGenesisTime']).to_bytes(8, 'little') + \
        bytes.fromhex((gvr or L.MAIN['clGenesisValidatorsRoot'])[2:]) + slot.to_bytes(8, 'little') + b'\0' * 64


def synthetic_block(slot):
    """SYNTHETIC SignedBeaconBlock SSZ prefix: offset 100, zero signature, message.slot."""
    return (100).to_bytes(4, 'little') + b'\0' * 96 + slot.to_bytes(8, 'little') + b'\0' * 64


class Checkpoint(unittest.TestCase):
    def test_inspect_reads_the_real_mainnet_genesis_state(self):
        with tempfile.TemporaryDirectory() as d:
            s = Path(d) / 'g.ssz'
            s.write_bytes(zipfile.ZipFile(GENESIS_ZIP).read('genesis.ssz'))
            b = Path(d) / 'b.ssz'; b.write_bytes(synthetic_block(0))
            h = L.checkpoint_inspect(s, b)
            self.assertEqual((h['genesisTime'], h['genesisValidatorsRoot'], h['stateSlot']),
                             (L.MAIN['clGenesisTime'], L.MAIN['clGenesisValidatorsRoot'], 0))

    def _cfg(self, d, state, block, epoch):
        sp, bp = Path(d) / 'state.ssz', Path(d) / 'block.ssz'
        sp.write_bytes(state); bp.write_bytes(block); os.chmod(sp, 0o640); os.chmod(bp, 0o640)
        c = L.validate(good())
        c['consensus']['checkpoint'].update(statePath=str(sp), blockPath=str(bp), epoch=epoch,
                                            stateSha256=hashlib.sha256(state).hexdigest(), blockSha256=hashlib.sha256(block).hexdigest())
        return c

    def test_check_checkpoint(self):
        now = time.time()
        epoch = int((now - L.MAIN['clGenesisTime']) // 384) - 30       # ~3 h old
        slot = epoch * 32
        with tempfile.TemporaryDirectory() as d:
            self.assertIn('epoch-boundary', L.check_checkpoint(self._cfg(d, synthetic_state(slot), synthetic_block(slot), epoch), now))
        bad = [('not boundary', synthetic_state(slot + 1), synthetic_block(slot), epoch, 'epoch boundary'),
               ('other chain', synthetic_state(slot, gvr='0x' + '33' * 32), synthetic_block(slot), epoch, 'not Ethereum mainnet'),
               ('epoch mismatch', synthetic_state(slot), synthetic_block(slot), epoch + 1, '!= wss epoch'),
               ('block newer', synthetic_state(slot), synthetic_block(slot + 5), epoch, 'newer than the state'),
               ('stale', synthetic_state(slot - 32 * 225 * 15), synthetic_block(slot - 32 * 225 * 15), epoch - 225 * 15, 'days old'),
               ('future', synthetic_state(slot + 32 * 100), synthetic_block(slot + 32 * 100), epoch + 100, 'future')]
        for name, st, bl, ep, match in bad:
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                with self.assertRaisesRegex(L.Refused, match):
                    L.check_checkpoint(self._cfg(d, st, bl, ep), now)
        with tempfile.TemporaryDirectory() as d:
            c = self._cfg(d, synthetic_state(slot), synthetic_block(slot), epoch)
            c['consensus']['checkpoint']['stateSha256'] = '0' * 64
            with self.assertRaisesRegex(L.Refused, 'recorded sha256'):
                L.check_checkpoint(c, now)
        with tempfile.TemporaryDirectory() as d:
            c = self._cfg(d, synthetic_state(slot), synthetic_block(slot), epoch)
            os.chmod(c['consensus']['checkpoint']['statePath'], 0o666)
            with self.assertRaisesRegex(L.Refused, 'writable'):
                L.check_checkpoint(c, now)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x'; p.write_bytes(b'\0' * 200)
            with self.assertRaisesRegex(L.Refused, 'offset'):
                L.checkpoint_inspect(p, p)


class Jwt(unittest.TestCase):
    def test_jwt_shape_and_mode(self):
        c = L.validate(good())
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'jwt.hex'; c['engineAuthPath'] = str(p)
            p.write_text('ab' * 32 + '\n'); os.chmod(p, 0o640)
            self.assertIn('jwt', L.check_jwt(c, require_root=False))
            if os.geteuid() != 0:                     # the file is ours, not root's
                with self.assertRaisesRegex(L.Refused, 'owned by root'):
                    L.check_jwt(c, require_root=True)
            os.chmod(p, 0o644)
            with self.assertRaisesRegex(L.Refused, '0640'):
                L.check_jwt(c, require_root=False)
            os.chmod(p, 0o600); p.write_text('ab' * 31)
            with self.assertRaisesRegex(L.Refused, '32 bytes'):
                L.check_jwt(c, require_root=False)
            q = Path(d) / 'link'; q.symlink_to(p); c['engineAuthPath'] = str(q)
            with self.assertRaisesRegex(L.Refused, 'regular file'):
                L.check_jwt(c, require_root=False)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


class StandIns:
    """STAND-INS (not reth, not lighthouse): loopback HTTP servers answering exactly the gate's probes, used ONLY to
    test the gate's logic. Real-binary behaviour is in test_reth_offline.py."""
    def __init__(self):
        import threading
        from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
        now = int(time.time())
        self.el = {'eth_chainId': '0x1', 'eth_syncing': False, 'genesis': L.MAIN['elGenesisHash'],
                   'latest': {'number': hex(1000), 'timestamp': hex(now - 5), 'hash': '0x' + 'aa' * 32},
                   'finalized': {'number': hex(936), 'timestamp': hex(now - 800), 'hash': '0x' + 'bb' * 32},
                   'byNumber': {100: '0x' + 'cc' * 32}, 'receipts': {100: []}}
        self.cl = {'gvr': L.MAIN['clGenesisValidatorsRoot'], 'deposit': '1', 'fulu': '411392', 'version': 'Lighthouse/v8.3.2-a376def/x86_64-linux',
                   'syncing': {'is_syncing': False, 'is_optimistic': False, 'el_offline': False, 'head_slot': '5000'},
                   'custody': '64', 'payload': {'block_number': '100', 'block_hash': '0x' + 'cc' * 32}, 'blobSlot': 4990, 'blobs': 3, 'served': 3}
        me = self

        class EL(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                q = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                m, pr, e = q['method'], q['params'], me.el
                if m == 'eth_getBlockByNumber':
                    tag = pr[0]
                    res = {'hash': e['genesis']} if tag == '0x0' else e.get(tag) if tag in ('latest', 'finalized') else \
                        ({'hash': e['byNumber'][int(tag, 16)]} if int(tag, 16) in e['byNumber'] else None)
                elif m == 'eth_getBlockReceipts':
                    res = e['receipts'].get(int(pr[0], 16))
                else:
                    res = e[m]
                b = json.dumps({'jsonrpc': '2.0', 'id': q['id'], 'result': res}).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

        class CL(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                k, path = me.cl, self.path.split('?')[0]
                blob_block = {'message': {'slot': str(k['blobSlot']), 'body': {'blob_kzg_commitments': ['0x00'] * k['blobs'], 'execution_payload': k['payload']}}}
                routes = {'/eth/v1/beacon/genesis': {'data': {'genesis_validators_root': k['gvr'], 'genesis_time': str(L.MAIN['clGenesisTime'])}},
                          '/eth/v1/config/spec': {'data': {'DEPOSIT_CHAIN_ID': k['deposit'], 'SECONDS_PER_SLOT': '12', 'FULU_FORK_EPOCH': k['fulu']}},
                          '/eth/v1/node/version': {'data': {'version': k['version']}},
                          '/eth/v1/node/syncing': {'data': k['syncing']},
                          '/eth/v1/node/identity': {'data': {'metadata': {'custody_group_count': k['custody']}}},
                          '/eth/v2/beacon/blocks/head': {'data': {'message': {'body': {'execution_payload': k['payload']}}}},
                          '/eth/v1/beacon/headers/head': {'data': {'header': {'message': {'slot': '5000'}}}},
                          f"/eth/v2/beacon/blocks/{k['blobSlot']}": {'data': blob_block}}
                if k['served'] is not None:
                    routes[f"/eth/v1/beacon/blobs/{k['blobSlot']}"] = {'data': ['0x00'] * k['served']}
                body = routes.get(path)
                b = json.dumps(body).encode() if body is not None else b'{"code":404}'
                self.send_response(200 if body is not None else 404); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        self.servers = [ThreadingHTTPServer(('127.0.0.1', 0), EL), ThreadingHTTPServer(('127.0.0.1', 0), CL)]
        for s in self.servers:
            threading.Thread(target=s.serve_forever, daemon=True).start()
        self.ports = [s.server_address[1] for s in self.servers]

    def close(self):
        for s in self.servers:
            s.shutdown(); s.server_close()


class ReadyGate(unittest.TestCase):
    def test_nothing_listening_is_not_ready_and_does_not_crash(self):
        c = L.validate(good())
        c['execution']['httpPort'], c['consensus']['httpPort'] = free_port(), free_port()
        r = L.ready(c, need_from_block=1, need_blobs_from_slot=1)
        self.assertFalse(r['ready'])
        self.assertTrue(all(not x['ok'] for x in r['checks']), r)
        self.assertEqual(len(r['checks']), 13)

    def test_gate_is_the_conjunction_of_every_check(self):
        c = L.validate(good())
        breaks = [('el.chainId', lambda s: s.el.update(eth_chainId='0x2105')),
                  ('el.genesis', lambda s: s.el.update(genesis='0x' + '00' * 32)),
                  ('el.syncing', lambda s: s.el.update(eth_syncing={'currentBlock': '0x1'})),
                  ('el.head', lambda s: s.el['latest'].update(timestamp=hex(int(time.time()) - 3600))),
                  ('el.finalized', lambda s: s.el.update(finalized=None)),
                  ('el.receiptsFrom', lambda s: s.el['receipts'].pop(100)),
                  ('cl.genesis', lambda s: s.cl.update(gvr='0x' + '00' * 32)),
                  ('cl.spec', lambda s: s.cl.update(fulu='999999')),
                  ('cl.version', lambda s: s.cl.update(version='Lighthouse/v8.2.3-x')),
                  ('cl.syncing', lambda s: s.cl['syncing'].update(is_optimistic=True)),
                  ('cl.custody', lambda s: s.cl.update(custody='4')),
                  ('pair.head', lambda s: s.cl['payload'].update(block_hash='0x' + 'dd' * 32)),
                  ('cl.blobs', lambda s: s.cl.update(served=None))]
        s = StandIns()
        try:
            c['execution']['httpPort'], c['consensus']['httpPort'] = s.ports
            r = L.ready(c, need_from_block=100)
            self.assertTrue(r['ready'], r)
            self.assertEqual(len(r['checks']), 13)
        finally:
            s.close()
        for name, brk in breaks:
            with self.subTest(name):
                s = StandIns()
                try:
                    c['execution']['httpPort'], c['consensus']['httpPort'] = s.ports
                    brk(s)
                    r = L.ready(c, need_from_block=100)
                    self.assertFalse(r['ready'], name)
                    self.assertEqual([x['check'] for x in r['checks'] if not x['ok']], [name], r)
                finally:
                    s.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
