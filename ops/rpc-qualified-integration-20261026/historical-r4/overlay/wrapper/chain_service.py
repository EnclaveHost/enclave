#!/usr/bin/env python3
"""Run one pinned chain client on the RPC VM's dedicated ext4 volumes.

This is the direct virtual-disk deployment adapter. It does not use the older
loop-image/NBD storage launchers. No public execution RPC is configured here.
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import time
import tomllib
import urllib.parse
import urllib.request
import urllib.error

ROOT = pathlib.Path('/opt/enclave-rpc')
MANIFEST = json.loads((ROOT / 'manifest.json').read_text())
DISKS = json.loads(pathlib.Path('/etc/enclave-rpc-vm/disks.json').read_text())['disks']
CONFIG = json.loads(pathlib.Path('/etc/enclave-rpc/chain.json').read_text())

def mount(role, side):
    d = next(d for d in DISKS if d['role'] == role)
    expected = MANIFEST['mounts'][role]
    assert d['mount'] == expected and os.path.ismount(expected), 'dedicated mount absent'
    result = subprocess.check_output(['findmnt', '-n', '-o', 'UUID,FSTYPE,OPTIONS', '--mountpoint', expected], text=True).split()
    assert result[:2] == [d['uuid'], 'ext4'], 'wrong dedicated filesystem'
    # ProtectSystem makes the mount root read-only while only the client's data subtree is writable.
    data = expected + ('/cl' if side == 'cl' else '/data')
    writable = subprocess.check_output(['findmnt', '-n', '-o', 'UUID,FSTYPE,OPTIONS', '--target', data], text=True).split()
    assert writable[:2] == [d['uuid'], 'ext4'] and 'rw' in writable[2].split(','), 'data filesystem not writable'
    return expected

def binary(name):
    path = ROOT / 'bin' / name
    with path.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == MANIFEST['binaries'][name], 'binary pin mismatch'
    return str(path)

class RpcError(AssertionError):
    """A well-formed local JSON-RPC error object. Still the 'local RPC failed' refusal, but keeps code/message so that
    exactly one refusal (reth's pruned genesis, el_genesis) can be recognised; nothing else treats it differently."""

    def __init__(self, code, message):
        super().__init__('local RPC failed')
        self.code, self.message = code, message

def rpc(port, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}', body, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.load(r)
    err = result.get('error') if isinstance(result, dict) and 'result' not in result else None
    if isinstance(err, dict) and type(err.get('code')) is int and isinstance(err.get('message'), str):
        raise RpcError(err['code'], err['message'])
    assert 'error' not in result and 'result' in result, 'local RPC failed'
    return result['result']

def beacon(path):
    with urllib.request.urlopen('http://127.0.0.1:15052' + path, timeout=10) as r:
        return json.load(r)['data']

def beacon_doc(path):
    """The whole beacon API response: unlike beacon() it keeps the envelope flags (execution_optimistic, finalized)."""
    with urllib.request.urlopen('http://127.0.0.1:15052' + path, timeout=10) as r:
        doc = json.load(r)
    assert isinstance(doc, dict) and isinstance(doc.get('data'), dict), 'malformed beacon response'
    return doc

EL_GENESIS = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
CL_GENESIS_TIME = '1606824023'
# reth EthApiError::PrunedHistoryUnavailable: EIP-4444 code 4444 and exactly this message (the same recognition as
# readiness/readiness_sampler.py PRUNED_CODE/PRUNED_MSG). Only this refusal, for block 0, selects the pruned basis.
PRUNED_CODE = 4444
PRUNED_MSG = re.compile(r'pruned history unavailable: requested (0|[1-9][0-9]*), earliest available ([1-9][0-9]*)')

def el_genesis():
    """0 when our EL serves the pinned mainnet genesis block; the EL's earliest available block when (and only when)
    it refuses block 0 with reth's exact pruned-history error. Any other error, a null block or another hash refuses."""
    try:
        g = rpc(18645, 'eth_getBlockByNumber', ['0x0', False])
    except RpcError as e:
        m = PRUNED_MSG.fullmatch(e.message)
        if e.code == PRUNED_CODE and m and m[1] == '0':
            return int(m[2])
        raise
    assert isinstance(g, dict) and g.get('hash') == EL_GENESIS, 'wrong EL genesis'
    return 0

def _qty(v):
    assert isinstance(v, str) and re.fullmatch(r'0x(0|[1-9a-f][0-9a-f]*)', v), 'malformed L1 quantity'
    return int(v, 16)

def _dec(v):
    assert isinstance(v, str) and re.fullmatch(r'0|[1-9][0-9]*', v), 'malformed beacon number'
    return int(v)

def _h32(v):
    assert isinstance(v, str) and H32_RE.fullmatch(v), 'malformed 32-byte hash'
    return v.lower()

def pruned_identity(earliest, el_finalized):
    """Compensating identity when the EL genesis body is pruned (readiness_sampler.py l1_identity, pruned basis). The
    beacon finalized block of the CL whose genesis/spec/version were just pinned must be non-optimistic and flagged
    finalized, fresh, inside our EL's retained range and at/below our EL finalized; our EL must serve exactly that
    payload block (number, hash, parent, timestamp). Block hashes commit to all ancestors, so our EL's chain contains
    mainnet's. Operational identity only: it trusts the local CL like every gate here; it is not cryptographic
    authority against this host (that is the separate A1 gate)."""
    doc = beacon_doc('/eth/v1/beacon/blinded_blocks/finalized')
    assert doc.get('execution_optimistic') is False, 'L1 beacon finalized block optimistic'
    assert doc.get('finalized') is True, 'L1 beacon finalized block not flagged finalized'
    msg = doc['data'].get('message')
    body = msg.get('body') if isinstance(msg, dict) else None
    p = body.get('execution_payload_header') if isinstance(body, dict) else None
    assert isinstance(p, dict), 'malformed beacon finalized block'
    n, ts = _dec(p.get('block_number')), _dec(p.get('timestamp'))
    assert earliest <= n, 'L1 beacon finalized below EL earliest available'
    assert n <= el_finalized, 'L1 beacon finalized above EL finalized'
    assert -15 <= time.time() - ts < 3600, 'L1 beacon finalized stale'
    el = rpc(18645, 'eth_getBlockByNumber', [hex(n), False])
    assert isinstance(el, dict) and _qty(el.get('number')) == n and _h32(el.get('hash')) == _h32(p.get('block_hash')) \
        and _h32(el.get('parentHash')) == _h32(p.get('parent_hash')) and _qty(el.get('timestamp')) == ts, \
        'L1 execution/consensus finalized mismatch'
    return {'basis': 'pruned-el-genesis+mainnet-cl-paired-finalized', 'elEarliestAvailable': earliest,
            'pairedFinalized': {'number': n, 'hash': _h32(el['hash'])}}

def l1_ready():
    assert rpc(18645, 'eth_chainId', []) == '0x1'
    earliest = el_genesis()
    gen = beacon('/eth/v1/beacon/genesis')
    assert gen['genesis_validators_root'] == '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95', 'wrong CL genesis'
    # without the EL genesis block, the CL genesis is the chain anchor: its genesis time is pinned too
    assert not earliest or gen.get('genesis_time') == CL_GENESIS_TIME, 'wrong CL genesis'
    spec = beacon('/eth/v1/config/spec')
    assert spec['DEPOSIT_CHAIN_ID'] == '1' and spec['SECONDS_PER_SLOT'] == '12' and spec['FULU_FORK_EPOCH'] == '411392', 'wrong mainnet spec'
    assert beacon('/eth/v1/node/version')['version'].startswith('Lighthouse/v8.3.2'), 'wrong CL version'
    assert rpc(18645, 'eth_syncing', []) is False, 'L1 execution still syncing'
    h = rpc(18645, 'eth_getBlockByNumber', ['latest', False])
    assert -15 <= time.time() - int(h['timestamp'], 16) < 120, 'L1 head stale'
    f = rpc(18645, 'eth_getBlockByNumber', ['finalized', False])
    assert f and -15 <= time.time() - int(f['timestamp'], 16) < 3600, 'L1 finality stale'
    s = beacon('/eth/v1/node/syncing')
    assert s['is_syncing'] is False and s['is_optimistic'] is False and s['el_offline'] is False, 'L1 consensus not ready'
    ident = pruned_identity(earliest, _qty(f.get('number'))) if earliest else {'basis': 'el-genesis-block'}
    payload =beacon('/eth/v2/beacon/blocks/head')['message']['body']['execution_payload']
    paired = rpc(18645, 'eth_getBlockByNumber', [hex(int(payload['block_number'])), False])
    assert paired and paired['hash'] == payload['block_hash'], 'L1 execution/consensus mismatch'
    identity = beacon('/eth/v1/node/identity')
    assert int(identity.get('metadata', {}).get('custody_group_count', 0)) >= 64, 'L1 cannot reconstruct blobs'
    # Prove actual blob serving, not merely that the beacon HTTP server is up.
    head_slot = int(beacon('/eth/v1/beacon/headers/head')['header']['message']['slot'])
    blob_slot = None
    for slot in range(head_slot - 1, head_slot - 65, -1):
        try:
            block = beacon('/eth/v2/beacon/blocks/' + str(slot))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        commitments = block['message']['body'].get('blob_kzg_commitments', [])
        if not commitments:
            continue
        blobs = beacon('/eth/v1/beacon/blobs/' + str(slot))
        assert len(blobs) == len(commitments), 'L1 blob data unavailable'
        blob_slot = slot
        break
    assert blob_slot is not None, 'no recent blob-carrying block served'
    return {'l1Block': int(h['number'], 16), 'l1Finalized': int(f['number'], 16), 'blobSlot': blob_slot, 'l1Identity': ident}

# ---- Base coverage activation bridge -------------------------------------------------------------------------------
# A boolean is never coverage evidence. Base starts only when the operator-reviewed config (coverageVerified true, the
# operator's explicit activation decision) ALSO pins the exact bytes of a reviewed acceptance receipt, the coverage
# gate's COVERED verdict and the snapshot origin, all root-owned under COVERAGE_DIR, and those documents validate and
# bind to THIS installed bootstrap manifest, THIS chain config and THESE binary pins. Rules mirror
# readiness/readiness_sampler.py validate_coverage_files (parity-tested). l1Block/blobSlot come only from that binding.
COVERAGE_DIR = pathlib.Path('/etc/enclave-rpc/coverage')
RECEIPT_FORMAT = 'enclave-base-coverage-acceptance/v1'
VERDICT_FORMAT = 'enclave-base-l1-coverage-verdict/v1'      # coverage/coverage_gate.py
ORIGIN_FORMAT = 'enclave-base-snapshot-origin/v1'           # coverage/origin_extract.py
KZGCHECK_SHA256 = '00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb'   # coverage/RESULT.md
BOOTSTRAP_FORMAT = 'enclave-rpc-production-bootstrap/v1'   # stage_backend.py installed manifest (NOT a snapshot manifest)
BASE_CHAIN_ID = 8453
SNAPSHOT_STORAGE_VERSIONS = (1, 2)   # reth 7134be3 crates/cli/commands/src/download/manifest.rs SnapshotManifest
BASE_SEQ_WINDOW = 3600
MAX_EVIDENCE = 16 << 20
SHA_RE = re.compile(r'[0-9a-f]{64}')
H32_RE = re.compile(r'0x[0-9a-fA-F]{64}')

def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)

