#!/usr/bin/env python3
"""Run one pinned chain client on the RPC VM's dedicated ext4 volumes.

This is the direct virtual-disk deployment adapter. It does not use the older
loop-image/NBD storage launchers. No public execution RPC is configured here.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import tomllib
import urllib.parse
import urllib.request
import urllib.error

ROOT = pathlib.Path('/var/lib/enclave-rpc-nan-client-n6/payload')
MANIFEST = json.loads((ROOT / 'manifest.json').read_text())
DISKS = json.loads((ROOT / 'disks.json').read_text())['disks']
CONFIG = json.loads((ROOT / 'chain.json').read_text())

def mounted_identity(expected, target, filesystem_root, receipt):
    raw=subprocess.check_output(['/usr/bin/findmnt','--json','-o','MAJ:MIN,FSTYPE,VFS-OPTIONS,FSROOT,TARGET','--mountpoint',target],text=True,timeout=3)
    assert len(raw)<=65536,'mount-record-size'
    rows=json.loads(raw)['filesystems'];assert len(rows)==1,'mount-record-count'
    row=rows[0]
    assert row['target']==target and row['maj:min']==receipt['device'] and row['fstype']=='ext4' and row['fsroot']==filesystem_root,'mount-device-or-root:'+json.dumps(row,sort_keys=True)
    options=set(row['vfs-options'].split(','))
    assert {'nosuid','nodev','noexec','nosymfollow'}.issubset(options),'mount-confinement'
    assert ('ro' if filesystem_root=='/' else 'rw') in options,'mount-write-policy'
    rel='' if target==expected else target[len(expected)+1:]
    st=os.stat(target,follow_symlinks=False);identity=receipt['directories'][rel]
    assert stat.S_ISDIR(st.st_mode) and st.st_dev==identity['dev'] and st.st_ino==identity['ino'],'mount-directory-identity'
    assert str(os.major(st.st_dev))+':'+str(os.minor(st.st_dev))==receipt['device'],'mount-stat-device'
    if rel:assert (st.st_uid,st.st_gid)==(50011,50011),'mount-mapped-owner'

def mount(role, side):
    # This trial supports only the independently identified Nan CL volume.
    assert role=='l1' and side=='cl','trial-role'
    d=next(d for d in DISKS if d['role']==role);expected=MANIFEST['mounts'][role]
    assert d['mount']==expected and os.path.ismount(expected),'dedicated mount absent'
    for directory in (ROOT,*ROOT.parents):
        st=directory.lstat()
        assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and not st.st_mode&0o022,'receipt-parent-authority'
    fd=os.open(ROOT/'mount-identity.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o444 and st.st_nlink==1 and st.st_size<=8192,'receipt-authority'
        raw=os.read(fd,8193);assert len(raw)==st.st_size,'receipt-size'
    finally:os.close(fd)
    receipt=json.loads(raw)
    assert receipt['nonce']==MANIFEST['trialMountNonce'] and receipt['mount']==expected and receipt['uuid']==d['uuid'],'receipt-binding'
    assert receipt['bootId']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() and 0<=time.time()-receipt['createdAt']<=300,'receipt-freshness'
    identity=receipt['filesystemIdentity']
    assert identity['uuid']==d['uuid'] and identity['state']==1 and identity['bytesRead']==4096 and identity['offset']==0 and identity['direct'] is True,'receipt-superblock-proof'
    mounted_identity(expected,expected,'/',receipt)
    for rel in ('cl','tmp-cl'):mounted_identity(expected,expected+'/'+rel,'/'+rel,receipt)
    return expected

def binary(name):
    path = ROOT / 'bin' / name
    with path.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == MANIFEST['binaries'][name], 'binary pin mismatch'
    return str(path)

def rpc(port, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}', body, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.load(r)
    assert 'error' not in result and 'result' in result, 'local RPC failed'
    return result['result']

def beacon(path):
    with urllib.request.urlopen('http://127.0.0.1:15052' + path, timeout=10) as r:
        return json.load(r)['data']

def l1_ready():
    assert rpc(18645, 'eth_chainId', []) == '0x1'
    assert rpc(18645, 'eth_getBlockByNumber', ['0x0', False])['hash'] == '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3', 'wrong EL genesis'
    assert beacon('/eth/v1/beacon/genesis')['genesis_validators_root'] == '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95', 'wrong CL genesis'
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
    payload = beacon('/eth/v2/beacon/blocks/head')['message']['body']['execution_payload']
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
    return {'l1Block': int(h['number'], 16), 'l1Finalized': int(f['number'], 16), 'blobSlot': blob_slot}

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

def coverage_activation(cfg, manifest_path, base_binary_sha256, directory=COVERAGE_DIR, owner=0):
    """Offline, fail-closed validation of the activation evidence. Returns the bound bootstrap or raises AssertionError."""
    bb = cfg.get('baseBootstrap')
    assert isinstance(bb, dict) and bb.get('coverageVerified') is True, 'Base snapshot blob coverage not approved'
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

# Bounded trial profile, supported by the exact installed binary --help evidence.
# These are cache capacities, not a claim of resident memory use or full-stack fit.
LOW_MEMORY_PINS = {'base': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f', 'reth': '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250', 'lighthouse': '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'}
LOW_MEMORY_ARGS = {'base': ('--engine.cross-block-cache-size', '512', '--rpc-cache.max-blocks', '128', '--rpc-cache.max-receipts', '128', '--rpc-cache.max-headers', '256', '--rpc-cache.max-concurrent-db-requests', '8', '--rpc.max-blocking-io-requests', '4'), 'reth': ('--engine.cross-block-cache-size', '256', '--rpc-cache.max-blocks', '128', '--rpc-cache.max-receipts', '128', '--rpc-cache.max-blocks-bytes', '64MB', '--rpc-cache.max-receipts-bytes', '64MB', '--rpc-cache.max-bals-bytes', '32MB', '--rpc-cache.max-concurrent-db-requests', '8', '--rpc.max-blocking-io-requests', '4'), 'lighthouse': ('--state-cache-size', '2', '--hdiff-buffer-cache-size', '1', '--shuffling-cache-size', '1')}

def low_memory_args(name, existing):
    assert MANIFEST['binaries'].get(name) == LOW_MEMORY_PINS[name], 'memory profile binary not reviewed'
    extra = LOW_MEMORY_ARGS[name]
    assert not any(flag in existing for flag in extra[::2]), 'duplicate memory profile option'
    return list(extra)

def run(side):
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
    jwt = str(ROOT / 'jwt.hex')
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
             '--authrpc.jwtsecret', jwt, '--ipcdisable', '--addr', '0.0.0.0', '--port', '30313',
             '--discovery.addr', '0.0.0.0', '--discovery.port', '30313', '--discovery.v5.addr', '0.0.0.0',
             '--discovery.v5.port', '30314', '--nat', 'none', '--disable-dns-discovery',
             '--txpool.disable-transactions-backup', '--disable-tx-gossip', '--txpool.no-local-transactions-propagation',
             '--log.file.directory', datadir + '/logs', '--log.file.max-files', '5']
    elif side == 'cl':
        a = [binary('lighthouse'), '--debug-level', 'debug', 'beacon_node', '--network', 'mainnet', '--datadir', datadir,
             '--http', '--http-address', '127.0.0.1', '--http-port', '15052',
             '--execution-endpoint', 'http://127.0.0.1:18651', '--execution-jwt', jwt,
             '--listen-address', '0.0.0.0', '--port', '9310', '--quic-port', '9311', '--disable-upnp',
             '--target-peers', '100', '--semi-supernode', '--prune-blobs', 'true', '--blob-prune-margin-epochs', '0']
        assert pathlib.Path(datadir, 'beacon', 'chain_db').is_dir(), 'existing CL database required'
    elif side == 'base':
        origin = coverage_activation(CONFIG, ROOT / 'manifest.json', (MANIFEST.get('binaries') or {}).get('base'))
        history_from = history_from_block(CONFIG)
        state_from = state_history_from_block(CONFIG)
        snap = (origin.get('snapshot') or {}).get('block')
        assert _uint(snap) and history_from <= snap and state_from <= snap, \
            'Base retention start is above the verified snapshot block'
        history_files_present(datadir, profile, history_from)
        segment_files_present(datadir, profile, state_from, STATE_FILES)
        ready = l1_ready()
        so = origin['safeL1Origin']
        assert ready['l1Finalized'] >= max(so['number'], origin['toBlock']), 'reviewed coverage range above our L1 finalized'
        canon = rpc(18645, 'eth_getBlockByNumber', [hex(so['number']), False])
        assert canon and str(canon.get('hash', '')).lower() == so['hash'], 'snapshot safe L1 origin not canonical on this L1'
        assert rpc(18645, 'eth_getBlockReceipts', [hex(origin['l1Block'])]) is not None, 'Base origin receipts absent'
        slot = str(origin['blobSlot'])
        commitments = beacon('/eth/v2/beacon/blocks/' + slot)['message']['body']['blob_kzg_commitments']
        assert commitments and len(beacon('/eth/v1/beacon/blobs/' + slot)) == len(commitments), 'Base origin blobs absent'
        env['BASE_NODE_L1_TRUST_RPC'] = 'false'
        a = [binary('base'), '--chain', 'mainnet', 'rpc', '--datadir', datadir,
             '--http', '--http.addr', '127.0.0.1', '--http.port', '18545', '--http.api', 'eth,net,web3',
             '--txpool.disable-transactions-backup',
             *prune,
             '--rpc.max-connections', '64', '--rpc.eth-proof-window', '1800', '--ipcdisable',
             '--addr', '0.0.0.0', '--port', '30303', '--discovery.addr', '0.0.0.0', '--discovery.port', '30303',
             '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', '9200',
             '--rpc.addr', '127.0.0.1', '--rpc.port', '19545', '--p2p.listen.ip', '0.0.0.0',
             '--p2p.listen.tcp', '9222', '--p2p.listen.udp', '9223',
             '--l1-eth-rpc', 'http://127.0.0.1:18645', '--l1-beacon', 'http://127.0.0.1:15052',
             '--l1.rpc-timeout-ms', '10000', '--upgrade-signal.mode', 'metrics-only']
        a += forwarding_args()
        # A forwarded hash is not inclusion: consumers must verify the receipt.
    else:
        raise ValueError('unknown side')
    a += low_memory_args({'el': 'reth', 'cl': 'lighthouse', 'base': 'base'}[side], a)
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
        print(json.dumps(coverage_activation(CONFIG, ROOT / 'manifest.json', (MANIFEST.get('binaries') or {}).get('base')),
                         sort_keys=True))
    elif argv == ['cl']:
        run(argv[0])
    else:
        raise SystemExit('usage: chain_service.py el|cl|base|l1-ready|coverage-identity|coverage-check')

if __name__ == '__main__':
    main(sys.argv[1:])
