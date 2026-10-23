#!/usr/bin/env python3
"""Enclave L1 data-source pair: a strict launcher for a NON-VALIDATING Ethereum mainnet execution + consensus pair
(official reth v2.8.0 + official Lighthouse v8.3.2) that serves the Base holder's L1 methods and blob data on loopback.

  l1pair.py validate CONFIG            check the config; print the canonical form, both argvs and envs
  l1pair.py render CONFIG OUTDIR       write argv/env, systemd units, the root storage recipe, the holder L1 fragment
  l1pair.py preflight CONFIG           read-only host checks (pins, help flags, placement, overlap, JWT, ports, memory)
  l1pair.py run-el CONFIG              supervise ONE reth child (unit enclave-l1-el)
  l1pair.py run-cl CONFIG              supervise ONE lighthouse beacon_node child (unit enclave-l1-cl)
  l1pair.py ready CONFIG [--need-from-block N] [--need-blobs-from-slot S]
                                       DATA readiness gate (read-only loopback probes); exit 0 only if every check passes
  l1pair.py checkpoint-inspect STATE_SSZ BLOCK_SSZ
                                       header fields of a checkpoint state/block (no hashing; Lighthouse verifies)

What it is:
  * the Base holder's L1 source (S's `l1.executionRpc` / `l1.beacon`): http://127.0.0.1:<el http>/ and
    http://127.0.0.1:<cl http>/. Both APIs and the engine API bind 127.0.0.1 only; nothing is advertised or granted.
  * a host-level service started from local disk + Ethereum P2P. No Enclave lease, Sia, Enclave RPC or public RPC
    on its start path. A checkpoint-sync URL is never a default; a file checkpoint is the provider-independent input.
What it is not:
  * not a validator: no keys, no deposits, no signing, no builder, no transaction sending (tx gossip is off).
  * not a proxy or verifier of someone else's L1: it IS the L1 node pair, verifying the chain itself.

Reuse: supervision (Supervisor, PDEATHSIG, group stop, sd_notify), sysfs placement and port checks come from the Base
holder launcher (vendor/holder/holder.py, byte-identical to S's final commit 6b9dae92); the root storage script is S's
holder-storage.sh.in, byte-identical, rendered with this pair's constants.
"""
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('enclave_holder_vendor', HERE / 'vendor' / 'holder' / 'holder.py')
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)
Refused, fail, only, integer, abspath = H.Refused, H.fail, H.only, H.integer, H.abspath

FORMAT = 'enclave-l1-pair/v1'
PINS = json.loads((HERE / 'PINS.json').read_text())
VENDOR = json.loads((HERE / 'vendor' / 'VENDOR.json').read_text())
MAIN = PINS['mainnet']
AGGREGATE_NVME_CAP = H.AGGREGATE_NVME_CAP        # 250,000,000,000: ALL cache allocations of this work together
NVME_TARGET = H.NVME_TARGET                      # 200,000,000,000 operational target
EL_APIS = ('eth', 'net', 'web3')                 # Base uses eth_* only; never admin, debug, trace, txpool, miner
MIN_RECEIPTS = PINS['retention']['minReceiptsBlocks']
TX_BROADCAST = ('disabled', 'local-raw-propagate')
NAME = 'enclave-l1-pair'
FORBIDDEN_MOUNT_ROOTS = ('/', '/tmp', '/var/tmp', '/dev', '/dev/shm', '/run', '/proc', '/sys', '/boot', '/home', '/root',
                         '/etc', '/usr', '/opt', '/var', '/vm', '/mnt/usb')


def _hex64(where, v):
    if not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v):
        fail(f'{where} must be 64 lowercase hex (record it at install; a placeholder is not a pin)')
    return v


def _inside(child, parent):
    return (child.rstrip('/') + '/').startswith(parent.rstrip('/') + '/')


def _overlap(a, b):
    return _inside(a, b) or _inside(b, a)


def _binary(where, b, pin):
    only(where, b, ['path', 'sha256', 'release', 'commit', 'releaseTarballSha256'],
         ['path', 'sha256', 'release', 'commit', 'releaseTarballSha256'])
    if b['release'] != pin['release'] or b['commit'] != pin['commit']:
        fail(f"{where}: release/commit must be the reviewed {pin['release']} {pin['commit']} (flags and chain support were "
             'reviewed against that source only)')
    if b['releaseTarballSha256'] != pin['tarballSha256']:
        fail(f'{where}.releaseTarballSha256 differs from the reviewed GitHub asset digest')
    _hex64(f'{where}.sha256', b['sha256'])
    if pin['binarySha256'] and b['sha256'] != pin['binarySha256']:
        fail(f"{where}.sha256 must be the reviewed binary {pin['binarySha256']}")
    return {'path': abspath(f'{where}.path', b['path']), 'sha256': b['sha256'], 'release': b['release'],
            'commit': b['commit'], 'releaseTarballSha256': b['releaseTarballSha256']}