def config_identity(cfg):
    """sha256 of the chain config WITHOUT its baseBootstrap section, canonical JSON (sorted keys, no spaces).

    This is the identity a coverage receipt reviews: writing the activation section afterwards does not change it,
    while any change to checkpoint, forwarding or other settings does."""
    rest = {k: v for k, v in cfg.items() if k != 'baseBootstrap'}
    return hashlib.sha256(json.dumps(rest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _evidence(path, owner):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise AssertionError(f'coverage evidence {path.name} unreadable ({type(e).__name__})')
    try:
        st = os.fstat(fd)
        assert stat.S_ISREG(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022 and st.st_size <= MAX_EVIDENCE, \
            f'coverage evidence {path.name} is not an operator-owned, non-writable regular file within bounds'
        chunks, total = [], 0
        while total <= MAX_EVIDENCE:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            chunks.append(b)
            total += len(b)
    finally:
        os.close(fd)
    raw = b''.join(chunks)
    assert len(raw) <= MAX_EVIDENCE, f'coverage evidence {path.name} too large'
    try:
        doc = json.loads(raw)
    except ValueError:
        raise AssertionError(f'coverage evidence {path.name} is not JSON')
    assert isinstance(doc, dict), f'coverage evidence {path.name} is not a JSON object'
    return hashlib.sha256(raw).hexdigest(), doc

SAFE_PATH_RE = re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*')
HEX64_RE = re.compile(r'[0-9a-f]{64}')

def _safe_rel(p):
    """Relative path, plain characters, no '.'/'..' segments: cannot escape a URL base or a datadir when joined."""
    return isinstance(p, str) and SAFE_PATH_RE.fullmatch(p) is not None and not ({'.', '..'} & set(p.split('/')))

def _https_origin(u):
    try:
        port = u.port
    except ValueError:
        return False
    return u.scheme == 'https' and bool(u.hostname) and u.username is None and u.password is None and port in (None, 443) \
        and not u.query and not u.fragment

def snapshot_manifest_check(doc, bootstrap, snapshot_url):
    """Identity/location gate for the exact downloaded Base snapshot manifest (never the installer document).

    Follows pinned reth 7134be3 semantics (crates/cli/commands/src/download): the effective archive base is the
    manifest's non-empty base_url, else the manifest source's directory (source.rs resolve_manifest_base_url);
    archive URLs are base + '/' joined with each relative path (manifest.rs resolve_archive_url), and chunked
    components use chunk_files when it has exactly one path per chunk (chunk_files_are_consistent). Locally enforced
    policy: the effective base stays on the pinned snapshot host at or above the pinned snapshot directory, every
    archive path is plain-relative and lies at the root, under static_files/, or under the pinned snapshot id
    directory, and every extracted output path is plain-relative with a BLAKE3 hex digest. This proves manifest
    identity and location only, NOT authenticated snapshot state: archive and output BLAKE3 values are the
    publisher's claims, verified by the downloader, not by this gate."""
    assert not ({'format', 'snapshotManifests', 'binaries', 'mounts'} & set(doc)) and doc != bootstrap, \
        'snapshot manifest evidence is the bootstrap/install manifest, not the downloaded snapshot manifest'
    for k in ('block', 'chain_id', 'storage_version', 'timestamp'):
        assert _int(doc.get(k)) and doc[k] >= 0, f'snapshot manifest {k} malformed'
    assert doc['chain_id'] == BASE_CHAIN_ID, 'snapshot manifest is not for Base mainnet'
    assert doc['storage_version'] in SNAPSHOT_STORAGE_VERSIONS and doc['block'] > 0, 'snapshot manifest storage/block invalid'
    assert isinstance(snapshot_url, str) and snapshot_url.endswith('/manifest.json'), \
        'bootstrap manifest pins no Base snapshot manifest URL'
    pinned = urllib.parse.urlsplit(snapshot_url)
    pinned_dir = pinned.path[:-len('/manifest.json')]
    snapshot_id = pinned_dir.rsplit('/', 1)[-1]
    assert _https_origin(pinned) and SAFE_PATH_RE.fullmatch(snapshot_id or '-/'), 'bootstrap manifest pins no Base snapshot manifest URL'
    base = doc.get('base_url')
    if base is not None and base != '':
        b = urllib.parse.urlsplit(base) if isinstance(base, str) else None
        bpath = b.path.rstrip('/') if b else None
        assert b and _https_origin(b) and b.hostname == pinned.hostname and b.netloc == pinned.netloc \
            and (bpath == pinned_dir or pinned_dir.startswith(bpath + '/')), \
            'snapshot manifest base_url is not the snapshot location the bootstrap pinned'
        effective = base.rstrip('/')
    else:
        effective = snapshot_url[:-len('/manifest.json')]
    allowed_top = {'static_files', snapshot_id}

    def archive(p, name):
        assert _safe_rel(p) and ('/' not in p or p.split('/', 1)[0] in allowed_top), \
            f'snapshot component {name} malformed: archive path escapes the pinned snapshot location'

    def outputs(files, name):
        assert isinstance(files, list), f'snapshot component {name} malformed: output files'
        for o in files:
            assert isinstance(o, dict) and _safe_rel(o.get('path')) and _int(o.get('size')) and o['size'] >= 0 \
                and isinstance(o.get('blake3'), str) and HEX64_RE.fullmatch(o['blake3']), \
                f'snapshot component {name} malformed: output file entry'

    def uints(v, name):
        assert isinstance(v, list) and all(_int(x) and x >= 0 for x in v), f'snapshot component {name} malformed: sizes'

    comps = doc.get('components')
    assert isinstance(comps, dict) and comps, 'snapshot manifest has no components'
    for name, cm in comps.items():
        assert isinstance(name, str) and isinstance(cm, dict), 'snapshot manifest component malformed'
        if 'file' in cm:
            archive(cm['file'], name)
            assert _int(cm.get('size')) and cm['size'] >= 0 and (_int(cm.get('decompressed_size', 0)) and cm.get('decompressed_size', 0) >= 0), \
                f'snapshot component {name} malformed'
            outputs(cm.get('output_files', []), name)
        else:
            assert _int(cm.get('blocks_per_file')) and cm['blocks_per_file'] > 0 and _int(cm.get('total_blocks')) \
                and cm['total_blocks'] == doc['block'], f'snapshot component {name} malformed'
            chunks = -(-cm['total_blocks'] // cm['blocks_per_file'])
            files = cm.get('chunk_files', [])
            assert isinstance(files, list) and (not files or len(files) == chunks), \
                f'snapshot component {name} malformed: chunk_files not one per chunk'
            for p in files:
                archive(p, name)
            uints(cm.get('chunk_sizes', []), name)
            uints(cm.get('chunk_decompressed_sizes', []), name)
            per_chunk = cm.get('chunk_output_files', [])
            assert isinstance(per_chunk, list), f'snapshot component {name} malformed: output files'
            for files_ in per_chunk:
                outputs(files_, name)
    return {'block': doc['block'], 'timestamp': doc['timestamp'], 'url': snapshot_url, 'effectiveBaseUrl': effective,
            'components': len(comps), 'scope': 'manifest identity and location only; not authenticated snapshot state'}

# ---- N-anchored segmented coverage (historical-origin-segments-stage/r4) -------------------------------------------------
# Explicit opt-in only: baseBootstrap.mode == 'anchored-segments' selects the anchored verification; no `mode` keeps the legacy
# safe-label path unchanged; any other mode refuses. The verification code is root-installed under ANCHORED_COVERAGE_LIB, root-owned,
# and executed only from bytes equal to these pins (the same three files readiness_sampler pins).
ANCHORED_COVERAGE_LIB = ROOT / 'lib' / 'anchored-coverage'
ANCHORED_COVERAGE_PINS = {
    'anchored_origin.py': 'ed1a547d4d8aea112cae66479c64cd9e556b531063ef361c9b156c6d2948ddfa',
    'segments.py': '8764f5cc55cc42307eadbe71695bb986ca5fa86c07db671553d50d0635c51aa1',
    'anchored_acceptance.py': 'cb68413866d0534822bdfc37702e253acfe04abad30d98e34b2231595518138d'}
ANCHORED_A1_SHA256 = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'   # the source-pinned original A1 receipt (N 52866960)

def _anchored_overlay(owner):
    lib = pathlib.Path(ANCHORED_COVERAGE_LIB)
    _secure_path(lib, owner, leaf='dir')
    mods = {}
    for name in ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py'):   # dependency order
        p = lib / name
        _secure_path(p, owner)
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as f:
            raw = f.read(1 << 22)
        assert hashlib.sha256(raw).hexdigest() == ANCHORED_COVERAGE_PINS[name], f'anchored coverage {name} is not the pinned bytes'
        mod = type(sys)(name[:-3]); mod.__file__ = str(p)
        sys.modules[name[:-3]] = mod                       # segments imports anchored_origin; anchored_acceptance imports both
        exec(compile(raw, str(p), 'exec'), mod.__dict__)
        mods[name] = mod
    return mods['anchored_acceptance.py']

def base_coverage(cfg, manifest_path, base_binary_sha256):
    """-> (binding, bound L1 origin). No mode: the legacy snapshot-safe-label activation, unchanged. 'anchored-segments': header N
    authenticated by the original A1 output root, its L1 origin bound by the parent-beacon-root/mixHash linkage, and complete segmented
    coverage, all re-verified from root-owned evidence. Any other mode refuses (no implicit activation)."""
    mode = (cfg.get('baseBootstrap') or {}).get('mode') if isinstance(cfg.get('baseBootstrap'), dict) else None
    if mode is None:
        o = coverage_activation(cfg, manifest_path, base_binary_sha256)
        return o, o['safeL1Origin']
    assert mode == 'anchored-segments', f'unknown baseBootstrap.mode {mode!r}: no implicit activation'
    aa = _anchored_overlay(ROOT_UID)
    view = type(sys)(__name__); view.__dict__.update(globals())     # this module's helpers/pins, however it was loaded
    o = aa.anchored_coverage_activation(view, cfg, manifest_path, base_binary_sha256, COVERAGE_DIR, ROOT_UID,
                                        ANCHORED_A1_SHA256, time.time())
    return o, o['l1Origin']

def anchored_launch_binding(origin, lock):
    """Anchored coverage exists only for the release anchor launch: before anything is consumed, the immutable launch record must
    name exactly the anchored-coverage header N (number and block hash)."""
    assert lock is not None, 'anchored coverage requires the release launch (manifest baseRelease + launch lock)'
    _l_sha, launch, n = launch_record(CONFIG, BASE_RELEASE_SHA256)
    a = origin['anchor']
    assert n == a['N'] and launch.get('anchor') == f"{a['N']}:{a['headerHash']}", 'launch anchor is not the anchored-coverage header N'

def coverage_activation(cfg, manifest_path, base_binary_sha256, directory=COVERAGE_DIR, owner=0):
    """Offline, fail-closed validation of the activation evidence. Returns the bound bootstrap or raises AssertionError."""
    bb = cfg.get('baseBootstrap')
    assert isinstance(bb, dict) and bb.get('coverageVerified') is True, 'Base snapshot blob coverage not approved'
    assert 'mode' not in bb, 'legacy coverage activation refuses any baseBootstrap.mode'
    acc = bb.get('coverageAcceptance')
    assert isinstance(acc, dict) and all(isinstance(acc.get(k), str) and SHA_RE.fullmatch(acc[k])
                                         for k in ('receiptSha256', 'verdictSha256', 'originSha256', 'snapshotManifestSha256')), \
        'coverage acceptance hashes missing: coverageVerified alone never activates Base'
    assert isinstance(base_binary_sha256, str) and SHA_RE.fullmatch(base_binary_sha256), 'installed base binary pin missing'
    try:
        d = os.lstat(directory)
    except OSError:
        raise AssertionError('coverage evidence directory absent')
    assert stat.S_ISDIR(d.st_mode) and d.st_uid == owner and not d.st_mode & 0o022, 'coverage evidence directory not operator-controlled'
    r_sha, rc = _evidence(directory / 'receipt.json', owner)
    v_sha, verdict = _evidence(directory / 'verdict.json', owner)
    o_sha, origin = _evidence(directory / 'origin.json', owner)
    s_sha, snap = _evidence(directory / 'snapshot-manifest.json', owner)
    assert (r_sha, v_sha, o_sha, s_sha) == (acc['receiptSha256'], acc['verdictSha256'], acc['originSha256'],
                                            acc['snapshotManifestSha256']), \
        'coverage evidence bytes differ from the operator-pinned hashes'
    try:
        manifest_raw = pathlib.Path(manifest_path).read_bytes()
        installed = json.loads(manifest_raw)
    except (OSError, ValueError):
        raise AssertionError('installed bootstrap manifest unreadable')
    assert isinstance(installed, dict) and (installed.get('binaries') or {}).get('base') == base_binary_sha256, \
        'installed bootstrap manifest does not pin this base binary'
    # Receipt: an accepted review record whose hashes bind the evidence, this install and these tools.
    assert rc.get('format') == RECEIPT_FORMAT and rc.get('decision') == 'accepted', 'coverage receipt not an accepted review'
    rv = rc.get('review') if isinstance(rc.get('review'), dict) else {}
    reviewer, runner = rv.get('reviewer'), rv.get('gateRunner')
    assert isinstance(reviewer, str) and reviewer.strip() and isinstance(runner, str) and runner.strip() \
        and reviewer.strip() != runner.strip() and isinstance(rv.get('reviewedAt'), str), 'coverage review not independent'
    for k in ('verdictSha256', 'originSha256', 'snapshotManifestSha256', 'bootstrapManifestSha256', 'chainConfigSha256',
              'kzgcheckSha256', 'baseBinarySha256'):
        assert isinstance(rc.get(k), str) and SHA_RE.fullmatch(rc[k]), f'coverage receipt {k} malformed'
    assert rc['verdictSha256'] == v_sha and rc['originSha256'] == o_sha, 'coverage receipt does not bind these evidence bytes'
    b_sha = hashlib.sha256(manifest_raw).hexdigest()
    assert rc['bootstrapManifestSha256'] == b_sha, 'coverage receipt reviewed a different installed bootstrap manifest'
    # Two distinct documents: the installer manifest (pins/URLs) and the exact downloaded snapshot manifest.
    assert s_sha != b_sha, 'snapshot manifest evidence is the bootstrap/install manifest, not the downloaded snapshot manifest'
    assert rc['snapshotManifestSha256'] == s_sha, 'coverage receipt does not bind this snapshot manifest'
    snapshot_url = (installed.get('snapshotManifests') or {}).get('base')
    assert rc.get('snapshotManifestUrl') == snapshot_url, 'coverage receipt names a different snapshot manifest URL'
    snapshot = snapshot_manifest_check(snap, installed, snapshot_url)
    assert rc['chainConfigSha256'] == config_identity(cfg), 'coverage receipt reviewed a different chain config'
    assert rc['kzgcheckSha256'] == KZGCHECK_SHA256 and rc['baseBinarySha256'] == base_binary_sha256, 'coverage receipt tool pins differ'
    # Origin: persisted safe label extracted read-only by the pinned base binary.
    src = origin.get('source') if isinstance(origin.get('source'), dict) else {}
    labels = origin.get('labels') if isinstance(origin.get('labels'), dict) else {}
    safe = labels.get('safe') if isinstance(labels.get('safe'), dict) else None
    assert origin.get('format') == ORIGIN_FORMAT and origin.get('status') == 'SAFE_HEAD_PERSISTED' and safe is not None, \
        'snapshot origin has no persisted safe label'
    assert src.get('datadirReadOnlyMount') is True and src.get('binarySha256') == base_binary_sha256, 'snapshot origin provenance'
    so = safe.get('l1Origin') if isinstance(safe.get('l1Origin'), dict) else {}
    tip = labels.get('tip') if isinstance(labels.get('tip'), dict) else {}
    assert _int(tip.get('number')) and tip['number'] == snapshot['block'], \
        'snapshot origin tip is not the downloaded snapshot manifest block (different snapshot or datadir already advanced)'
    assert _int(safe.get('number')) and safe['number'] <= snapshot['block'] and isinstance(safe.get('hash'), str) and H32_RE.fullmatch(safe['hash']) \
        and _int(so.get('number')) and so['number'] >= 0 and isinstance(so.get('hash'), str) and H32_RE.fullmatch(so['hash']), \
        'snapshot origin safe label malformed'
    # Verdict: complete COVERED result of the cryptographic gate under the safe-label rule.
    counts = verdict.get('counts') if isinstance(verdict.get('counts'), dict) else {}
    prop = verdict.get('proposedBaseBootstrap') if isinstance(verdict.get('proposedBaseBootstrap'), dict) else {}
    assert verdict.get('format') == VERDICT_FORMAT and verdict.get('verdict') == 'COVERED' and 'refusal' not in verdict \
        and verdict.get('coverageVerifiedWritten') is False, 'coverage verdict is not COVERED'
    assert verdict.get('rule') == 'safe-origin-minus-seq-window' and prop.get('coverageVerifiedEligible') is True, \
        'coverage verdict not produced under the persisted safe-label rule'
    need, to = verdict.get('needFromBlock'), verdict.get('toBlock')
    assert _int(need) and _int(to) and to >= so['number'] >= need >= 0, 'coverage verdict range does not cover the safe L1 origin'
    assert counts.get('missingData') == 0 and counts.get('mismatches') == 0 and _int(counts.get('blobsVerified')) \
        and counts['blobsVerified'] >= 1 and counts.get('blocks') == to - need + 1, 'coverage verdict incomplete'
    rb = rc.get('baseBootstrap') if isinstance(rc.get('baseBootstrap'), dict) else {}
    slot = prop.get('blobSlot')
    assert need == so['number'] - BASE_SEQ_WINDOW == prop.get('l1Block') == rb.get('l1Block') and _int(slot) and slot >= 0 \
        and slot == rb.get('blobSlot') and not isinstance(prop.get('l1Block'), bool) and not isinstance(rb.get('l1Block'), bool) \
        and not isinstance(rb.get('blobSlot'), bool), 'coverage receipt/verdict/origin bindings disagree'
    assert verdict.get('batcher') is None or str(verdict['batcher']).lower() == str(safe.get('batcher', '')).lower(), \
        'coverage verdict batcher differs from the origin'
    # The legacy free-form config fields may only restate the bound values.
    for k, v in (('l1Block', need), ('blobSlot', slot)):
        assert k not in bb or (bb[k] == v and not isinstance(bb[k], bool)), f'chain config {k} differs from the reviewed binding'
    return {'l1Block': need, 'blobSlot': slot, 'toBlock': to,
            'safeL1Origin': {'number': so['number'], 'hash': so['hash'].lower()},
            'snapshot': snapshot, 'bootstrapManifestSha256': b_sha,
            'evidence': {'receiptSha256': r_sha, 'verdictSha256': v_sha, 'originSha256': o_sha, 'snapshotManifestSha256': s_sha}}

def forwarding_args():
    setting = CONFIG.get('txForwarding') or {}
    endpoint = setting.get('endpoint')
    if endpoint is None:
        return []
    assert endpoint == 'https://mainnet-sequencer.base.org', 'unsupported submission endpoint'
    # Submission only. This endpoint never supplies state, headers, proofs or fees.
    return ['--rpc.forwarding-endpoint', endpoint]

RETAINED_BLOCKS = 140000
DEFAULT_BLOCK_INTERVAL = 5          # reth/base-reth crates/config DEFAULT_BLOCK_INTERVAL
DEFAULT_MINIMUM_DISTANCE = 10064    # MINIMUM_UNWIND_SAFE_DISTANCE = 32 * 2 + 10_000
HISTORY_FLAGS = (('receipts', 'receipts'), ('account_history', 'account-history'),
                 ('storage_history', 'storage-history'), ('bodies_history', 'bodies'))

def _uint(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0

# Base history retention (base-retention-stage review). eth_getLogs in the pinned reth (7134be3) reads receipts AND
# transactions (tx hash via transaction_by_id, rpc-eth-types/src/logs_utils.rs:104-138), checks only the lowest
# Transactions static file (static_file/manager.rs:1224-1231) and silently skips a block whose receipts are absent
# (rpc/rpc/src/eth/filter.rs:1282-1284). A distance profile deletes whole static files once they fall behind
# (prune/src/segments/mod.rs:32-71), and bodies may lag receipts (segments/user/bodies.rs:112-125), so a distance profile
# can drop the required range and briefly answer getLogs with silently missing logs. For Base, receipts, bodies and the
# tx-hash lookup are therefore kept from a reviewed absolute block (chain.json baseRetention.historyFromBlock).
RETENTION_SEGMENTS = {'receipts': 'receipts', 'bodies_history': 'bodies'}
# Base state history (account/storage changesets) is kept from a reviewed block (chain.json
# baseRetention.stateHistoryFromBlock) until the authenticated bootstrap completes: a distance profile would delete the
# whole changeset file holding the snapshot's history once the tip passes it (anchor-bootstrap review, option U).
STATE_SEGMENTS = {'account_history': 'account-history', 'storage_history': 'storage-history'}
HISTORY_FILES = (('receipts', 'receipts'), ('transactions', 'transactions'))
STATE_FILES = (('account_change_sets', 'account-change-sets'), ('storage_change_sets', 'storage-change-sets'))
DISTANCE_UPGRADE_MAX = 500000       # a reviewed downloader distance profile (<= one static file) may be upgraded to 'before'

def history_from_block(cfg, required=True):
    r = cfg.get('baseRetention')
    if r is None and not required:
        return None
    assert isinstance(r, dict) and _uint(r.get('historyFromBlock')) and r['historyFromBlock'] > 0, \
        'Base history retention start (baseRetention.historyFromBlock) not configured'
    return r['historyFromBlock']

def state_history_from_block(cfg, required=True):
    r = cfg.get('baseRetention')
    v = r.get('stateHistoryFromBlock') if isinstance(r, dict) else None
    if v is None and not required:
        return None
    assert _uint(v) and v > 0, 'Base state history start (baseRetention.stateHistoryFromBlock) not configured'
    return v

def segment_files_present(datadir, profile, block, segments):
    """The static file holding `block` must exist for each segment (whole-file layout; names as in the manifest)."""
    bpf = (profile.get('static_files') or {}).get('blocks_per_file') or {}
    for key, stem in segments:
        n = bpf.get(key)
        assert _uint(n) and n > 0, f'snapshot {key} static-file size missing'
        start = block // n * n
        name = f'static_file_{stem}_{start}_{start + n - 1}'
        assert pathlib.Path(datadir, 'static_files', name).is_file(), \
            f'Base {stem} history from block {block} absent ({name}): refusing to serve incomplete history'

def history_files_present(datadir, profile, history_from):
    """The static files holding history_from must exist for receipts and transactions (whole-file layout)."""
    segment_files_present(datadir, profile, history_from, HISTORY_FILES)

def _before_args(name, flag, mode, history_from):
    """Keep at least [history_from, tip]: before <= history_from as is; an unchanged downloader distance upgraded."""
    if isinstance(mode, dict) and set(mode) == {'before'} and _uint(mode['before']):
        assert 0 < mode['before'] <= history_from, f'{name} retention would drop required Base history'
        return [f'--prune.{flag}.before', str(mode['before'])]
    if mode == 'full' and name == 'transaction_lookup':
        return [f'--prune.{flag}.before', str(history_from)]
    assert isinstance(mode, dict) and set(mode) == {'distance'} and _uint(mode['distance']) \
        and RETAINED_BLOCKS <= mode['distance'] <= DISTANCE_UPGRADE_MAX, f'{name} retention profile not reviewed for Base history'
    return [f'--prune.{flag}.before', str(history_from)]

def prune_args(profile, history_from=None, state_from=None):
    """Complete prune CLI equal to the persisted snapshot profile (lookup kept for the retained range).

    Pinned reth/base-reth (launch/common.rs save_pruning_config) REPLACES the whole [prune] section of reth.toml
    with the CLI-only PruneConfig whenever any --prune.* flag is given; a partial flag set therefore erases every
    other segment. So every setting is passed explicitly, taken from the validated profile and never reduced.
    Settings the CLI cannot reproduce losslessly are refused instead of being silently dropped.
    """
    prune = profile.get('prune', {})
    segments = prune.get('segments', {})
    assert isinstance(prune, dict) and isinstance(segments, dict), 'snapshot prune profile missing'
    assert set(prune) <= {'block_interval', 'minimum_pruning_distance', 'segments'}, 'unsupported prune setting'
    assert set(segments) <= {'sender_recovery', 'transaction_lookup', 'receipts_log_filter'} | {n for n, _ in HISTORY_FLAGS}, 'unsupported prune segment'
    assert not segments.get('receipts_log_filter'), 'receipt log filter pruning unsupported'
    assert segments.get('sender_recovery') == 'full', 'snapshot prune profile missing'
    interval = prune.get('block_interval', DEFAULT_BLOCK_INTERVAL)
    minimum = prune.get('minimum_pruning_distance', DEFAULT_MINIMUM_DISTANCE)
    assert _uint(interval) and interval >= 1 and _uint(minimum), 'invalid prune interval/minimum distance'
    args = ['--prune.block-interval', str(interval), '--prune.minimum-distance', str(minimum),
            '--prune.sender-recovery.full']
    for name, flag in HISTORY_FLAGS:
        mode = segments.get(name)
        if history_from is not None and name in RETENTION_SEGMENTS:
            args += _before_args(name, flag, mode, history_from)
            continue
        if state_from is not None and name in STATE_SEGMENTS:
            args += _before_args(name, flag, mode, state_from)
            continue
        assert isinstance(mode, dict) and set(mode) == {'distance'} and _uint(mode['distance']) \
            and mode['distance'] >= RETAINED_BLOCKS, 'bounded history retention too short'
        args += [f'--prune.{flag}.distance', str(mode['distance'])]
    lookup = segments.get('transaction_lookup')
    if history_from is not None:
        return args + _before_args('transaction_lookup', 'transaction-lookup', lookup, history_from)
    # Downloads omit the lookup index ('full' = none kept); the client rebuilds the retained range.
    if lookup == 'full':
        distance = RETAINED_BLOCKS
    else:
        assert isinstance(lookup, dict) and set(lookup) == {'distance'} and _uint(lookup['distance']) \
            and lookup['distance'] >= RETAINED_BLOCKS, 'transaction lookup retention missing'
        distance = lookup['distance']
    return args + ['--prune.transaction-lookup.distance', str(distance)]

# ---- Combined M7+M10 Base release (OPT-IN; without manifest.json "baseRelease" every path below is unused) -----------
# The ONLY release this wrapper can select: root receipt m7-m10-release-completed-0055 (base 1.5.1 = 5476069f + M7
# e9dfb8c6 + fixed M10 d97c31b5, lock f122da76). It lives at a fixed versioned path next to, never instead of, bin/base.
BASE_RELEASE_SHA256 = '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f'
BASE_RELEASE_PATH = ROOT / 'releases' / ('base-m7m10-' + BASE_RELEASE_SHA256[:16]) / 'base'
BOOTSTRAP_DIR = pathlib.Path('/etc/enclave-rpc/base-bootstrap')
# Re-anchor recovery (base-reanchor-recovery-stage; PREPARED): every retired (rolled-back) launch directory lives here under its
# launchSha256. The current launch's predecessor chain must name ALL of them (launch_lineage): one launch history, no fork.
BOOTSTRAP_ARCHIVE = pathlib.Path('/etc/enclave-rpc/base-bootstrap-archive')
MAX_LINEAGE = 64
# r2: the persisted authenticated-finality watermark (see harness gate_watermark). Read-only here: a re-anchor launch starts only
# while the latest accepted entry is exactly this launch's anchor, recorded by root `arm` (no write path in the wrapper).
BOOTSTRAP_WATERMARK = pathlib.Path('/etc/enclave-rpc/base-finality-watermark')
# r4/r5 (base-finality-proof-stage): the ONE A1 admission ledger shared by re-anchor admissions (the r5 harness refuses any other
# path before admission; the producer re-checks at `arm`)
# and post-anchor finality admissions (finality_state): a capture serves exactly one of them, once.
A1_ADMISSION_LEDGER = pathlib.Path('/etc/enclave-rpc/base-a1-admission.jsonl')
WATERMARK_FORMAT = 'enclave-base-finality-watermark/v1'
WATERMARK_KINDS = {'launch-anchor', 'finality-proof'}
WATERMARK_KEYS = {'format', 'seq', 'prevSha256', 'number', 'blockHash', 'kind', 'ref', 'at'}
LAUNCH_FORMAT = 'enclave-base-bootstrap-launch/v1'
JOURNAL_FORMAT = 'enclave-base-bootstrap-journal/v1'
ANCHOR_RE = re.compile(r'([1-9][0-9]{0,18}):(0x[0-9a-f]{64})')
HEX64 = re.compile(r'[0-9a-f]{64}')
# UNRESOLVED (fail closed): the launch-record producer (base-launch-producer-stage/r2/producer/base_launch.py) is PREPARED,
# not reviewed. Until a reviewed change sets this, an anchored start is refused BEFORE anything is consumed. It is a source
# constant, never a config switch.
LAUNCH_PRODUCER_REVIEWED = False
# r6 activation (base-finality-proof-stage/r6): a review flag is True only through its source constant OR the root-owned activation
# artifact that names THIS module's exact bytes for that flag (written only by install_verified.py `activate`, after qualification).
# The artifact is the deliberate, reviewable activation step: no source edit, so every byte pin stays valid. Absent -> False.
ACTIVATION_FILE = pathlib.Path('/etc/enclave-rpc/finality-activation.json')


def reviewed(name):
    if globals().get(name) is True:
        return True
    try:
        fd = os.open(ACTIVATION_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return False
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            return False
        try:
            doc = json.loads(f.read(1 << 16))
        except ValueError:
            return False
    try:
        me = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    except (OSError, NameError):
        return False
    return isinstance(doc, dict) and doc.get('format') == 'enclave-finality-activation/v1' and (doc.get('flags') or {}).get(name) == me


BASE_SERVICE_USER = 'rpcbase'              # == enclave-base-holder.service User=/Group= (stage_node_units.py)
HANDSHAKE_ENV = 'ENCLAVE_BASE_LAUNCH_HANDSHAKE'   # '1' only from the reviewed release-mode unit drop-in (root start)

TRUSTED_TOP = pathlib.Path('/')            # the walk below starts here (production: the filesystem root)
ROOT_UID = 0                               # owner of the release, the bootstrap evidence and every parent directory

# The one-shot launch journal (BOOTSTRAP_DIR/journal/NNNNNN.json): immutable root-owned entries, each bound to the pinned
# launch record and hash-chained to its predecessor. Only these transitions exist; the last event is the state.
#   armed (root `arm`, stopped DB at N) | rearmed (root `rearm`, stopped DB unchanged at N)  -> pending: one anchored start
#   consumed (THIS wrapper, under the lock, durably, BEFORE execve)  -> refuse every start until root `rearm`
#   rolled-back (root)  -> terminal
#   bootstrapped (root `record-finality`: a qualified post-anchor finality proof N' > N, recorded as a finality-proof watermark
#                 entry; a newer proof appends another) -> no start by itself
#   restart-permitted (r5: root `permit-restart`: the STOPPED DB proven by the harness at/above the latest recorded floor, the
#                 DB file's exact dev/ino/size/mtime recorded) -> ONE ordinary start WITHOUT the anchor (never replayed): this
#                 wrapper consumes it as `restarted` only if the DB file is byte-identity-unchanged since the permit
#   restarted    -> running; finality is stale until a new proof (readiness gate post-anchor-finality); a crash needs a new permit
#                 (r6: issued unattended by enclave-base-restart-permit.service: the same harness checks, no human step)
#   finality-terminal (r6: the finality journal of this launch reached `contradicted` or `revoked`; finality_state appends this
#                 naming that entry, so an empty/other/truncated finality directory can never revive it) -> only rolled-back
# A launch that never reached `bootstrapped` keeps r7's rule: after `consumed` only `rearm` (DB unchanged at N) or rollback.
JOURNAL_NEXT = {None: {'armed'}, 'armed': {'consumed', 'rolled-back'}, 'rearmed': {'consumed', 'rolled-back'},
                'consumed': {'rearmed', 'rolled-back', 'bootstrapped', 'finality-terminal'},
                'bootstrapped': {'bootstrapped', 'restart-permitted', 'rolled-back', 'finality-terminal'},
                'restart-permitted': {'restarted', 'rolled-back', 'finality-terminal'},
                'restarted': {'bootstrapped', 'restart-permitted', 'rolled-back', 'finality-terminal'},
                'finality-terminal': {'rolled-back'}, 'rolled-back': set()}
PENDING = {'armed', 'rearmed'}
JOURNAL_ENTRY = re.compile(r'[0-9]{6}\.json')
JOURNAL_PARTIAL = re.compile(r'\.partial-[0-9]+')
MAX_JOURNAL = 4096

def _now():
    return time.time()

def _secure_path(path, owner, leaf='file', top=None):
    """`path` and every component from `top` (default TRUSTED_TOP = /) down to it are real (non-symlink) entries owned by
    `owner` and not group/other writable; the leaf is a regular file (or a directory). Returns the leaf's lstat."""
    top = pathlib.Path(top or TRUSTED_TOP); p = pathlib.Path(path)
    assert p.is_absolute() and '..' not in p.parts and (p == top or top in p.parents), f'{p} is not a plain path under {top}'
    cur, st = top, None
    for part in [None] + list(p.relative_to(top).parts):
        if part is not None:
            cur = cur / part
        st = os.lstat(cur)
        assert not stat.S_ISLNK(st.st_mode), f'{cur} is a symlink'
        assert st.st_uid == owner and not st.st_mode & 0o022, f'{cur} is not owner-{owner} and non-writable by group/other'
    assert (stat.S_ISREG if leaf == 'file' else stat.S_ISDIR)(st.st_mode), f'{p} is not a regular {leaf}'
    return st

def _fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def _instant(s, what):
    try:
        t = datetime.datetime.fromisoformat(s)
    except (TypeError, ValueError):
        raise AssertionError(f'{what} is not an ISO timestamp')
    assert t.tzinfo is not None, f'{what} has no timezone'
    return t.timestamp()

def base_release(manifest, owner=None):
    """None (legacy bin/base, unchanged) unless manifest.json pins the reviewed release; then its verified path."""
    owner = ROOT_UID if owner is None else owner
    rel = manifest.get('baseRelease')
    if rel is None:
        return None
    assert isinstance(rel, dict) and set(rel) == {'path', 'sha256'}, 'baseRelease must be exactly {path, sha256}'
    assert rel['sha256'] == BASE_RELEASE_SHA256, 'baseRelease is not the reviewed M7+M10 release'
    assert rel['path'] == str(BASE_RELEASE_PATH), 'baseRelease path is not the reviewed versioned path'
    # coverage_activation binds MANIFEST.binaries.base: the coverage receipt/origin must be requalified for THIS binary
    assert (manifest.get('binaries') or {}).get('base') == BASE_RELEASE_SHA256, \
        'binaries.base must name the release, so coverage evidence is bound to the binary that runs'
    _secure_path(rel['path'], owner)
    with open(rel['path'], 'rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == BASE_RELEASE_SHA256, 'release binary pin mismatch'
    return rel['path']

def launch_lock(directory=None, owner=None, top=None):
    """The ONE launch lock: an exclusive, NON-blocking flock on the root-owned BOOTSTRAP_DIR/journal.lock (created by root
    `arm`, never here). The wrapper takes it before its first gate and holds it to execve (O_CLOEXEC: the exec, or any
    death, releases it); root `arm`/`rearm`/`rollback` take the same lock. A concurrent start refuses, consuming nothing."""
    directory = pathlib.Path(directory or BOOTSTRAP_DIR); owner = ROOT_UID if owner is None else owner
    _secure_path(directory, owner, leaf='dir', top=top)
    p = directory / 'journal.lock'
    try:
        fd = os.open(p, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise AssertionError(f'launch lock {p.name} unavailable ({type(e).__name__}): root `arm` creates it')
    try:
        st, ln = os.fstat(fd), os.lstat(p)
        assert stat.S_ISREG(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o077 \
            and (st.st_dev, st.st_ino) == (ln.st_dev, ln.st_ino), 'launch lock is not a private regular file of the owner'
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AssertionError('launch lock busy: another start or a root journal operation holds it (refusing; nothing consumed)')
    except BaseException:
        os.close(fd)
        raise
    return fd

def launch_record(cfg, release_sha, directory=None, owner=None, top=None):
    """The IMMUTABLE launch record pinned in chain.json baseBootstrap.anchorLaunch {launchSha256} (pinned once per launch
    record; the journal below is never pinned). -> (launchSha256, launch, N)."""
    bb = (cfg.get('baseBootstrap') or {}).get('anchorLaunch')
    directory = pathlib.Path(directory or BOOTSTRAP_DIR); owner = ROOT_UID if owner is None else owner
    for d in (directory, directory / 'qualification'):
        _secure_path(d, owner, leaf='dir', top=top)
    assert isinstance(bb, dict) and set(bb) == {'launchSha256'} and isinstance(bb['launchSha256'], str) \
        and HEX64.fullmatch(bb['launchSha256']), \
        'release mode needs baseBootstrap.anchorLaunch {launchSha256}: no implicit bootstrap path'
    l_sha, launch = _evidence(directory / 'launch.json', owner)
    assert l_sha == bb['launchSha256'], 'launch record bytes differ from the operator pin'
    assert launch.get('format') == LAUNCH_FORMAT, 'launch record format'
    assert launch.get('baseReleaseSha256') == release_sha == BASE_RELEASE_SHA256, 'launch record is for another binary'
    m = ANCHOR_RE.fullmatch(str(launch.get('anchor', '')))
    assert m, 'launch anchor is not <number>:0x<64 lower-case hex>'
    q = launch.get('qualification')
    assert isinstance(q, dict) and set(q) == {'m10LaunchSha256', 'a2Sha256', 'a4Sha256', 'bytecodesVerifiedSha256'}, \
        'launch record lacks the A2-A4 qualification hashes'
    files = {'m10LaunchSha256': 'm10-launch.json', 'a2Sha256': 'a2-authenticated.json', 'a4Sha256': 'a4-rebuilt.json',
             'bytecodesVerifiedSha256': 'bytecodes-verified.json'}
    got = {k: _evidence(directory / 'qualification' / f, owner) for k, f in files.items()}
    for k, (sha, _doc) in got.items():
        assert sha == q[k], f'qualification {files[k]} bytes differ from the launch record'
    assert got['m10LaunchSha256'][1].get('bootstrapAnchor') == launch['anchor'], 'launch anchor is not the A2-A4 release anchor'
    assert got['bytecodesVerifiedSha256'][1].get('a4Sha256') == q['a4Sha256'], 'bytecode verification is for another A4 result'
    _instant(launch.get('notAfter'), 'launch notAfter')
    return l_sha, launch, int(m.group(1))

def _anchor_n(launch):
    m = ANCHOR_RE.fullmatch(str(launch.get('anchor', '')))
    assert m, 'launch anchor is not <number>:0x<64 lower-case hex>'
    return int(m.group(1))

def launch_lineage(launch, archive=None, owner=None, top=None):
    """The launch's predecessor chain through BOOTSTRAP_ARCHIVE -> [anchor, ...] newest first. Each predecessor must be the
    archived launch record named by its sha, terminally rolled back at exactly the named journal entry; anchors never move
    backward (an equal height only for the identical anchor); and every archived launch must be in the chain. A first-bootstrap
    launch (no predecessor) is therefore accepted only while the archive is empty."""
    archive = pathlib.Path(archive or BOOTSTRAP_ARCHIVE); owner = ROOT_UID if owner is None else owner
    archived = set()
    if os.path.lexists(archive):
        _secure_path(archive, owner, leaf='dir', top=top)
        archived = set(os.listdir(archive))
    chain, seen, cur = [launch.get('anchor')], [], launch
    while cur.get('predecessor') is not None:
        p = cur['predecessor']
        assert isinstance(p, dict) and set(p) == {'launchSha256', 'rolledBackEntrySha256', 'anchor'} \
            and all(isinstance(p[k], str) and HEX64.fullmatch(p[k]) for k in ('launchSha256', 'rolledBackEntrySha256')), \
            'lineage: malformed predecessor'
        name = p['launchSha256']
        assert name in archived and name not in seen and len(seen) < MAX_LINEAGE, \
            f'lineage: predecessor {name[:12]} is not an archived launch (or repeats)'
        d = archive / name
        _secure_path(d, owner, leaf='dir', top=top)
        p_sha, prev = _evidence(d / 'launch.json', owner)
        assert p_sha == name and prev.get('format') == LAUNCH_FORMAT and prev.get('anchor') == p['anchor'], \
            'lineage: the archived launch record differs from its name or the named anchor'
        assert _anchor_n(prev) < _anchor_n(cur) or prev['anchor'] == cur.get('anchor'), \
            'lineage: the anchor moved backward (or changed at the same height)'
        entries = journal_entries(d / 'journal', owner, p_sha, top)
        assert entries[-1][1]['event'] == 'rolled-back' and entries[-1][0] == p['rolledBackEntrySha256'], \
            'lineage: the predecessor is not terminally rolled back at the named journal entry'
        seen.append(name); chain.append(prev['anchor']); cur = prev
    assert set(seen) == archived, f"lineage: archived launches outside this launch's lineage: {sorted(archived - set(seen))[:3]}"
    return chain

def watermark_entries(store=None, owner=None, top=None):
    """The verified watermark chain -> [(sha256, entry)] oldest first; [] if the store is absent or empty. Same rules as the
    harness: root-owned, no symlinks, contiguous seq, hash chain, never regressing, one block per height."""
    store = pathlib.Path(store or BOOTSTRAP_WATERMARK); owner = ROOT_UID if owner is None else owner
    if not os.path.lexists(store):
        return []
    _secure_path(store, owner, leaf='dir', top=top)
    out, prev = [], None
    for name in sorted(os.listdir(store)):
        if JOURNAL_PARTIAL.fullmatch(name):
            continue
        assert JOURNAL_ENTRY.fullmatch(name) and int(name[:6]) == len(out) + 1 <= MAX_JOURNAL, f'watermark: unexpected entry {name}'
        e_sha, e = _evidence(store / name, owner)
        assert set(e) == WATERMARK_KEYS and e['format'] == WATERMARK_FORMAT and e['seq'] == len(out) + 1 and e['prevSha256'] == prev \
            and type(e['number']) is int and re.fullmatch(r'0x[0-9a-f]{64}', str(e['blockHash'])) and e['kind'] in WATERMARK_KINDS \
            and isinstance(e['ref'], str) and HEX64.fullmatch(e['ref']), f'watermark: chain broken at {name}'
        if out:
            q = out[-1][1]
            assert e['number'] > q['number'] or (e['number'] == q['number'] and e['blockHash'] == q['blockHash']), \
                f'watermark: regresses or conflicts at {name}'
        out.append((e_sha, e)); prev = e_sha
    return out

def watermark_append(store, owner, entries, number, block_hash, kind, ref, at, top=None):
    """Durable append (fsynced sibling, link, directory fsync, re-verify); the caller holds the launch lock. Root only."""
    store = pathlib.Path(store)
    doc = {'format': WATERMARK_FORMAT, 'seq': len(entries) + 1, 'prevSha256': entries[-1][0] if entries else None, 'number': number,
           'blockHash': block_hash, 'kind': kind, 'ref': ref, 'at': at}
    b = json.dumps(doc, indent=1, sort_keys=True).encode()
    for name in os.listdir(store):
        if JOURNAL_PARTIAL.fullmatch(name):
            os.unlink(store / name)
    tmp = store / f'.partial-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        view = memoryview(b)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.link(tmp, store / f'{doc["seq"]:06d}.json')
    os.unlink(tmp)
    _fsync_dir(store)
    after = watermark_entries(store, owner, top)
    assert len(after) == doc['seq'] and after[-1][1] == doc, 'watermark append did not land (or broke the rules)'
    return after

def launch_watermark(launch, l_sha, store=None, owner=None, top=None):
    """A first-bootstrap launch (no predecessor, no watermark binding) is unchanged. A re-anchor launch starts only while the
    latest accepted watermark entry is this launch's anchor (root `arm` recorded it; nothing was accepted after it)."""
    if launch.get('predecessor') is None and launch.get('watermark') is None:
        # r6: the floor is GLOBAL. A first-bootstrap launch starts only while no accepted finality floor exists at all (a deleted or
        # un-retired earlier launch never lets a new first bootstrap start below its recorded finality): otherwise re-anchor.
        assert not watermark_entries(store, owner, top), \
            'watermark: an accepted authenticated-finality floor exists: a first-bootstrap launch never starts; re-anchor at or above it'
        return None
    assert isinstance(launch.get('watermark'), dict), 'watermark: a re-anchor launch must bind the authenticated-finality watermark'
    es = watermark_entries(store, owner, top)
    n, h = _anchor_n(launch), launch['anchor'].split(':')[1]
    assert es and es[-1][1]['kind'] == 'launch-anchor' and es[-1][1]['ref'] == l_sha and (es[-1][1]['number'], es[-1][1]['blockHash']) == (n, h), \
        "watermark: the latest accepted authenticated-finality entry is not this launch's anchor (not armed, or changed since): refusing"
    return es[-1][0]

def launch_finality(launch, l_sha, entries, store=None, owner=None, top=None):
    """r4: the watermark entries this launch's recorded finality proofs added -> [(sha256, entry)]. The entries after this launch's
    own launch-anchor (re-anchor) - or ALL entries (first bootstrap: `arm` writes none, so its first proof sets the floor) - must be
    exactly the finality-proof entries named by the journal's `bootstrapped` events, in order. Another launch armed since, a
    foreign entry or an interrupted record refuses (the producer adopts an interrupted record; never this wrapper)."""
    es = watermark_entries(store, owner, top)
    if launch.get('predecessor') is None and launch.get('watermark') is None:
        assert not any(e['kind'] == 'launch-anchor' for _, e in es), "watermark: a first-bootstrap launch finds a launch anchor in the store"
        own = es
    else:
        n, h = _anchor_n(launch), launch['anchor'].split(':')[1]
        at = [i for i, (_, e) in enumerate(es) if e['kind'] == 'launch-anchor' and e['ref'] == l_sha and (e['number'], e['blockHash']) == (n, h)]
        assert at, "watermark: this launch's anchor is not in the accepted watermark"
        own = es[at[-1] + 1:]
    named = [e.get('evidence', {}).get('watermarkEntrySha256') for _, e in entries if e.get('event') == 'bootstrapped']
    assert [x for x, _ in own] == named and all(e['kind'] == 'finality-proof' for _, e in own), \
        "watermark: the entries after this launch's anchor are not exactly its recorded finality proofs"
    return own

def journal_entries(jd, owner, launch_sha, top=None):
    """The verified journal -> [(sha256, entry)], oldest first. Refuses on any symlink, foreign owner, writable mode,
    unexpected name, gap, broken hash chain, other launch record, or transition outside JOURNAL_NEXT. `.partial-<pid>`
    files are interrupted appends that were never linked into the journal: not entries."""
    jd = pathlib.Path(jd)
    _secure_path(jd, owner, leaf='dir', top=top)
    out, prev, last = [], None, None
    for name in sorted(os.listdir(jd)):
        if JOURNAL_PARTIAL.fullmatch(name):
            continue
        assert JOURNAL_ENTRY.fullmatch(name) and int(name[:6]) == len(out) + 1 <= MAX_JOURNAL, f'unexpected journal entry {name}'
        e_sha, e = _evidence(jd / name, owner)
        assert e.get('format') == JOURNAL_FORMAT and e.get('launchSha256') == launch_sha and e.get('seq') == len(out) + 1 \
            and e.get('prevSha256') == prev, f'journal chain broken at {name}'
        assert e.get('event') in JOURNAL_NEXT[last], f'journal transition {last!r} -> {e.get("event")!r} is not allowed'
        out.append((e_sha, e)); prev, last = e_sha, e['event']
    assert out, 'no launch journal: root `arm` starts it'
    return out

def journal_append(jd, owner, launch_sha, entries, event, evidence, at, top=None):
    """Durable append; the CALLER HOLDS the launch lock. A fully written, fsynced sibling is hard-linked to the next seq
    name (link never replaces an entry), then the directory is fsynced and the journal re-verified. Only when this returns
    is the event on disk. A crash before the link leaves the old state (plus an ignorable .partial-<pid>)."""
    jd = pathlib.Path(jd)
    last = entries[-1][1]['event'] if entries else None
    assert event in JOURNAL_NEXT[last], f'journal transition {last!r} -> {event!r} is not allowed'
    doc = {'format': JOURNAL_FORMAT, 'launchSha256': launch_sha, 'seq': len(entries) + 1,
           'prevSha256': entries[-1][0] if entries else None, 'event': event, 'at': at, 'evidence': evidence}
    b = json.dumps(doc, indent=1, sort_keys=True).encode()
    for name in os.listdir(jd):
        if JOURNAL_PARTIAL.fullmatch(name):
            os.unlink(jd / name)                    # an earlier interrupted append (safe: we hold the lock)
    tmp = jd / f'.partial-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        view = memoryview(b)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.link(tmp, jd / f'{doc["seq"]:06d}.json')
    os.unlink(tmp)
    _fsync_dir(jd)
    after = journal_entries(jd, owner, launch_sha, top=top)
    assert len(after) == doc['seq'] and after[-1][1] == doc, 'journal append did not land'
    return after

def launch_handshake(lock_fd, cfg, release_sha, directory=None, owner=None, top=None, datadir=None):
    """Release mode, with the launch lock HELD since before the first gate and every existing gate passed:
    -> ['--bootstrap.anchor', 'N:0x..'] after DURABLY consuming the pending journal state; the caller execs in this same
    process with no further decision. Nothing here infers a start or a completion from a PID, a unit state or a log."""
    assert isinstance(lock_fd, int), 'the launch lock is not held'
    directory = pathlib.Path(directory or BOOTSTRAP_DIR); owner = ROOT_UID if owner is None else owner
    l_sha, launch, _n = launch_record(cfg, release_sha, directory, owner, top)
    launch_lineage(launch, None, owner, top)                 # predecessor chain + archive coverage, before anything is consumed
    entries = journal_entries(directory / 'journal', owner, l_sha, top)
    state = entries[-1][1]['event']
    bound = (launch.get('bindings') or {}).get('datadir')
    # r6: the datadir the node will SERVE (the mount's) is the one the launch record binds, never a look-alike path
    assert isinstance(bound, str) and (datadir is None or os.path.realpath(datadir) == os.path.realpath(bound)), \
        'the node would serve another datadir than the launch record binds: refusing'
    if state == 'finality-terminal':
        raise AssertionError('finality of this launch is contradicted or revoked (terminal): only rollback; nothing started')
    if state in ('bootstrapped', 'restarted'):
        raise AssertionError('bootstrapped launch: an ordinary restart needs root `permit-restart` first (the STOPPED DB proven at or '
                             'above its recorded finality floor); nothing started')
    if state == 'restart-permitted':
        # r5: ONE ordinary start of the same DB, without --bootstrap.anchor (never replayed). The permit names the latest recorded
        # floor and the DB file's exact identity at the harness check; any write since (an in-place rollback, a restore) refuses.
        own = launch_finality(launch, l_sha, entries, None, owner, top)
        permit = entries[-1][1].get('evidence') or {}
        assert own and permit.get('floor') == {'entrySha256': own[-1][0], 'number': own[-1][1]['number'], 'blockHash': own[-1][1]['blockHash']}, \
            'restart permit is not for the latest recorded finality floor: refusing'
        want = ((launch.get('bindings') or {}).get('dbIdentity') or {}).get('mdbx') or {}
        st = os.stat(pathlib.Path((launch.get('bindings') or {}).get('datadir', '/nonexistent'), 'db', 'mdbx.dat'))
        now_id = {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns}
        assert (st.st_dev, st.st_ino) == (want.get('dev'), want.get('ino')) and now_id == permit.get('mdbx'), \
            'the DB file changed since the restart permit (or is not the launch DB): refusing; root re-runs permit-restart'
        assert reviewed('LAUNCH_PRODUCER_REVIEWED'), 'HOLD: the launch-record producer is not reviewed (nothing started)'
        journal_append(directory / 'journal', owner, l_sha, entries, 'restarted', {'permitEntrySha256': entries[-1][0], 'pid': os.getpid()},
                       datetime.datetime.fromtimestamp(_now(), datetime.timezone.utc).isoformat(), top)
        return []
    launch_watermark(launch, l_sha, None, owner, top)        # r2: the accepted watermark is this launch's anchor
    if state in PENDING:
        # r6: the anchored start opens EXACTLY the DB file the launch record bound and arm/rearm proved unchanged at N (dev, ino,
        # size, mtime): a datadir the service user rewrote in place since then (cp/dd over the inode, unwind) refuses
        want = ((launch.get('bindings') or {}).get('dbIdentity') or {}).get('mdbx') or {}
        st = os.stat(pathlib.Path(bound, 'db', 'mdbx.dat'))
        assert {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns} == want, \
            'the DB file changed since the launch record bound it (rewritten in place?): refusing; root rearm proves it again'
    assert state != 'consumed', (f'bootstrap anchor already consumed (journal seq {len(entries)}): refusing; the anchor is '
                                 'never replayed - only root `rearm` with the stopped DB proven unchanged at N re-opens it')
    assert state != 'rolled-back', 'bootstrap launch rolled back (terminal): a new launch record and journal are required'
    assert state in PENDING, f'bootstrap journal state {state!r}: refusing (root must resolve it explicitly)'
    assert _now() <= _instant(launch['notAfter'], 'launch notAfter'), \
        'launch record expired (now > notAfter): nothing consumed; a fresh A1 recheck, release and launch record are required'
    assert reviewed('LAUNCH_PRODUCER_REVIEWED'), 'HOLD: the launch-record producer is not reviewed (nothing consumed)'
    try:
        with open('/proc/sys/kernel/random/boot_id') as f:
            boot = f.read().strip()
    except OSError:
        boot = None
    evidence = {'anchor': launch['anchor'], 'baseReleaseSha256': release_sha, 'pid': os.getpid(), 'bootId': boot,
                'invocationId': os.environ.get('INVOCATION_ID'), 'note': 'audit only; never used to infer a start or completion'}
    journal_append(directory / 'journal', owner, l_sha, entries, 'consumed', evidence,
                   datetime.datetime.fromtimestamp(_now(), datetime.timezone.utc).isoformat(), top)
    return ['--bootstrap.anchor', launch['anchor']]

def release_launch_lock(manifest):
    """Legacy mode (no baseRelease): None, and nothing else changes - unless the root release-mode unit drop-in is still
    installed, which is refused (bin/base must never run from a root start). Release mode: root euid AND the drop-in's
    marker, then the held launch lock."""
    if manifest.get('baseRelease') is None:
        assert os.environ.get(HANDSHAKE_ENV) is None, 'legacy bin/base under the root release-mode unit drop-in: refusing'
        return None
    assert os.environ.get(HANDSHAKE_ENV) == '1' and os.geteuid() == ROOT_UID, \
        'release mode needs the root one-shot launch handshake (reviewed unit drop-in): refusing'
    return launch_lock()

def service_identity(user=None):
    """The unit's service account, resolved BEFORE anything is consumed. Never root."""
    pw = pwd.getpwnam(user or BASE_SERVICE_USER)
    assert pw.pw_uid != 0 and pw.pw_gid != 0, 'the Base service user must not be root'
    return pw

def drop_privileges(pw):
    """root -> the service account in THIS process, right before execve: the identity User=/Group= gave the legacy unit
    (initgroups), all three ids, verified irreversible."""
    os.initgroups(pw.pw_name, pw.pw_gid)
    os.setresgid(pw.pw_gid, pw.pw_gid, pw.pw_gid)
    os.setresuid(pw.pw_uid, pw.pw_uid, pw.pw_uid)
    assert os.getresuid() == (pw.pw_uid,) * 3 and os.getresgid() == (pw.pw_gid,) * 3, 'privilege drop incomplete'
    try:
        os.setuid(0)
    except PermissionError:
        return
    raise AssertionError('privilege drop is reversible: refusing to exec')

def run(side):
    # Release mode holds the one-shot launch lock from here, across EVERY gate, until execve (O_CLOEXEC) releases it;
    # a refusal in this process releases it too. Legacy mode and el/cl: lock is None, nothing changes.
    lock = release_launch_lock(MANIFEST) if side == 'base' else None
    try:
        _start(side, lock)
    finally:
        if lock is not None:
            os.close(lock)

def _start(side, lock):
    role = 'base' if side == 'base' else 'l1'
    base = mount(role, side)
    if side in ('el', 'base'):
        assert pathlib.Path(base, 'snapshot-complete').is_file(), 'snapshot is incomplete'
    datadir = base + ('/cl' if side == 'cl' else '/data')
    if side in ('el', 'base'):
        profile = tomllib.loads(pathlib.Path(datadir, 'reth.toml').read_text())
        assert profile.get('static_files', {}).get('blocks_per_file'), 'snapshot segment sizes missing'
        history_from = history_from_block(CONFIG, required=False) if side == 'base' else None
        state_from = state_history_from_block(CONFIG, required=False) if side == 'base' else None
        prune = prune_args(profile, history_from, state_from)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': datadir, 'TMPDIR': base + ('/tmp-cl' if side == 'cl' else '/tmp')}
    jwt = '/etc/enclave-rpc/jwt.hex'
    if side == 'el':
        # The snapshot wrote the exact 140000-block prune profile to reth.toml. Pass all of it (never --full,
        # a different preset): any partial --prune.* set would replace the persisted profile.
        a = [binary('reth'), 'node', '--chain', 'mainnet', '--datadir', datadir,
             '--http', '--http.addr', '127.0.0.1', '--http.port', '18645', '--http.api', 'eth,net,web3',
             *prune,
             # reth's proof window defaults to 0, which refuses eth_getProof (and so light-client-verified eth_call)
             # at finalized. 256 blocks (~51 min at 12 s) exceeds the 1800 s maximum finalized age; 2 permits bound the cost.
             '--rpc.max-connections', '64', '--rpc.eth-proof-window', '256', '--rpc.proof-permits', '2',
             '--authrpc.addr', '127.0.0.1', '--authrpc.port', '18651',
             # witness-rpc-access: a PRIVATE IPC socket (mode 0600, in the node's own 0750 tmp subtree, never forwarded) replaces
             # --ipcdisable; HTTP keeps eth,net,web3. IPC serves all modules: only the node user/root reach it, and the loopback
             # witness bridge (bridge/witness_rpc_bridge.py) relays only its read-only allowlist
             '--authrpc.jwtsecret', jwt, '--ipcpath', base + '/tmp/witness-el.ipc', '--ipc.permissions', '0600',
             '--addr', '0.0.0.0', '--port', '30313',
             '--discovery.addr', '0.0.0.0', '--discovery.port', '30313', '--discovery.v5.addr', '0.0.0.0',
             '--discovery.v5.port', '30314', '--nat', 'none', '--disable-dns-discovery',
             '--txpool.disable-transactions-backup', '--disable-tx-gossip', '--txpool.no-local-transactions-propagation',
             '--log.file.directory', datadir + '/logs', '--log.file.max-files', '5']
    elif side == 'cl':
        a = [binary('lighthouse'), 'beacon_node', '--network', 'mainnet', '--datadir', datadir,
             '--http', '--http-address', '127.0.0.1', '--http-port', '15052',
             '--execution-endpoint', 'http://127.0.0.1:18651', '--execution-jwt', jwt,
             '--listen-address', '0.0.0.0', '--port', '9310', '--quic-port', '9311', '--disable-upnp',
             '--target-peers', '100', '--semi-supernode', '--prune-blobs', 'true', '--blob-prune-margin-epochs', '0']
        if not pathlib.Path(datadir, 'beacon', 'chain_db').is_dir():
            ck = CONFIG['checkpoint']
            assert 0 <= time.time() - ck['stateTime'] < 14 * 86400, 'bootstrap checkpoint too old'
            for name in ('state', 'block'):
                path = pathlib.Path(base, 'anchor', name + '.ssz')
                with path.open('rb') as f:
                    assert hashlib.file_digest(f, 'sha256').hexdigest() == ck['files'][name]['sha256'], 'checkpoint pin mismatch'
            a += ['--checkpoint-state', base + '/anchor/state.ssz', '--checkpoint-block', base + '/anchor/block.ssz',
                  '--wss-checkpoint', ck['root'] + ':' + str(ck['epoch'])]
    elif side == 'base':
        origin, so = base_coverage(CONFIG, ROOT / 'manifest.json', (MANIFEST.get('binaries') or {}).get('base'))
        if origin.get('mode') == 'anchored-segments':
            anchored_launch_binding(origin, lock)
        history_from = history_from_block(CONFIG)
        state_from = state_history_from_block(CONFIG)
        snap = (origin.get('snapshot') or {}).get('block')
        assert _uint(snap) and history_from <= snap and state_from <= snap, \
            'Base retention start is above the verified snapshot block'
        history_files_present(datadir, profile, history_from)
        segment_files_present(datadir, profile, state_from, STATE_FILES)
        ready = l1_ready()
        assert ready['l1Finalized'] >= max(so['number'], origin['toBlock']), 'reviewed coverage range above our L1 finalized'
        canon = rpc(18645, 'eth_getBlockByNumber', [hex(so['number']), False])
        assert canon and str(canon.get('hash', '')).lower() == so['hash'], 'snapshot safe L1 origin not canonical on this L1'
        assert rpc(18645, 'eth_getBlockReceipts', [hex(origin['l1Block'])]) is not None, 'Base origin receipts absent'
        slot = str(origin['blobSlot'])
        commitments = beacon('/eth/v2/beacon/blocks/' + slot)['message']['body']['blob_kzg_commitments']
        assert commitments and len(beacon('/eth/v1/beacon/blobs/' + slot)) == len(commitments), 'Base origin blobs absent'
        # every gate above is unchanged (run under the held lock); the opt-in release adds its pinned path + the handshake
        release = base_release(MANIFEST)
        env['BASE_NODE_L1_TRUST_RPC'] = 'false'
        a = [release or binary('base'), '--chain', 'mainnet', 'rpc', '--datadir', datadir,
             '--http', '--http.addr', '127.0.0.1', '--http.port', '18545', '--http.api', 'eth,net,web3',
             '--txpool.disable-transactions-backup',
             *prune,
             '--rpc.max-connections', '64', '--rpc.eth-proof-window', '1800',
             '--ipcpath', base + '/tmp/witness-el.ipc', '--ipc.permissions', '0600',   # witness-rpc-access: private IPC (see the el argv)
             '--addr', '0.0.0.0', '--port', '30303', '--discovery.addr', '0.0.0.0', '--discovery.port', '30303',
             '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', '9200',
             '--rpc.addr', '127.0.0.1', '--rpc.port', '19545', '--p2p.listen.ip', '0.0.0.0',
             '--p2p.listen.tcp', '9222', '--p2p.listen.udp', '9223',
             '--l1-eth-rpc', 'http://127.0.0.1:18645', '--l1-beacon', 'http://127.0.0.1:15052',
             '--l1.rpc-timeout-ms', '10000', '--upgrade-signal.mode', 'metrics-only']
        a += forwarding_args()
        # A forwarded hash is not inclusion: consumers must verify the receipt.
        if lock is not None:
            account = service_identity()
            # M10: the journal is durably consumed BEFORE the exec below; this process then execs with no other decision
            a += launch_handshake(lock, CONFIG, BASE_RELEASE_SHA256, datadir=datadir)
            drop_privileges(account)
    else:
        raise ValueError('unknown side')
    print(json.dumps({'starting': side, 'datadir': datadir, 'publicExecutionRpc': False}), flush=True)
    os.execve(a[0], a, env)

def main(argv):
    if argv == ['l1-ready']:
        print(json.dumps(l1_ready()))
    elif argv == ['coverage-identity']:
        # Read-only: the exact pins a coverage acceptance receipt must bind for THIS install.
        with (ROOT / 'manifest.json').open('rb') as f:
            msha = hashlib.file_digest(f, 'sha256').hexdigest()
        snap = COVERAGE_DIR / 'snapshot-manifest.json'
        ssha = None
        if snap.is_file() and not snap.is_symlink():
            with snap.open('rb') as f:
                ssha = hashlib.file_digest(f, 'sha256').hexdigest()
        # snapshotManifestSha256 is NEVER derived from the install: it names the saved downloaded snapshot manifest.
        print(json.dumps({'bootstrapManifestSha256': msha, 'snapshotManifestSha256': ssha,
                          'snapshotManifestUrl': (MANIFEST.get('snapshotManifests') or {}).get('base'),
                          'chainConfigSha256': config_identity(CONFIG),
                          'baseBinarySha256': (MANIFEST.get('binaries') or {}).get('base'),
                          'kzgcheckSha256': KZGCHECK_SHA256, 'evidenceDir': str(COVERAGE_DIR)}, sort_keys=True))
    elif argv == ['coverage-check']:
        # Read-only offline validation of the installed activation evidence; no L1 call, never starts a client.
        print(json.dumps(base_coverage(CONFIG, ROOT / 'manifest.json', (MANIFEST.get('binaries') or {}).get('base'))[0],
                         sort_keys=True))
    elif len(argv) == 1 and argv[0] in ('el', 'cl', 'base'):
        run(argv[0])
    else:
        raise SystemExit('usage: chain_service.py el|cl|base|l1-ready|coverage-identity|coverage-check')

if __name__ == '__main__':
    main(sys.argv[1:])
