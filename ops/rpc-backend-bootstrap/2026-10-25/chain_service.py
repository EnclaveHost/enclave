#!/usr/bin/env python3
"""Run one pinned chain client on the RPC VM's dedicated ext4 volumes.

This is the direct virtual-disk deployment adapter. It does not use the older
loop-image/NBD storage launchers. No public execution RPC is configured here.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import tomllib
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

def run(side):
    role = 'base' if side == 'base' else 'l1'
    base = mount(role, side)
    if side in ('el', 'base'):
        assert pathlib.Path(base, 'snapshot-complete').is_file(), 'snapshot is incomplete'
    datadir = base + ('/cl' if side == 'cl' else '/data')
    if side in ('el', 'base'):
        profile = tomllib.loads(pathlib.Path(datadir, 'reth.toml').read_text())
        segments = profile.get('prune', {}).get('segments', {})
        assert segments.get('sender_recovery') == 'full', 'snapshot prune profile missing'
        assert profile.get('static_files', {}).get('blocks_per_file'), 'snapshot segment sizes missing'
        if side == 'base':
            assert segments.get('transaction_lookup') == 'full', 'Base minimal profile missing'
        else:
            for name in ('receipts', 'account_history', 'storage_history'):
                assert segments.get(name, {}).get('distance', 0) >= 140000, 'L1 retention too short'
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': datadir, 'TMPDIR': base + ('/tmp-cl' if side == 'cl' else '/tmp')}
    jwt = '/etc/enclave-rpc/jwt.hex'
    if side == 'el':
        # The snapshot wrote the exact 140000-block prune profile to reth.toml.
        # Do not override it with --full (which applies a different preset).
        a = [binary('reth'), 'node', '--chain', 'mainnet', '--datadir', datadir,
             '--http', '--http.addr', '127.0.0.1', '--http.port', '18645', '--http.api', 'eth,net,web3',
             '--rpc.max-connections', '64', '--authrpc.addr', '127.0.0.1', '--authrpc.port', '18651',
             '--authrpc.jwtsecret', jwt, '--ipcdisable', '--addr', '0.0.0.0', '--port', '30313',
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
        origin = CONFIG.get('baseBootstrap', {})
        assert origin.get('coverageVerified') is True, 'Base snapshot blob coverage not approved'
        l1_ready()
        assert rpc(18645, 'eth_getBlockReceipts', [hex(origin['l1Block'])]) is not None, 'Base origin receipts absent'
        slot = str(origin['blobSlot'])
        commitments = beacon('/eth/v2/beacon/blocks/' + slot)['message']['body']['blob_kzg_commitments']
        assert commitments and len(beacon('/eth/v1/beacon/blobs/' + slot)) == len(commitments), 'Base origin blobs absent'
        env['BASE_NODE_L1_TRUST_RPC'] = 'false'
        a = [binary('base'), '--chain', 'mainnet', 'rpc', '--datadir', datadir,
             '--http', '--http.addr', '127.0.0.1', '--http.port', '18545', '--http.api', 'eth,net,web3',
             '--rpc.max-connections', '64', '--rpc.eth-proof-window', '1800', '--ipcdisable',
             '--addr', '0.0.0.0', '--port', '30303', '--discovery.addr', '0.0.0.0', '--discovery.port', '30303',
             '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', '9200',
             '--rpc.addr', '127.0.0.1', '--rpc.port', '19545', '--p2p.listen.ip', '0.0.0.0',
             '--p2p.listen.tcp', '9222', '--p2p.listen.udp', '9223',
             '--l1-eth-rpc', 'http://127.0.0.1:18645', '--l1-beacon', 'http://127.0.0.1:15052',
             '--l1.rpc-timeout-ms', '10000', '--upgrade-signal.mode', 'metrics-only']
        # Submission is intentionally not enabled by this read-backend bootstrap.
        # Configure the separate, explicit sequencer/forced-inclusion path at cutover.
    else:
        raise ValueError('unknown side')
    print(json.dumps({'starting': side, 'datadir': datadir, 'publicExecutionRpc': False}), flush=True)
    os.execve(a[0], a, env)

if __name__ == '__main__':
    if sys.argv[1:] == ['l1-ready']:
        print(json.dumps(l1_ready()))
    elif len(sys.argv) == 2 and sys.argv[1] in ('el', 'cl', 'base'):
        run(sys.argv[1])
    else:
        raise SystemExit('usage: chain_service.py el|cl|base|l1-ready')