def _checkpoint(k, cl_datadir):
    """How the beacon node gets its weak-subjectivity anchor. Never a silent URL."""
    only('consensus.checkpoint', k, ['mode', 'statePath', 'blockPath', 'stateSha256', 'blockSha256', 'wss', 'provenance',
                                     'url', 'oneTimeBootstrapUrlAcknowledged'], ['mode'])
    mode = k['mode']
    if mode == 'resume':
        only('consensus.checkpoint', k, ['mode'], ['mode'])
        return {'mode': 'resume'}
    if mode == 'genesis':
        fail('consensus.checkpoint.mode genesis is refused: lighthouse requires --allow-insecure-genesis-sync, which its '
             'own help says "DO NOT use on mainnet" (no long-range-attack protection; incompatible with DA checks)')
    if mode not in ('file', 'url'):
        fail('consensus.checkpoint.mode must be file (provider-independent), url (explicit one-time bootstrap) or resume')
    m = re.fullmatch(r'(0x[0-9a-f]{64}):([0-9]{1,10})', str(k.get('wss', '')))
    if not m:
        fail('consensus.checkpoint.wss must be "0x<64 lowercase hex block root>:<epoch>" (lighthouse --wss-checkpoint)')
    root, epoch = m.group(1), int(m.group(2))
    if epoch < MAIN['fuluForkEpoch']:
        fail('consensus.checkpoint.wss epoch predates Fulu: such an anchor is far outside any weak-subjectivity period')
    prov = k.get('provenance')
    if not isinstance(prov, list) or len(prov) < 2:
        fail('consensus.checkpoint.provenance must list >= 2 independent observations of the wss root '
             '[{source, observedRoot, observedAt}] (cross-checked before use; one source is one point of trust)')
    seen = set()
    for i, p in enumerate(prov):
        only(f'consensus.checkpoint.provenance[{i}]', p, ['source', 'observedRoot', 'observedAt'], ['source', 'observedRoot', 'observedAt'])
        if p['observedRoot'] != root:
            fail(f'consensus.checkpoint.provenance[{i}].observedRoot does not equal the wss root')
        src = str(p['source']).strip().lower()
        if not src or src in seen:
            fail('consensus.checkpoint.provenance sources must be distinct and non-empty')
        seen.add(src)
    out = {'mode': mode, 'wss': f'{root}:{epoch}', 'root': root, 'epoch': epoch, 'provenance': [dict(p) for p in prov]}
    if mode == 'file':
        only('consensus.checkpoint', k, ['mode', 'statePath', 'blockPath', 'stateSha256', 'blockSha256', 'wss', 'provenance'],
             ['mode', 'statePath', 'blockPath', 'stateSha256', 'blockSha256', 'wss', 'provenance'])
        out.update(statePath=abspath('consensus.checkpoint.statePath', k['statePath']),
                   blockPath=abspath('consensus.checkpoint.blockPath', k['blockPath']),
                   stateSha256=_hex64('consensus.checkpoint.stateSha256', k['stateSha256']),
                   blockSha256=_hex64('consensus.checkpoint.blockSha256', k['blockSha256']))
        if out['statePath'] == out['blockPath'] or any(_inside(p, cl_datadir) for p in (out['statePath'], out['blockPath'])):
            fail('checkpoint files must be two distinct files outside the beacon datadir')
        return out
    # url: an explicit, labelled ONE-TIME bootstrap from a remote beacon API; never permanent, never a default
    only('consensus.checkpoint', k, ['mode', 'url', 'wss', 'provenance', 'oneTimeBootstrapUrlAcknowledged'],
         ['mode', 'url', 'wss', 'provenance', 'oneTimeBootstrapUrlAcknowledged'])
    if k['oneTimeBootstrapUrlAcknowledged'] is not True:
        fail('consensus.checkpoint.mode url needs oneTimeBootstrapUrlAcknowledged: true (the remote is trusted ONCE for '
             'the anchor; switch to resume after the first successful start)')
    from urllib.parse import urlsplit
    u = urlsplit(str(k['url']))
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment:
        fail('consensus.checkpoint.url must be https without credentials, query or fragment')
    out['url'] = k['url']
    return out


