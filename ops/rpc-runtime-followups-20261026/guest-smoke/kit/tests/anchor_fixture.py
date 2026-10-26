"""Shared fixtures: a fake `base` binary (the pinned test_origin_extract FAKE, b9b026da) over a fake DB holding an Isthmus header N
sealed by the pinned anchor-bootstrap module, its jovian L1-attributes deposit, and a synthetic A1 receipt pinned by sha for the test."""
import hashlib, json, os, stat, subprocess, sys, tempfile, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get('AO_SRC') or os.path.join(HERE, '..', 'src'))   # smoke: the bundle-copy lib
import anchored_origin as AO  # noqa: E402

NODE = os.environ.get('NODE', '/usr/bin/node')
COV = os.path.dirname(AO.PINS['origin_extract'][0])
TEST_OE = (os.environ.get('TEST_ORIGIN_EXTRACT') or os.path.join(COV, 'test_origin_extract.py'), 'b9b026da24f4b73c5a7918537fc58e9e72c2058e213a15bb858f6ee8c412d4df')   # smoke: kept OUT of the bundle copy (its verify refuses unlisted files)
N = 52866960
BATCHER = '5050f69a9786f081509234f1a7f4684b5e5b76c9'


def pinned_module(path_sha, name):
    path, want = path_sha
    b = open(path, 'rb').read()
    assert hashlib.sha256(b).hexdigest() == want, f'{path} not pinned'
    m = types.ModuleType(name); m.__file__ = path
    sys.path.insert(0, os.path.dirname(path))
    exec(compile(b, path, 'exec'), m.__dict__)
    return m


FAKE = pinned_module(TEST_OE, 'test_origin_extract_pinned').FAKE


def h32(tag):
    return '0x' + hashlib.sha256(str(tag).encode()).hexdigest()


def jovian_info(origin_number, origin_hash, seq=2, batcher=BATCHER):
    """base-v1.5.1 jovian L1-info calldata (layout as decoded by the pinned origin_extract.decode_l1_info)."""
    body = (b'\0' * 8 + seq.to_bytes(8, 'big') + (1792523243).to_bytes(8, 'big') + origin_number.to_bytes(8, 'big')
            + b'\0' * 64 + bytes.fromhex(origin_hash[2:]) + bytes(12) + bytes.fromhex(batcher) + bytes(14))
    return '0x3db6be2b' + body.hex()


def isthmus_header(n=N, mix=None, pbr=None, state=None):
    return {'parentHash': h32(('parent', n)), 'sha3Uncles': '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
            'miner': '0x4200000000000000000000000000000000000011', 'stateRoot': state or h32(('state', n)),
            'transactionsRoot': h32(('tx', n)), 'receiptsRoot': h32(('rc', n)), 'logsBloom': '0x' + '00' * 256,
            'difficulty': '0x0', 'number': hex(n), 'gasLimit': '0x8f0d180', 'gasUsed': '0x5b8d80', 'timestamp': hex(1686789347 + 2 * n),
            'extraData': '0x010000000000000032000000000000000000', 'mixHash': mix or h32(('mix', n)), 'nonce': '0x0000000000000000',
            'baseFeePerGas': '0x5f5e1', 'withdrawalsRoot': h32(('mp', n)), 'blobGasUsed': '0x0', 'excessBlobGas': '0x0',
            'parentBeaconBlockRoot': pbr or h32(('pbr', n)),
            'requestsHash': '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}


def seal(header):
    p = subprocess.run([NODE, os.path.join(HERE, 'anchor_fixture.mjs')], input=json.dumps(header), capture_output=True, text=True,
                       timeout=60, env={'PATH': '/usr/bin:/bin', 'AB': 'file://' + AO.PINS['anchor_bootstrap'][0],
                                        'K': 'file://' + AO.PINS['noble_sha3'][0]})
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


class AnchorDB:
    """A temp tree: fake base binary, read-only-looking datadir, fake DB with header N, its deposit and the Finish checkpoint."""

    def __init__(self, origin_number, origin_hash, mix=None, pbr=None, tip=None, batcher=BATCHER, n=N):
        self.n = n
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.bin = os.path.join(t, 'base')
        with open(self.bin, 'w') as f:
            f.write(FAKE)
        os.chmod(self.bin, stat.S_IRWXU)
        with open(self.bin, 'rb') as f:
            self.sha = hashlib.sha256(f.read()).hexdigest()
        self.dd = os.path.join(t, 'dd')
        os.makedirs(os.path.join(self.dd, 'db'))
        self.header = isthmus_header(n=n, mix=mix, pbr=pbr)
        s = seal(self.header)
        self.hash, self.root = s['hash'], s['outputRoot']
        self.db = {'mdbx StageCheckpoints "Finish"': {'block_number': tip or 53048526, 'stage_checkpoint': None},
                   # a persisted safe head with a DIFFERENT origin: the anchored extractor must never read it
                   'mdbx ChainState "LastSafeBlock"': 53047000,
                   f'static-file headers {n}': [self.header, self.hash],
                   f'mdbx BlockBodyIndices {n}': {'first_tx_num': 4242, 'tx_count': 3},
                   'static-file transactions 4242': {'type': '0x7e', 'sourceHash': h32('src'), 'from': '0x' + 'de' * 20,
                                                     'to': '0x4200000000000000000000000000000000000015',
                                                     'input': jovian_info(origin_number, origin_hash, batcher=batcher)}}
        self.receipt = os.path.join(t, 'a1-evidence.json')
        self.write_receipt(self.root)

    def write_receipt(self, root, n=None):
        n = self.n if n is None else n
        with open(self.receipt, 'w') as f:
            json.dump({'verdict': 'A1-authenticated', 'N': str(n), 'outputRoot': root, 'game': '0x' + '34' * 20}, f)
        self.pins = {**AO.PINS, 'receipt': (self.receipt, hashlib.sha256(open(self.receipt, 'rb').read()).hexdigest())}

    def flush(self):
        os.environ['FAKE_DB'] = os.path.join(self.tmp.name, 'db.json')
        with open(os.environ['FAKE_DB'], 'w') as f:
            json.dump(self.db, f)

    def extract(self, **kw):
        self.flush()
        scratch = tempfile.mkdtemp(dir=self.tmp.name, prefix='scratch')
        oe_ro = AO.load_origin_extract
        dd = os.path.realpath(self.dd)

        def load(pins):                                       # the pinned module, with only its mount probe faked for the temp datadir
            m = oe_ro(pins)
            m.read_only_mount = lambda p: os.path.realpath(p).startswith(dd)
            return m
        AO.load_origin_extract = load
        try:
            return AO.extract_anchored(self.bin, kw.get('sha', self.sha), self.dd, kw.get('receipt', self.receipt), scratch, NODE, 30,
                                       kw.get('pins', self.pins))
        finally:
            AO.load_origin_extract = oe_ro

    def close(self):
        self.tmp.cleanup()