def validate(raw):
    """-> the canonical config. Refuses anything outside the reviewed shape."""
    only('config', raw, ['format', 'network', 'serviceUser', 'execution', 'consensus', 'p2p', 'engineAuthPath', 'avoidPorts',
                         'otherServicePaths', 'limits', 'storage', 'comment'],
         ['format', 'network', 'serviceUser', 'execution', 'consensus', 'p2p', 'engineAuthPath', 'avoidPorts',
          'otherServicePaths', 'limits', 'storage'])
    if raw['format'] != FORMAT:
        fail(f'format must be {FORMAT}')
    if raw['network'] != 'mainnet':
        fail('network must be mainnet: Base mainnet derives from Ethereum mainnet (rollup l1_chain_id 1)')
    c = {'format': FORMAT, 'network': 'mainnet'}
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', str(raw['serviceUser'])) or raw['serviceUser'] == 'root':
        fail('serviceUser must be a dedicated non-root account name')
    c['serviceUser'] = raw['serviceUser']

    e = raw['execution']
    only('execution', e, ['client', 'binary', 'httpPort', 'authPort', 'httpApi', 'receiptsRetentionBlocks', 'maxConnections', 'txBroadcast'],
         ['client', 'binary', 'httpPort', 'authPort', 'httpApi', 'receiptsRetentionBlocks'])
    if e['client'] != 'reth':
        fail('execution.client must be reth (the reviewed official v2.8.0)')
    if not isinstance(e['httpApi'], list) or 'eth' not in e['httpApi'] or any(a not in EL_APIS for a in e['httpApi']) \
            or len(set(e['httpApi'])) != len(e['httpApi']):
        fail(f'execution.httpApi must include eth and be a subset of {list(EL_APIS)} (no admin, debug, trace, txpool, miner)')
    c['execution'] = {'client': 'reth', 'binary': _binary('execution.binary', e['binary'], PINS['execution']),
                      'httpPort': integer('execution.httpPort', e['httpPort'], 1024, 65535),
                      'authPort': integer('execution.authPort', e['authPort'], 1024, 65535),
                      'httpApi': list(e['httpApi']),
                      'receiptsRetentionBlocks': integer('execution.receiptsRetentionBlocks', e['receiptsRetentionBlocks'], MIN_RECEIPTS, 10_000_000),
                      'maxConnections': integer('execution.maxConnections', e.get('maxConnections', 64), 1, 1024)}
    # L1 transaction broadcast is OFF unless explicitly opted in. Either way eth_sendRawTransaction exists on the loopback
    # `eth` API and admits an already-signed transaction into the LOCAL pool (reth cannot drop single methods);
    # 'disabled' keeps it there (no gossip, no local propagation), 'local-raw-propagate' lets reth's normal P2P gossip
    # carry it to peers. The pair holds no keys and never signs, funds or sends anything itself.
    tb = e.get('txBroadcast', 'disabled')
    if tb not in TX_BROADCAST:
        fail(f'execution.txBroadcast must be one of {list(TX_BROADCAST)} (default disabled: no L1 transaction leaves the node)')
    c['execution']['txBroadcast'] = tb

    k = raw['consensus']
    only('consensus', k, ['client', 'binary', 'httpPort', 'custody', 'blobPruneMarginEpochs', 'targetPeers', 'checkpoint'],
         ['client', 'binary', 'httpPort', 'custody', 'checkpoint'])
    if k['client'] != 'lighthouse':
        fail('consensus.client must be lighthouse (the reviewed official v8.3.2)')
    if k['custody'] not in ('semi-supernode', 'supernode'):
        fail('consensus.custody must be semi-supernode or supernode: after Fulu a default beacon node custodies only a few '
             'data columns and CANNOT serve /eth/v1/beacon/blobs, which Base derivation reads for every batch')
    c['consensus'] = {'client': 'lighthouse', 'binary': _binary('consensus.binary', k['binary'], PINS['consensus']),
                      'httpPort': integer('consensus.httpPort', k['httpPort'], 1024, 65535), 'custody': k['custody'],
                      'blobPruneMarginEpochs': integer('consensus.blobPruneMarginEpochs', k.get('blobPruneMarginEpochs', 0), 0, 4096),
                      'targetPeers': integer('consensus.targetPeers', k.get('targetPeers', 100), 16, 400)}

    p = raw['p2p']
    only('p2p', p, ['listenIp', 'nat', 'dnsDiscovery', 'executionPort', 'executionDiscv5Port', 'consensusPort', 'consensusQuicPort'],
         ['listenIp', 'nat', 'dnsDiscovery', 'executionPort', 'executionDiscv5Port', 'consensusPort', 'consensusQuicPort'])
    try:
        ip = ipaddress.ip_address(p['listenIp'])
    except (ValueError, TypeError):
        fail('p2p.listenIp must be an IP address')
    if ip.is_loopback or ip.version != 4:
        fail('p2p.listenIp must be an IPv4 address that can reach Ethereum peers (not loopback)')
    nat = str(p['nat'])
    m = re.fullmatch(r'extip:([0-9.]+)', nat)
    if nat != 'none' and not m:
        fail('p2p.nat must be none or extip:<IPv4>: reth\'s default `any` (and upnp/publicip) asks ipinfo.io, icanhazip.com '
             'and ifconfig.me for the public IP over HTTPS (reth crates/net/nat/src/lib.rs:38,244) - a hidden external service')
    if m:
        try:
            ext = ipaddress.ip_address(m.group(1))
        except ValueError:
            fail('p2p.nat extip must be a valid IPv4 address')
        if ext.is_loopback or ext.version != 4:
            fail('p2p.nat extip must be a non-loopback IPv4 address')
    if not isinstance(p['dnsDiscovery'], bool):
        fail('p2p.dnsDiscovery must be an explicit boolean (EIP-1459 DNS lists are a discovery aid served over DNS)')
    c['p2p'] = {'listenIp': str(ip), 'nat': nat, 'dnsDiscovery': p['dnsDiscovery']}
    for n in ('executionPort', 'executionDiscv5Port', 'consensusPort', 'consensusQuicPort'):
        c['p2p'][n] = integer(f'p2p.{n}', p[n], 1024, 65535)

    tcp = [c['execution']['httpPort'], c['execution']['authPort'], c['consensus']['httpPort'], c['p2p']['executionPort'],
           c['p2p']['consensusPort']]
    udp = [c['p2p']['executionPort'], c['p2p']['executionDiscv5Port'], c['p2p']['consensusPort'], c['p2p']['consensusQuicPort']]
    if len(set(tcp)) != len(tcp) or len(set(udp)) != len(udp):
        fail('every TCP port and every UDP port must be distinct')
    av = raw['avoidPorts']
    if not isinstance(av, list) or not av:
        fail('avoidPorts must list the ports of co-resident services (B verifier, Base holder RPC/P2P, ...)')
    c['avoidPorts'] = sorted({integer('avoidPorts[]', x, 1, 65535) for x in av})
    clash = sorted(set(tcp + udp) & set(c['avoidPorts']))
    if clash:
        fail(f'ports {clash} belong to co-resident services (avoidPorts)')

    c['engineAuthPath'] = abspath('engineAuthPath', raw['engineAuthPath'])
    if not c['engineAuthPath'].startswith('/etc/'):
        fail('engineAuthPath must live under /etc (root-provisioned at activation, group-readable by the service user only)')

    osp = raw['otherServicePaths']
    if not isinstance(osp, list) or not osp:
        fail('otherServicePaths must list the mounts/images of co-resident services (at least the Base holder)')
    c['otherServicePaths'] = [abspath('otherServicePaths[]', x) for x in osp]

    lim = raw['limits']
    only('limits', lim, ['execution', 'consensus', 'stopTimeoutSec', 'readyTimeoutSec', 'coResidentMemoryBytes'],
         ['execution', 'consensus', 'stopTimeoutSec', 'coResidentMemoryBytes'])
    c['limits'] = {'stopTimeoutSec': integer('limits.stopTimeoutSec', lim['stopTimeoutSec'], 30, 3600),
                   'readyTimeoutSec': integer('limits.readyTimeoutSec', lim.get('readyTimeoutSec', 600), 10, 86400),
                   'coResidentMemoryBytes': integer('limits.coResidentMemoryBytes', lim['coResidentMemoryBytes'], 0, 1 << 42)}
    for side, lo in (('execution', 8 << 30), ('consensus', 4 << 30)):
        s = lim[side]
        only(f'limits.{side}', s, ['memoryMaxBytes', 'memoryHighBytes', 'tasksMax', 'nofile'], ['memoryMaxBytes', 'tasksMax', 'nofile'])
        mx = integer(f'limits.{side}.memoryMaxBytes', s['memoryMaxBytes'], lo, 1 << 40)
        c['limits'][side] = {'memoryMaxBytes': mx,
                             'memoryHighBytes': integer(f'limits.{side}.memoryHighBytes', s.get('memoryHighBytes', mx * 9 // 10), 1 << 30, mx),
                             'tasksMax': integer(f'limits.{side}.tasksMax', s['tasksMax'], 256, 65536),
                             'nofile': integer(f'limits.{side}.nofile', s['nofile'], 4096, 1 << 20)}

    c['storage'] = validate_storage(raw['storage'], c)
    st = c['storage']
    c['execution']['datadir'] = st['mountPoint'] + '/data/el'
    c['consensus']['datadir'] = st['mountPoint'] + '/data/cl'
    c['consensus']['checkpoint'] = _checkpoint(k['checkpoint'], c['consensus']['datadir'])
    for i, other in enumerate(c['otherServicePaths']):
        for mine in tuple(x for x in (st['mountPoint'], st['origin'].get('imagePath'), c['engineAuthPath']) if x) + tuple(
                x for x in (st['cache'].get('dataImagePath'), st['cache'].get('metadataImagePath')) if x):
            if _overlap(mine, other):
                fail(f'{mine} overlaps co-resident service path {other} (otherServicePaths[{i}]): storage must not be shared')
    return c


def validate_storage(s, c):
    """Durable data: ONE new ext4 filesystem in ONE new image file on the HDD array, mounted at a dedicated mount point.
    The optional writethrough NVMe cache is S's dm-cache design. Its bytes come out of the SAME 250 GB aggregate: the
    pair only NAMES its fixed reservation in the one canonical shared ledger (S's budget.py, which enforces the cap, each
    host's share and the 200 GB target at allocation and verification). With cache none the pair reserves nothing."""
    only('storage', s, ['layout', 'mountPoint', 'origin', 'cache', 'nvmeBudget', 'originFreeMarginBytes', 'nvmeFreeMarginBytes'],
         ['layout', 'mountPoint', 'origin', 'cache'])
    mnt = abspath('storage.mountPoint', s.get('mountPoint'))
    if mnt.rstrip('/') in FORBIDDEN_MOUNT_ROOTS or mnt.count('/') < 2:
        fail('storage.mountPoint must be a dedicated directory such as /srv/enclave-l1-pair (never /, a system tree, '
             'the NVMe /vm tree or the array root)')
    for r in ('/tmp', '/var/tmp', '/dev', '/run', '/proc', '/sys', '/vm'):
        if _inside(mnt, r):
            fail(f'storage.mountPoint must not be inside {r} (RAM/system/NVMe trees never hold durable chain data)')
    o = s.get('origin') or {}
    network = s.get('layout') == H.NETWORK_LAYOUT
    if network:
        if not isinstance(o, dict) or o.get('role') != 'l1':
            fail("the L1 pair's network origin must be the l1 export (role l1), never the Base holder's")
    elif not isinstance(o, dict) or not str(o.get('imagePath', '')).startswith('/mnt/usb/'):
        fail('storage.origin.imagePath must be a NEW image file on the HDD array (/mnt/usb/...)')
    holder_view = {'datadir': mnt + '/data', 'staticFilesDir': None}
    out = H.validate_storage(dict(s), holder_view)       # S's reviewed rules: origin size, writethrough-only, ledger
    if not network and _inside(out['origin']['imagePath'], mnt):
        fail('the origin image must not live inside its own mount point')
    if out['cache']['mechanism'] != 'none' and out['nvmeBudget']['reservationId'] == 'base-holder-dm-cache':
        fail("storage.nvmeBudget.reservationId must be the pair's OWN ledger reservation, never the holder's")
    return out


# ---- rendering ------------------------------------------------------------------------------------------------------
def el_argv(c):
    """The exact `reth node` argument vector (no shell). Every flag is in the pinned binary's own help."""
    e, p = c['execution'], c['p2p']
    a = [e['binary']['path'], 'node', '--chain', 'mainnet', '--datadir', e['datadir'],
         '--full', '--prune.receipts.distance', str(e['receiptsRetentionBlocks']),
         '--http', '--http.addr', '127.0.0.1', '--http.port', str(e['httpPort']), '--http.api', ','.join(e['httpApi']),
         '--rpc.max-connections', str(e['maxConnections']),
         '--authrpc.addr', '127.0.0.1', '--authrpc.port', str(e['authPort']), '--authrpc.jwtsecret', c['engineAuthPath'],
         '--ipcdisable',
         '--addr', p['listenIp'], '--port', str(p['executionPort']),
         '--discovery.addr', p['listenIp'], '--discovery.port', str(p['executionPort']),
         '--discovery.v5.addr', p['listenIp'], '--discovery.v5.port', str(p['executionDiscv5Port']),
         '--nat', p['nat'],
         '--txpool.disable-transactions-backup',
         '--log.file.directory', e['datadir'] + '/logs', '--log.file.max-files', '5']
    if not p['dnsDiscovery']:
        a.append('--disable-dns-discovery')
    if e['txBroadcast'] == 'disabled':
        a += ['--disable-tx-gossip', '--txpool.no-local-transactions-propagation']
    return a


def cl_argv(c):
    """The exact `lighthouse beacon_node` argument vector (no shell). Flags from the pinned source help (help_bn.md);
    preflight re-checks them against the installed binary's own help."""
    k, p, e = c['consensus'], c['p2p'], c['execution']
    a = [k['binary']['path'], 'beacon_node', '--network', 'mainnet', '--datadir', k['datadir'],
         '--http', '--http-address', '127.0.0.1', '--http-port', str(k['httpPort']),
         '--execution-endpoint', f"http://127.0.0.1:{e['authPort']}", '--execution-jwt', c['engineAuthPath'],
         '--listen-address', p['listenIp'], '--port', str(p['consensusPort']), '--quic-port', str(p['consensusQuicPort']),
         '--disable-upnp', '--target-peers', str(k['targetPeers']),
         '--' + k['custody'], '--prune-blobs', 'true', '--blob-prune-margin-epochs', str(k['blobPruneMarginEpochs'])]
    m = re.fullmatch(r'extip:([0-9.]+)', p['nat'])
    if m:
        a += ['--enr-address', m.group(1), '--enr-tcp-port', str(p['consensusPort']), '--enr-udp-port', str(p['consensusPort'])]
    ck = k['checkpoint']
    if ck['mode'] == 'file':
        a += ['--checkpoint-state', ck['statePath'], '--checkpoint-block', ck['blockPath'], '--wss-checkpoint', ck['wss']]
    elif ck['mode'] == 'url':
        a += ['--checkpoint-sync-url', ck['url'], '--wss-checkpoint', ck['wss']]
    return a


def child_env(c, side):
    """The child's WHOLE environment: nothing is inherited (no RUST_LOG/RETH_*/LIGHTHOUSE_* or proxy variables)."""
    d = c['execution' if side == 'el' else 'consensus']['datadir']
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': d, 'TMPDIR': c['storage']['mountPoint'] + '/tmp'}


def unit_text(c, side, launcher_path, config_path):
    lim, mnt = c['limits'][('execution' if side == 'el' else 'consensus')], c['storage']['mountPoint']
    network = c['storage']['layout'] == H.NETWORK_LAYOUT
    gate = f'{NAME}-watch.service' if network else f'{NAME}-storage.service'
    if side == 'el':
        desc = f"Enclave L1 execution (official reth {c['execution']['binary']['release']}, non-validating, loopback RPC)"
        order = f'After=network-online.target {gate}'
    else:
        desc = f"Enclave L1 consensus (official lighthouse {c['consensus']['binary']['release']}, non-validating, loopback API)"
        order = f'After=network-online.target {gate} enclave-l1-el.service\nWants=enclave-l1-el.service'
    # network layout: bound to the network-HDD supervisor, whose exit (transport/storage failure) stops this unit;
    # the local layout's text is unchanged
    deps = f'{order}\nRequires={gate}' + (f'\nBindsTo={gate}' if network else '')
    rw = f'{mnt}/data {mnt}/tmp' if network else mnt
    return f"""# rendered by l1pair.py ({FORMAT}); review before install. Private: loopback APIs only; not a host-service role.
[Unit]
Description={desc}
Wants=network-online.target
{deps}
RequiresMountsFor={mnt}

[Service]
Type=notify
NotifyAccess=main
User={c['serviceUser']}
Group={c['serviceUser']}
ExecStart=/usr/bin/python3 -I {launcher_path} run-{side} {config_path}
KillMode=mixed
KillSignal=SIGTERM
TimeoutStartSec={c['limits']['readyTimeoutSec'] + 60}
TimeoutStopSec={c['limits']['stopTimeoutSec'] + 30}
Restart=on-failure
RestartSec=60
StartLimitIntervalSec=3600
StartLimitBurst=5
MemoryMax={lim['memoryMaxBytes']}
MemoryHigh={lim['memoryHighBytes']}
MemorySwapMax=0
TasksMax={lim['tasksMax']}
LimitNOFILE={lim['nofile']}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
ReadWritePaths={rw}
RuntimeDirectory=enclave-l1-{side}
RuntimeDirectoryMode=0750
UMask=0077

[Install]
WantedBy=multi-user.target
"""


def storage_unit_text(script_path):
    return f"""# rendered by l1pair.py ({FORMAT}); root-run storage assembly for the L1 pair (no reformatting at boot).
[Unit]
Description=Enclave L1 pair storage (HDD origin image, optional writethrough NVMe cache)
DefaultDependencies=no
After=local-fs.target
Before=enclave-l1-el.service enclave-l1-cl.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={script_path} assemble
ExecStop={script_path} disassemble

[Install]
WantedBy=multi-user.target
"""


def storage_script(c, budget_tool='/opt/enclave-l1-pair/vendor/holder/budget.py'):
    """S's holder-storage.sh.in, byte-identical (VENDOR.json pin), with THIS pair's constants (shell-quoted). The mapping
    name differs from the holder's, so the two never adopt each other's mappings; a cache is admitted, allocated and
    verified only through the shared budget ledger reservation it names."""
    s, o, k = c['storage'], c['storage']['origin'], c['storage']['cache']
    tpl = HERE / 'vendor' / 'holder' / 'holder-storage.sh.in'
    if H.sha256_file(tpl) != VENDOR['files']['holder/holder-storage.sh.in']:
        fail('vendored storage template differs from its pin')
    q = lambda v: "'" + str(v).replace("'", "'\\''") + "'"
    const = {'MECHANISM': k['mechanism'], 'ORIGIN': o['imagePath'], 'ORIGIN_BYTES': o['bytes'],
             'ORIGIN_FREE_MARGIN': s['originFreeMarginBytes'], 'MNT': s['mountPoint'], 'DATADIR': s['mountPoint'] + '/data',
             'OWNER': c['serviceUser'], 'NAME': NAME, 'PY': '/usr/bin/python3', 'BUDGET_TOOL': budget_tool,
             'LEDGER': (s.get('nvmeBudget') or {}).get('ledgerPath', ''), 'RESERVATION': (s.get('nvmeBudget') or {}).get('reservationId', ''),
             'CDATA': k.get('dataImagePath', ''), 'CDATA_BYTES': k.get('dataBytes', 0), 'CMETA': k.get('metadataImagePath', ''),
             'CMETA_BYTES': k.get('metadataBytes', 0), 'BLOCK_SECTORS': k.get('blockBytes', 0) // 512,
             'NVME_FREE_MARGIN': s['nvmeFreeMarginBytes']}
    return tpl.read_text().replace('@CONSTANTS@', '\n'.join(f'{n}={q(v)}' for n, v in const.items()))


def budget_reservation(c):
    """Only with a cache: the pair's OWN fixed entry for root to add to the shared ledger (S's budget v2 shape)."""
    k = c['storage']['cache']
    return {'id': c['storage']['nvmeBudget']['reservationId'], 'host': '<this host: /etc/machine-id>', 'owner': NAME,
            'kind': 'preallocated-files', 'blockBytes': H.CACHE_FS_BLOCK, 'maxBytes': k['dataBytes'] + k['metadataBytes'] + k['slackBytes'],
            'slackBytes': k['slackBytes'],
            'files': [{'path': k['dataImagePath'], 'bytes': k['dataBytes']}, {'path': k['metadataImagePath'], 'bytes': k['metadataBytes']}]}


def holder_fragment(c):
    return {'l1': {'executionRpc': f"http://127.0.0.1:{c['execution']['httpPort']}/",
                   'beacon': f"http://127.0.0.1:{c['consensus']['httpPort']}/", 'trustRpc': False},
            'note': "fragment for S's enclave-base-holder/v1 config (S owns that file). Apply only after `l1pair.py ready` "
                    'passes with --need-from-block/--need-blobs-from-slot covering the holder\'s safe-head L1 origin.'}


LABELS = {
    'role': 'non-validating Ethereum mainnet L1 data source for the Base holder; loopback APIs only; not a host-service role',
    'trust': 'self-verifying node pair after its anchor: the EL executes every block from genesis via P2P; the CL '
             'follows from the weak-subjectivity anchor. The anchor is a one-time trust input (file or explicit URL), '
             'cross-checked by >= 2 recorded observations',
    'blobs': 'semi-supernode/supernode serves /eth/v1/beacon/blobs only for blocks received since the node started, '
             'for at most the 4096-epoch DA window (lighthouse book advanced_blobs.md); start the pair BEFORE the Base '
             'snapshot so the holder\'s safe-head L1 origin is covered',
    'tx': 'execution.txBroadcast disabled (default): --disable-tx-gossip + --txpool.no-local-transactions-propagation; '
          'eth_sendRawTransaction still ADMITS a pre-signed tx into the local pool but nothing leaves the node. '
          'local-raw-propagate (explicit opt-in for E): standard reth gossip carries locally submitted pre-signed txs to '
          'peers; a returned hash or peer receipt is NOT inclusion. No keys, signing, funding or auto-send here',
    'flags': 'reth flags: executed against the official binary\'s help; lighthouse flags: pinned source help only '
             'until root records the extracted binary; preflight re-checks both',
}


def render(c, outdir, launcher_path='/opt/enclave-l1-pair/l1pair.py', config_path='/etc/enclave-l1-pair/l1pair.json',
           script_path='/opt/enclave-l1-pair/l1pair-storage.sh'):
    out = Path(outdir)
    out.mkdir(mode=0o700)
    files = {'l1pair.json': json.dumps(c, indent=2, sort_keys=True) + '\n',
             'el.argv.json': json.dumps(el_argv(c), indent=1) + '\n',
             'cl.argv.json': json.dumps(cl_argv(c), indent=1) + '\n',
             'el.env.json': json.dumps(child_env(c, 'el'), indent=1, sort_keys=True) + '\n',
             'cl.env.json': json.dumps(child_env(c, 'cl'), indent=1, sort_keys=True) + '\n',
             'enclave-l1-el.service': unit_text(c, 'el', launcher_path, config_path),
             'enclave-l1-cl.service': unit_text(c, 'cl', launcher_path, config_path),
             'holder-l1-fragment.json': json.dumps(holder_fragment(c), indent=1) + '\n'}
    if c['storage']['layout'] == H.NETWORK_LAYOUT:
        cached = c['storage']['cache']['mechanism'] == 'dm-cache'
        mnt = c['storage']['mountPoint']
        files.update({
            f'{NAME}-storage.service': H.network_storage_unit_text(NAME, 'l1', ['enclave-l1-el.service', 'enclave-l1-cl.service'],
                                                                     '/opt/enclave-l1-pair/vendor/holder/storage_nbd.py',
                                                                     '/etc/enclave-l1-pair/l1pair-storage-nbd.json'),
            f'{NAME}-watch.service': H.watch_unit_text(NAME, c['storage']['origin']['device'], cached, '/etc/enclave-l1-pair/l1pair-watch.json'),
            'l1pair-storage-nbd.json': json.dumps(H.network_storage_config(c, NAME, [mnt + '/data', mnt + '/tmp'],
                                                                           '/opt/enclave-l1-pair/vendor/holder/budget.py'), indent=1, sort_keys=True) + '\n',
            'l1pair-watch.json': json.dumps(H.watch_config(c, NAME), indent=1, sort_keys=True) + '\n'})
    else:
        files.update({f'{NAME}-storage.service': storage_unit_text(script_path), 'l1pair-storage.sh': storage_script(c)})
    if c['storage']['cache']['mechanism'] != 'none':
        files['nvme-budget-reservation.json'] = json.dumps(budget_reservation(c), indent=1) + '\n'
    for name, text in files.items():
        (out / name).write_text(text)
        os.chmod(out / name, 0o700 if name.endswith('.sh') else 0o600)
    manifest = {'format': FORMAT + '-render', 'files': {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items()},
                'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'pinsSha256': hashlib.sha256((HERE / 'PINS.json').read_bytes()).hexdigest(),
                'vendor': VENDOR, 'nvmeAccounting': c['storage']['nvmeAccounting'], 'labels': LABELS}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    return manifest


# ---- checkpoint inspection (field reads only; Lighthouse does all hashing/verification) ------------------------------
def checkpoint_inspect(state_path, block_path):
    """BeaconState SSZ begins with fixed fields genesis_time u64, genesis_validators_root B32, slot u64 (every fork).
    SignedBeaconBlock SSZ = offset(message) u32, signature B96, message{slot u64, proposer_index u64, ...}."""
    with open(state_path, 'rb') as f:
        s = f.read(48)
    with open(block_path, 'rb') as f:
        b = f.read(4 + 96 + 16)
    if len(s) < 48 or len(b) < 116:
        fail('checkpoint files are too short to be a BeaconState / SignedBeaconBlock')
    off = int.from_bytes(b[0:4], 'little')
    if off != 100:
        fail('checkpoint block is not a SignedBeaconBlock SSZ (message offset != 100)')
    st = {'genesisTime': int.from_bytes(s[0:8], 'little'), 'genesisValidatorsRoot': '0x' + s[8:40].hex(),
          'stateSlot': int.from_bytes(s[40:48], 'little'), 'blockSlot': int.from_bytes(b[100:108], 'little')}
    st['stateEpoch'], st['stateTime'] = st['stateSlot'] // MAIN['slotsPerEpoch'], st['genesisTime'] + st['stateSlot'] * MAIN['secondsPerSlot']
    return st


def check_checkpoint(c, now=None):
    ck = c['consensus']['checkpoint']
    if ck['mode'] != 'file':
        return f"checkpoint mode {ck['mode']}"
    for k in ('state', 'block'):
        p = ck[f'{k}Path']
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
            fail(f'checkpoint {k} file must be a regular file, not group/other writable')
        if H.sha256_file(p) != ck[f'{k}Sha256']:
            fail(f'checkpoint {k} file differs from its recorded sha256')
    h = checkpoint_inspect(ck['statePath'], ck['blockPath'])
    if h['genesisValidatorsRoot'] != MAIN['clGenesisValidatorsRoot'] or h['genesisTime'] != MAIN['clGenesisTime']:
        fail('checkpoint state is not Ethereum mainnet (genesis_validators_root / genesis_time differ)')
    if h['stateSlot'] % MAIN['slotsPerEpoch']:
        fail('checkpoint state is not at an epoch boundary (lighthouse book: always use an epoch-boundary slot)')
    if h['blockSlot'] > h['stateSlot']:
        fail('checkpoint block is newer than the state')
    if h['stateEpoch'] != ck['epoch']:
        fail(f"checkpoint state epoch {h['stateEpoch']} != wss epoch {ck['epoch']}")
    age = (now or time.time()) - h['stateTime']
    # Staleness: the weak-subjectivity period is validator-set dependent (Lighthouse backfills to it, "approximately 5
    # months"); data columns are requestable for 4096 epochs (~18 d). 14 days is a conservative OPERATIONAL bound, not a
    # spec value: an older anchor is re-cross-checked or replaced by a fresh export from the pair itself.
    if age > 14 * 86400:
        fail(f'checkpoint is {int(age // 86400)} days old (> 14): too stale to rule out a long-range fork; re-export a '
             'fresh one from the pair itself or re-cross-check a new anchor')
    if age < -60:
        fail('checkpoint is from the future')
    return f"checkpoint epoch {h['stateEpoch']} ({int(age // 3600)} h old), mainnet GVR, epoch-boundary, sha256 pinned"


# ---- host checks ------------------------------------------------------------------------------------------------------
def _help_has(text, flag):
    return re.search(r'(^|\s)' + re.escape(flag) + r'(\s|,|=|$)', text, re.M) is not None


def check_binaries(c, run_help=False, sides=('execution', 'consensus')):
    import subprocess
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}
    out = []
    for side, argvf, helpargs, verchk in (
            ('execution', el_argv, ['node', '--help'], lambda v: all(l in v for l in PINS['execution']['versionLines'])),
            ('consensus', cl_argv, ['beacon_node', '--help'], lambda v: v.startswith(PINS['consensus']['versionPrefix']))):
        if side not in sides:
            continue
        b = c[side]['binary']
        st = os.lstat(b['path'])
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
            fail(f'{side} binary must be a regular file, not group/other writable (no symlink)')
        if H.sha256_file(b['path']) != b['sha256']:
            fail(f'{side} binary hash differs from its pin')
        if run_help:
            ver = subprocess.run([b['path'], '--version'], env=env, capture_output=True, text=True, timeout=60).stdout.strip()
            if not verchk(ver):
                fail(f'{side} binary --version {ver[:120]!r} is not the reviewed release')
            text = subprocess.run([b['path']] + helpargs, env=env, capture_output=True, text=True, timeout=60).stdout
            missing = sorted({f for f in argvf(c) if f.startswith('--') and not _help_has(text, f)})
            if missing:
                fail(f'{side} flags not in the binary help: {missing}')
        out.append(f'{side} binary pin' + (', --version and help flags' if run_help else ''))
    return out


def check_jwt(c, owner_gid=None, require_root=True):
    p = c['engineAuthPath']
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o037:
        fail('JWT secret must be a regular file, mode 0640 or stricter (generated locally at activation, never shared)')
    if require_root and st.st_uid != 0:
        fail('JWT secret must be owned by root')
    if owner_gid is not None and st.st_gid != owner_gid:
        fail('JWT secret group must be the service user group')
    with open(p) as f:
        v = f.read().strip()
    if not re.fullmatch(r'(0x)?[0-9a-f]{64}', v):
        fail('JWT secret must be 32 bytes of hex (engine API, EIP spec)')
    return 'jwt secret file shape and mode'


def glibc_ok(minimum):
    have = os.confstr('CS_GNU_LIBC_VERSION') or ''
    m = re.search(r'([0-9]+)\.([0-9]+)', have)
    want = tuple(int(x) for x in minimum.split('.'))
    return bool(m) and (int(m.group(1)), int(m.group(2))) >= want, have


def preflight(c, owner_uid=None, owner_gid=None):
    """Read-only. -> list of checks (all must pass before the units start)."""
    out = check_binaries(c, run_help=True)
    ok, have = glibc_ok(PINS['consensus']['glibcMin'])
    if not ok:
        fail(f"glibc {have!r} < {PINS['consensus']['glibcMin']} (lighthouse v8.3.0+ pre-built binaries)")
    out.append(f'glibc {have}')
    mnt = c['storage']['mountPoint']
    if not os.path.ismount(mnt):
        fail(f'{mnt} is not a mount point (storage not assembled): durable data never lands on the parent filesystem')
    if os.stat(mnt).st_dev == os.stat('/').st_dev:
        fail(f'{mnt} is on the root filesystem')
    for other in c['otherServicePaths']:
        if os.path.exists(other) and os.path.ismount(other) and os.stat(other).st_dev == os.stat(mnt).st_dev:
            fail(f'{mnt} and {other} are the same filesystem: storage must not be shared')
    st = os.stat(mnt)
    if st.st_mode & 0o077 or (owner_uid is not None and st.st_uid != owner_uid):
        fail('mount point must be 0700 and owned by the service user')
    leaves = H.backing_disks(mnt)
    if not leaves:
        fail('cannot resolve the backing device')
    network = c['storage']['layout'] == H.NETWORK_LAYOUT
    if network:
        out.append(H.network_placement(c, leaves, '/etc/enclave-l1-pair/l1pair-watch.json'))
    elif c['storage']['cache']['mechanism'] == 'none' and not all(l['rotational'] for l in leaves):
        fail(f'durable L1 data must be HDD-backed (no silent NVMe chain state); backing: {leaves}')
    if c['storage']['cache']['mechanism'] == 'dm-cache':
        if not network and (not any(l['rotational'] for l in leaves) or not any(not l['rotational'] for l in leaves)):
            fail(f'a cached mount must resolve to an HDD origin plus an NVMe cache; backing: {leaves}')
        for p in (c['storage']['cache']['dataImagePath'], c['storage']['cache']['metadataImagePath']):
            if os.stat(p).st_blocks * 512 < os.stat(p).st_size:
                fail(f'{p} is sparse: the cap must be pre-allocated, not apparent')
    out.append(f'placement {leaves}')
    out.append(check_jwt(c, owner_gid))
    out.append(check_checkpoint(c))
    avail = int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable:'))) * 1024
    need = c['limits']['execution']['memoryMaxBytes'] + c['limits']['consensus']['memoryMaxBytes'] + c['limits']['coResidentMemoryBytes']
    if avail < need:
        fail(f'MemAvailable {avail} < pair MemoryMax + co-resident reservation {need} (use the CURRENT value; cached '
             'memory of running guests is not assumed reclaimable)')
    out.append(f'MemAvailable {avail} >= {need}')
    tcp = [c['execution']['httpPort'], c['execution']['authPort'], c['consensus']['httpPort'], c['p2p']['executionPort'], c['p2p']['consensusPort']]
    udp = [c['p2p']['executionPort'], c['p2p']['executionDiscv5Port'], c['p2p']['consensusPort'], c['p2p']['consensusQuicPort']]
    busy = [p for p in tcp if H.port_in_use(p, 'tcp')] + [p for p in udp if H.port_in_use(p, 'udp')]
    if busy:
        fail(f'ports in use: {busy}')
    out.append('ports free')
    return out


# ---- loopback probes ------------------------------------------------------------------------------------------------
def rpc(port, method, params=(), timeout=5):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        conn.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': list(params)}),
                     {'Content-Type': 'application/json'})
        r = conn.getresponse()
        body = json.loads(r.read(16 << 20))
        if 'error' in body:
            raise ValueError(f"{method}: {body['error']}")
        return body.get('result')
    finally:
        conn.close()


def beacon(port, path, timeout=5):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        conn.request('GET', path, headers={'Accept': 'application/json'})
        r = conn.getresponse()
        data = r.read(64 << 20)
        return r.status, (json.loads(data) if data[:1] in (b'{', b'[') else None)
    finally:
        conn.close()


def beacon_chain_probe(port, method, timeout=1):
    """Process readiness for run-cl through S's Supervisor (which compares the probe's answer with the expected chain
    id): the beacon API answers on loopback with mainnet's genesis and deposit chain."""
    st, g = beacon(port, '/eth/v1/beacon/genesis', timeout)
    st2, s = beacon(port, '/eth/v1/config/spec', timeout)
    if st == 200 and st2 == 200 and g['data']['genesis_validators_root'] == MAIN['clGenesisValidatorsRoot'] \
            and str(s['data'].get('DEPOSIT_CHAIN_ID')) == MAIN['depositChainId']:
        return MAIN['elChainIdHex']
    return None


def ready(c, need_from_block=None, need_blobs_from_slot=None, now=None, max_head_lag=120):
    """DATA readiness (not process liveness): the pair is a usable Base L1 source only if every check passes."""
    e, k = c['execution']['httpPort'], c['consensus']['httpPort']
    now = now or time.time()
    checks = []

    def chk(name, fn):
        try:
            v = fn()
            checks.append({'check': name, 'ok': v is True or (isinstance(v, str) and not v.startswith('FAIL')), 'detail': v})
        except Exception as ex:            # an unreachable/malformed source is a failed check, never a crash
            checks.append({'check': name, 'ok': False, 'detail': f'{type(ex).__name__}: {str(ex)[:200]}'})

    def need(cond, ok, bad):
        return ok if cond else 'FAIL ' + bad
    chk('el.chainId', lambda: need(rpc(e, 'eth_chainId') == MAIN['elChainIdHex'], 'mainnet', 'not chain 1'))
    chk('el.genesis', lambda: need((rpc(e, 'eth_getBlockByNumber', ['0x0', False]) or {}).get('hash') == MAIN['elGenesisHash'],
                                   'mainnet genesis', 'genesis hash differs'))
    chk('el.syncing', lambda: need(rpc(e, 'eth_syncing') is False, 'not syncing', 'eth_syncing is not false'))

    def head():
        b = rpc(e, 'eth_getBlockByNumber', ['latest', False]) or {}
        lag = now - int(b.get('timestamp', '0x0'), 16)
        return need(lag <= max_head_lag, f"head {int(b.get('number', '0x0'), 16)} lag {int(lag)} s", f'head lag {int(lag)} s > {max_head_lag}')
    chk('el.head', head)

    def fin():
        b = rpc(e, 'eth_getBlockByNumber', ['finalized', False])
        if not b:
            return 'FAIL no finalized block (the CL has not sent a finalized forkchoice)'
        lag = now - int(b['timestamp'], 16)
        return need(lag <= 3600, f"finalized {int(b['number'], 16)} lag {int(lag)} s", f'finalized lag {int(lag)} s')
    chk('el.finalized', fin)
    if need_from_block is not None:
        def receipts():
            n = hex(need_from_block)
            b = rpc(e, 'eth_getBlockByNumber', [n, False])
            r = rpc(e, 'eth_getBlockReceipts', [n])
            return need(b is not None and r is not None, f'block+receipts at {need_from_block}', f'receipts/block {need_from_block} unavailable (pruned or not synced)')
        chk('el.receiptsFrom', receipts)
    chk('cl.genesis', lambda: need(beacon(k, '/eth/v1/beacon/genesis')[1]['data']['genesis_validators_root'] == MAIN['clGenesisValidatorsRoot'],
                                   'mainnet GVR', 'genesis_validators_root differs'))

    def spec():
        d = beacon(k, '/eth/v1/config/spec')[1]['data']
        ok = str(d.get('DEPOSIT_CHAIN_ID')) == MAIN['depositChainId'] and str(d.get('SECONDS_PER_SLOT')) == str(MAIN['secondsPerSlot']) \
            and str(d.get('FULU_FORK_EPOCH')) == str(MAIN['fuluForkEpoch'])
        return need(ok, 'deposit chain 1, 12 s slots, Fulu 411392', 'spec does not match the pinned mainnet config')
    chk('cl.spec', spec)
    chk('cl.version', lambda: need(beacon(k, '/eth/v1/node/version')[1]['data']['version'].startswith('Lighthouse/' + PINS['consensus']['release']),
                                   PINS['consensus']['release'], 'not the pinned lighthouse release'))

    def syncing():
        d = beacon(k, '/eth/v1/node/syncing')[1]['data']
        ok = d.get('is_syncing') is False and d.get('is_optimistic') is False and d.get('el_offline') is False
        return need(ok, f"head slot {d.get('head_slot')}", f'syncing={d.get("is_syncing")} optimistic={d.get("is_optimistic")} el_offline={d.get("el_offline")}')
    chk('cl.syncing', syncing)

    def custody():
        d = beacon(k, '/eth/v1/node/identity')[1]['data']
        n = int(((d.get('metadata') or {}).get('custody_group_count')) or 0)
        return need(n >= MAIN['numberOfCustodyGroups'] // 2, f'custody groups {n}', f'custody groups {n} < 64: cannot reconstruct blobs')
    chk('cl.custody', custody)

    def pairing():
        st, blk = beacon(k, '/eth/v2/beacon/blocks/head')
        pl = blk['data']['message']['body']['execution_payload']
        mine = rpc(e, 'eth_getBlockByNumber', [hex(int(pl['block_number'])), False]) or {}
        return need(mine.get('hash') == pl['block_hash'], f"CL head payload {pl['block_number']} = EL block",
                    'CL head execution payload is not the EL block at that height (not paired / not synced)')
    chk('pair.head', pairing)

    def blobs():
        hs = int(beacon(k, '/eth/v1/beacon/headers/head')[1]['data']['header']['message']['slot'])
        slots = [need_blobs_from_slot] if need_blobs_from_slot is not None else range(hs - 1, hs - 65, -1)
        for s in slots:
            st, blk = beacon(k, f'/eth/v2/beacon/blocks/{s}')
            if st != 200:
                continue
            n = len(blk['data']['message']['body'].get('blob_kzg_commitments') or [])
            if not n:
                continue
            st, bl = beacon(k, f'/eth/v1/beacon/blobs/{s}')
            got = len((bl or {}).get('data') or [])
            return need(st == 200 and got == n, f'slot {s}: {got}/{n} blobs served', f'slot {s}: HTTP {st}, {got}/{n} blobs')
        return 'FAIL no blob-carrying slot found to test' if need_blobs_from_slot is None else f'FAIL slot {need_blobs_from_slot} missing'
    chk('cl.blobs', blobs)
    return {'ready': all(x['ok'] for x in checks), 'checks': checks}


# ---- supervision ------------------------------------------------------------------------------------------------------
def run(c, side):
    """ONE child under S's Supervisor (own process group, PDEATHSIG, SIGTERM then SIGKILL, sd_notify). Process
    readiness only: the EL answers eth_chainId 0x1; the CL's beacon API answers mainnet genesis + deposit chain."""
    check_binaries(c, sides=('execution' if side == 'el' else 'consensus',))   # each unit pins only its own binary
    if side == 'cl':
        check_checkpoint(c)
        H.rpc_call = beacon_chain_probe     # this process supervises the CL only: its readiness probe is the beacon API
    d = c['execution' if side == 'el' else 'consensus']['datadir']
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.makedirs(c['storage']['mountPoint'] + '/tmp', mode=0o700, exist_ok=True)
    lim = c['limits']['execution' if side == 'el' else 'consensus']
    port = c['execution']['httpPort'] if side == 'el' else c['consensus']['httpPort']
    status = os.path.join(os.environ.get('RUNTIME_DIRECTORY', f'/run/enclave-l1-{side}'), 'status.json')
    sup = H.Supervisor(el_argv(c) if side == 'el' else cl_argv(c), child_env(c, side), port, MAIN['elChainIdHex'],
                       c['limits']['stopTimeoutSec'], c['limits']['readyTimeoutSec'], lim['nofile'],
                       status_path=status if os.path.isdir(os.path.dirname(status)) else None,
                       log=lambda m: print(m, flush=True), cwd=d)
    return sup.run(install_signals=True)


def main(args):
    cmds = ('validate', 'render', 'preflight', 'run-el', 'run-cl', 'ready', 'checkpoint-inspect')
    if len(args) < 2 or args[0] not in cmds:
        print(__doc__, file=sys.stderr)
        return 64
    try:
        if args[0] == 'checkpoint-inspect':
            print(json.dumps(checkpoint_inspect(args[1], args[2]), indent=1))
            return 0
        c = validate(json.loads(Path(args[1]).read_text()))
        if args[0] == 'validate':
            print(json.dumps({'valid': True, 'config': c, 'elArgv': el_argv(c), 'clArgv': cl_argv(c),
                              'elEnv': child_env(c, 'el'), 'clEnv': child_env(c, 'cl'), 'labels': LABELS}, indent=1))
        elif args[0] == 'render':
            print(json.dumps(render(c, args[2]), indent=1))
        elif args[0] == 'preflight':
            print(json.dumps({'preflight': preflight(c)}, indent=1))
        elif args[0] == 'ready':
            opt = dict(zip(args[2::2], args[3::2]))
            r = ready(c, need_from_block=int(opt['--need-from-block']) if '--need-from-block' in opt else None,
                      need_blobs_from_slot=int(opt['--need-blobs-from-slot']) if '--need-blobs-from-slot' in opt else None)
            print(json.dumps(r, indent=1))
            return 0 if r['ready'] else 3
        else:
            return run(c, args[0][4:])
    except Refused as e:
        print(json.dumps({'refused': str(e)}))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
