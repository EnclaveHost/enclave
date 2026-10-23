#!/usr/bin/env python3
"""Enclave private Base state holder: a strict launcher for the STOCK `base rpc` node (base/base v1.5.1).

  holder.py validate CONFIG             check the config; print the canonical form, the argv and the env
  holder.py render CONFIG OUTDIR        write argv/env, systemd units, the root storage/cache recipe and a manifest
  holder.py preflight CONFIG            read-only host checks (binary pin, placement, free space, ports)
  holder.py run CONFIG                  supervise ONE `base rpc` child (the systemd unit's main process)
  holder.py status CONFIG               loopback JSON-RPC health (eth_chainId, eth_blockNumber)

What it is:
  * a private host bootstrap service. The execution JSON-RPC and the consensus RPC bind 127.0.0.1 only. It is not a
    host-service role, and nothing is advertised or granted.
  * an UNTRUSTED witness source for the local verifier runtime (rpc-runtime-composition, "B"). Its single integration
    point is B's existing `proofSources.untrusted` list: http://127.0.0.1:<rpc.port>/. Every proof it returns is
    verified there against the sequencer-signed head.
  * free of the lease/RPC startup cycle. Its start path needs a local disk, Base P2P and the DECLARED L1 endpoints;
    it needs no Enclave lease, no Sia and no Enclave RPC.

What it does not do:
  * it does not run a shell, read secrets, choose a sequencer, or fall back to a public RPC;
  * it does not change the client's protocol or cryptography;
  * it does not allocate storage or caches. The storage recipe it renders is for root, after review.

Argument names and defaults are taken from the pinned sources (FLAGS.json, with file:line and sha256 for each). They
were NOT executed against a Base binary: `preflight` compares them with the pinned binary's own `--help` before any
start.
"""
import ctypes
import hashlib
import http.client
import ipaddress
import json
import os
import re
import resource
import signal
import socket
import stat
import sys
import time
from pathlib import Path

FORMAT = 'enclave-base-holder/v1'
CHAIN_ID_HEX = '0x2105'                    # Base mainnet 8453
AGGREGATE_NVME_CAP = 250_000_000_000      # direct human limit, ALL cache allocations of this work together
NVME_TARGET = 200_000_000_000             # operational target
MAX_PROOF_WINDOW = 28 * 24 * 60 * 60 // 2  # base/reth rpc-server-types constants.rs:69
HTTP_APIS = ('eth', 'net', 'web3')        # proofs/blocks/code/storage; never admin, debug, txpool, miner
SECRETISH = re.compile(r'(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|jwt|credential|keyfile)', re.I)
HERE = Path(__file__).resolve().parent
FLAGS = json.loads((HERE / 'FLAGS.json').read_text())
BINARY = json.loads((HERE / 'BINARY.json').read_text())   # the reviewed official binary and its offline help
sys.path.insert(0, str(HERE))
import budget as BUDGET   # noqa: E402  the shared NVMe cache budget ledger (budget.py, same directory)
CACHE_FS_BLOCK = 4096     # block size of the ext4 holding the cache images; budget.py refuses any other before writing
sys.path.pop(0)


class Refused(Exception):
    pass


def fail(msg):
    raise Refused(msg)


def only(where, obj, allowed, required=()):
    if not isinstance(obj, dict):
        fail(f'{where} must be an object')
    for k in obj:
        if k not in allowed:
            fail(f'{where}: unknown field {k!r}')
        if SECRETISH.search(k):
            fail(f'{where}: field {k!r} names a credential; this config holds none')
    for k in required:
        if k not in obj:
            fail(f'{where}: {k!r} is required')


def integer(where, v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        fail(f'{where} must be an integer in [{lo}, {hi}]')
    return v


def abspath(where, v):
    if not isinstance(v, str) or not v.startswith('/') or '\0' in v or '/../' in v + '/' or v != os.path.normpath(v):
        fail(f'{where} must be a normalized absolute path')
    return v


PLACEHOLDER_TLD = ('.invalid',)


def l1_url(where, v, review=False):
    from urllib.parse import urlsplit
    if not isinstance(v, str):
        fail(f'{where} must be a URL string')
    u = urlsplit(v)
    if u.username or u.password or u.query or u.fragment:
        fail(f'{where} must not carry credentials, a query or a fragment')
    host = (u.hostname or '').lower()
    if host.endswith(PLACEHOLDER_TLD) and not review:
        fail(f'{where} is a placeholder ({host}): name the real L1 endpoint (review renders only with --review)')
    loop = host in ('localhost', '127.0.0.1', '::1') or host.startswith('127.')
    if u.scheme == 'https' and host:
        return v, loop
    if u.scheme == 'http' and loop:
        return v, True
    fail(f'{where}: https for remote hosts, plain http only on loopback')


def validate(raw, review=False):
    """-> the canonical config. Refuses anything outside the reviewed shape."""
    only('config', raw, ['format', 'binary', 'serviceUser', 'datadir', 'staticFilesDir', 'rpc', 'consensusRpc', 'p2p',
                         'l1', 'upgradeSignalMode', 'txForwarding', 'prune', 'limits', 'storage', 'verifierPort'],
         ['format', 'binary', 'serviceUser', 'datadir', 'rpc', 'consensusRpc', 'p2p', 'l1', 'txForwarding', 'limits',
          'storage', 'verifierPort'])
    if raw['format'] != FORMAT:
        fail(f'format must be {FORMAT}')
    c = {'format': FORMAT}
    b = raw['binary']
    only('binary', b, ['path', 'sha256', 'release', 'releaseTarballSha256'], ['path', 'sha256', 'release', 'releaseTarballSha256'])
    for k in ('sha256', 'releaseTarballSha256'):
        if not re.fullmatch(r'[0-9a-f]{64}', str(b[k])):
            fail(f'binary.{k} must be 64 lowercase hex (record it at install; a placeholder is not a pin)')
    if b['release'] != FLAGS['release']['tag']:
        fail(f"binary.release must be {FLAGS['release']['tag']}: the flags were reviewed against that source only")
    if b['releaseTarballSha256'] != FLAGS['release']['tarballSha256']:
        fail('binary.releaseTarballSha256 differs from the reviewed release asset digest')
    if b['sha256'] != BINARY['binary']['sha256']:
        fail(f"binary.sha256 must be the reviewed official binary {BINARY['binary']['sha256']} (BINARY.json)")
    c['binary'] = {'path': abspath('binary.path', b['path']), 'sha256': b['sha256'], 'release': b['release'],
                   'releaseTarballSha256': b['releaseTarballSha256']}
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', str(raw['serviceUser'])) or raw['serviceUser'] == 'root':
        fail('serviceUser must be a dedicated non-root account name')
    c['serviceUser'] = raw['serviceUser']
    c['datadir'] = abspath('datadir', raw['datadir'])
    c['staticFilesDir'] = abspath('staticFilesDir', raw['staticFilesDir']) if raw.get('staticFilesDir') else None
    c['verifierPort'] = integer('verifierPort', raw['verifierPort'], 1, 65535)

    r = raw['rpc']
    only('rpc', r, ['port', 'api', 'proofWindowBlocks', 'maxConnections'], ['port', 'api', 'proofWindowBlocks'])
    if not isinstance(r['api'], list) or not r['api'] or any(a not in HTTP_APIS for a in r['api']) or len(set(r['api'])) != len(r['api']):
        fail(f'rpc.api must be a non-empty subset of {list(HTTP_APIS)} (no admin, debug, txpool or miner)')
    c['rpc'] = {'port': integer('rpc.port', r['port'], 1024, 65535), 'api': list(r['api']),
                'proofWindowBlocks': integer('rpc.proofWindowBlocks', r['proofWindowBlocks'], 0, MAX_PROOF_WINDOW),
                'maxConnections': integer('rpc.maxConnections', r.get('maxConnections', 32), 1, 1024)}
    cr = raw['consensusRpc']
    only('consensusRpc', cr, ['port'], ['port'])
    c['consensusRpc'] = {'port': integer('consensusRpc.port', cr['port'], 1024, 65535)}

    p = raw['p2p']
    only('p2p', p, ['listenIp', 'executionPort', 'discoveryV5Port', 'consensusTcpPort', 'consensusUdpPort'],
         ['listenIp', 'executionPort', 'discoveryV5Port', 'consensusTcpPort', 'consensusUdpPort'])
    try:
        ip = ipaddress.ip_address(p['listenIp'])
    except (ValueError, TypeError):
        fail('p2p.listenIp must be an IP address')
    if ip.is_loopback:
        fail('p2p.listenIp on loopback cannot reach Base peers (discovery would bind loopback)')
    c['p2p'] = {'listenIp': str(ip)}
    for k in ('executionPort', 'discoveryV5Port', 'consensusTcpPort', 'consensusUdpPort'):
        c['p2p'][k] = integer(f'p2p.{k}', p[k], 1024, 65535)
    tcp = [c['rpc']['port'], c['consensusRpc']['port'], c['p2p']['executionPort'], c['p2p']['consensusTcpPort']]
    udp = [c['p2p']['executionPort'], c['p2p']['discoveryV5Port'], c['p2p']['consensusUdpPort']]
    if len(set(tcp)) != len(tcp) or len(set(udp)) != len(udp):
        fail('every TCP port and every UDP port must be distinct')
    if c['verifierPort'] in tcp:
        fail(f"port {c['verifierPort']} is the local verifier's (B: verifier.port); the holder must not take it")

    l1 = raw['l1']
    only('l1', l1, ['executionRpc', 'beacon', 'trustRpc', 'rpcTimeoutMs'], ['executionRpc', 'beacon', 'trustRpc'])
    if l1['trustRpc'] is not False:
        fail('l1.trustRpc must be false (block-hash verification of every retrieved L1 block)')
    ex, ex_loop = l1_url('l1.executionRpc', l1['executionRpc'], review)
    be, be_loop = l1_url('l1.beacon', l1['beacon'], review)
    c['l1'] = {'executionRpc': ex, 'beacon': be, 'trustRpc': False, 'selfHosted': ex_loop and be_loop,
               'rpcTimeoutMs': integer('l1.rpcTimeoutMs', l1.get('rpcTimeoutMs', 10000), 1000, 120000)}

    mode = raw.get('upgradeSignalMode', 'metrics-only')
    if mode not in ('metrics-only', 'startup-apply'):
        fail('upgradeSignalMode: metrics-only (no L1 read gates startup) or startup-apply (startup waits for L1); '
             'runtime-admin is not reviewed')
    c['upgradeSignalMode'] = mode

    t = raw['txForwarding']
    only('txForwarding', t, ['endpoint'], ['endpoint'])
    if t['endpoint'] is not None:
        from urllib.parse import urlsplit
        u = urlsplit(str(t['endpoint']))
        if u.scheme != 'https' or u.username or u.password or u.query:
            fail('txForwarding.endpoint must be null or an https URL without credentials (an explicit, hosted route)')
    c['txForwarding'] = {'endpoint': t['endpoint']}

    # the snapshot profile the datadir was restored with (`base snapshot download --minimal|--full`). It is NOT passed
    # at start: download writes reth.toml with that profile's prune modes AND the snapshot's static-file segment size
    # (500,000 blocks); a CLI --minimal would override the segment size with 10,000 (base/reth launch/common.rs:183,
    # args/static_files.rs:46-52; the binary's own --minimal help says so). preflight requires the generated reth.toml.
    pr = raw.get('prune', 'minimal')
    if pr not in ('minimal', 'full'):
        fail('prune must be minimal or full')
    c['prune'] = pr
    c['review'] = bool(review)

    lim = raw['limits']
    only('limits', lim, ['memoryMaxBytes', 'memoryHighBytes', 'tasksMax', 'nofile', 'stopTimeoutSec', 'readyTimeoutSec'],
         ['memoryMaxBytes', 'tasksMax', 'nofile', 'stopTimeoutSec'])
    c['limits'] = {'memoryMaxBytes': integer('limits.memoryMaxBytes', lim['memoryMaxBytes'], 8 << 30, 1 << 40),
                   'tasksMax': integer('limits.tasksMax', lim['tasksMax'], 256, 65536),
                   'nofile': integer('limits.nofile', lim['nofile'], 4096, 1 << 20),
                   'stopTimeoutSec': integer('limits.stopTimeoutSec', lim['stopTimeoutSec'], 30, 3600),
                   'readyTimeoutSec': integer('limits.readyTimeoutSec', lim.get('readyTimeoutSec', 3600), 10, 86400)}
    c['limits']['memoryHighBytes'] = integer('limits.memoryHighBytes', lim.get('memoryHighBytes', c['limits']['memoryMaxBytes'] * 9 // 10),
                                             1 << 30, c['limits']['memoryMaxBytes'])
    c['storage'] = validate_storage(raw['storage'], c)
    return c


def validate_storage(s, c):
    """Durable state lives in an HDD-backed origin image. The NVMe cache is optional, writethrough and bounded."""
    only('storage', s, ['layout', 'mountPoint', 'origin', 'cache', 'nvmeBudget', 'originFreeMarginBytes', 'nvmeFreeMarginBytes'],
         ['layout', 'mountPoint', 'origin', 'cache'])
    if s['layout'] != 'loop-ext4-image':
        fail('storage.layout must be loop-ext4-image (a NEW image file; existing filesystems are never reformatted)')
    out = {'layout': s['layout'], 'mountPoint': abspath('storage.mountPoint', s['mountPoint']),
           'originFreeMarginBytes': integer('storage.originFreeMarginBytes', s.get('originFreeMarginBytes', 500_000_000_000), 0, 10 ** 14),
           'nvmeFreeMarginBytes': integer('storage.nvmeFreeMarginBytes', s.get('nvmeFreeMarginBytes', 200_000_000_000), 0, 10 ** 14)}
    if not (c['datadir'] + '/').startswith(out['mountPoint'].rstrip('/') + '/') or c['datadir'] == out['mountPoint']:
        fail('datadir must be a directory inside storage.mountPoint')
    if c['staticFilesDir'] and not (c['staticFilesDir'] + '/').startswith(out['mountPoint'].rstrip('/') + '/'):
        fail('staticFilesDir must be inside storage.mountPoint (durable data stays on the HDD-backed origin)')
    o = s['origin']
    only('storage.origin', o, ['imagePath', 'bytes'], ['imagePath', 'bytes'])
    out['origin'] = {'imagePath': abspath('storage.origin.imagePath', o['imagePath']),
                     'bytes': integer('storage.origin.bytes', o['bytes'], 1_500_000_000_000, 30_000_000_000_000)}
    k = s['cache']
    only('storage.cache', k, ['mechanism', 'mode', 'dataImagePath', 'dataBytes', 'metadataImagePath', 'metadataBytes', 'blockBytes', 'slackBytes'],
         ['mechanism'])
    # The aggregate cap is enforced by the SHARED budget ledger (budget.py), not by this config: the holder only names
    # its reservation there. Other caches are never estimated here (an estimate is not a bound).
    nb = s.get('nvmeBudget')
    if k['mechanism'] == 'none':
        if nb is not None:
            fail('storage.nvmeBudget applies only to a cache (mechanism none allocates no NVMe bytes)')
        out['cache'] = {'mechanism': 'none'}
        out['nvmeAccounting'] = {'holderBytes': 0, 'capBytes': AGGREGATE_NVME_CAP, 'targetBytes': NVME_TARGET}
        return out
    only('storage.nvmeBudget', nb, ['ledgerPath', 'reservationId'], ['ledgerPath', 'reservationId'])
    if nb['ledgerPath'] != BUDGET.CANONICAL_PATH:
        fail(f'storage.nvmeBudget.ledgerPath must be the canonical shared ledger {BUDGET.CANONICAL_PATH}')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', str(nb['reservationId'])):
        fail('storage.nvmeBudget.reservationId must be a ledger reservation id')
    out['nvmeBudget'] = {'ledgerPath': nb['ledgerPath'], 'reservationId': nb['reservationId']}
    if k['mechanism'] != 'dm-cache':
        fail('storage.cache.mechanism must be none or dm-cache (block-level, under the new image only)')
    only('storage.cache', k, ['mechanism', 'mode', 'dataImagePath', 'dataBytes', 'metadataImagePath', 'metadataBytes', 'blockBytes', 'slackBytes'],
         ['mechanism', 'mode', 'dataImagePath', 'dataBytes', 'metadataImagePath', 'metadataBytes', 'blockBytes'])
    if k['mode'] != 'writethrough':
        fail('storage.cache.mode must be writethrough: the HDD origin holds every write before it completes; '
             'writeback (dirty data only on NVMe) is refused')
    blk = integer('storage.cache.blockBytes', k['blockBytes'], 32 * 1024, 1 << 30)
    if blk % (32 * 1024):
        fail('storage.cache.blockBytes must be a multiple of 32 KiB (dm-cache block granularity)')
    data = integer('storage.cache.dataBytes', k['dataBytes'], 1 << 30, AGGREGATE_NVME_CAP)
    if data % blk:
        fail('storage.cache.dataBytes must be a whole number of cache blocks')
    meta = integer('storage.cache.metadataBytes', k['metadataBytes'], 16 << 20, 16 << 30)
    need_meta = (4 << 20) + 16 * (data // blk) * 4   # 4x the dm-cache rule of thumb (4 MiB + 16 B per block)
    if meta < need_meta:
        fail(f'storage.cache.metadataBytes must be at least {need_meta} for {data // blk} cache blocks')
    if meta % CACHE_FS_BLOCK:
        fail(f'storage.cache.metadataBytes must be a multiple of the {CACHE_FS_BLOCK}-byte filesystem block of the cache images')
    slack = integer('storage.cache.slackBytes', k.get('slackBytes', 64 << 20), 16 << 20, 4 << 30)
    paths = [abspath('storage.cache.dataImagePath', k['dataImagePath']), abspath('storage.cache.metadataImagePath', k['metadataImagePath'])]
    if paths[0] == paths[1] or any(p.startswith(out['mountPoint'].rstrip('/') + '/') or p == out['origin']['imagePath'] for p in paths):
        fail('cache images must be two distinct files outside the mount point and apart from the origin image')
    holder = data + meta + slack
    need = BUDGET.required_headroom({'blockBytes': CACHE_FS_BLOCK, 'files': [{'path': p, 'bytes': n} for p, n in zip(paths, (data, meta))]})
    if slack < need:
        fail(f'storage.cache.slackBytes must be at least {need} (the budget ledger\'s required allocation headroom)')
    if holder > NVME_TARGET:
        fail(f'this cache reserves {holder} bytes, above the {NVME_TARGET}-byte operational target by itself')
    out['cache'] = {'mechanism': 'dm-cache', 'mode': 'writethrough', 'policy': 'smq', 'dataImagePath': paths[0], 'dataBytes': data,
                    'metadataImagePath': paths[1], 'metadataBytes': meta, 'blockBytes': blk, 'slackBytes': slack}
    out['nvmeAccounting'] = {'holderBytes': holder, 'capBytes': AGGREGATE_NVME_CAP, 'targetBytes': NVME_TARGET,
                             'enforcedBy': f"shared ledger {nb['ledgerPath']} reservation {nb['reservationId']} (maxBytes must equal holderBytes)"}
    return out


# ---- rendering ------------------------------------------------------------------------------------------------------
def argv(c):
    """The exact `base rpc` argument vector (no shell). Every flag is in FLAGS.json."""
    a = [c['binary']['path'], '--chain', 'mainnet', 'rpc',
         '--datadir', c['datadir'],
         '--http', '--http.addr', '127.0.0.1', '--http.port', str(c['rpc']['port']), '--http.api', ','.join(c['rpc']['api']),
         '--rpc.max-connections', str(c['rpc']['maxConnections']),
         '--rpc.eth-proof-window', str(c['rpc']['proofWindowBlocks']),
         '--ipcdisable',
         '--addr', c['p2p']['listenIp'], '--port', str(c['p2p']['executionPort']),
         '--discovery.addr', c['p2p']['listenIp'], '--discovery.port', str(c['p2p']['executionPort']),
         '--discovery.v5.addr', c['p2p']['listenIp'], '--discovery.v5.port', str(c['p2p']['discoveryV5Port']),
         '--rpc.addr', '127.0.0.1', '--rpc.port', str(c['consensusRpc']['port']),
         '--p2p.listen.ip', c['p2p']['listenIp'], '--p2p.listen.tcp', str(c['p2p']['consensusTcpPort']),
         '--p2p.listen.udp', str(c['p2p']['consensusUdpPort']),
         '--l1-eth-rpc', c['l1']['executionRpc'], '--l1-beacon', c['l1']['beacon'],
         '--l1.rpc-timeout-ms', str(c['l1']['rpcTimeoutMs']),
         '--upgrade-signal.mode', c['upgradeSignalMode']]
    if c['staticFilesDir']:
        a += ['--datadir.static-files', c['staticFilesDir']]
    if c['txForwarding']['endpoint']:
        a += ['--rpc.forwarding-endpoint', c['txForwarding']['endpoint']]
    return a


def child_env(c):
    """The child's WHOLE environment. Nothing is inherited: base reads BASE_NODE_*, RETH_* and OP_RETH_SEQUENCER_HTTP
    (an implicit sequencer route) from the environment, and those are deliberately absent. The single variable set is
    the L1 trust switch: its CLI flag can only turn trust ON (bool SetTrue, default true)."""
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': c['datadir'], 'TMPDIR': c['storage']['mountPoint'] + '/tmp',
            'BASE_NODE_L1_TRUST_RPC': 'false'}


def unit_text(c, holder_path, config_path):
    lim = c['limits']
    data_mount = c['storage']['mountPoint']
    return f"""# rendered by holder.py ({FORMAT}); review before install. Private: loopback RPC only, not a host-service role.
[Unit]
Description=Enclave private Base state holder (stock base rpc {c['binary']['release']}; untrusted witness source)
Wants=network-online.target
After=network-online.target enclave-base-holder-storage.service
Requires=enclave-base-holder-storage.service
RequiresMountsFor={data_mount}

[Service]
Type=notify
NotifyAccess=main
User={c['serviceUser']}
Group={c['serviceUser']}
ExecStart=/usr/bin/python3 -I {holder_path} run {config_path}
KillMode=mixed
KillSignal=SIGTERM
TimeoutStartSec={lim['readyTimeoutSec'] + 60}
TimeoutStopSec={lim['stopTimeoutSec'] + 30}
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
ReadWritePaths={data_mount}
RuntimeDirectory=enclave-base-holder
RuntimeDirectoryMode=0750
UMask=0077

[Install]
WantedBy=multi-user.target
"""


def storage_unit_text(script_path):
    return f"""# rendered by holder.py ({FORMAT}); root-run storage assembly for the holder (no reformatting at boot).
[Unit]
Description=Enclave Base holder storage (HDD origin image, optional writethrough NVMe cache)
DefaultDependencies=no
After=local-fs.target
Before=enclave-base-holder.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={script_path} assemble
ExecStop={script_path} disassemble

[Install]
WantedBy=multi-user.target
"""


def storage_script(c, budget_tool='/opt/enclave-base-holder/budget.py'):
    """The root-only storage script: holder-storage.sh.in with this config's constants (shell-quoted)."""
    s, o, k = c['storage'], c['storage']['origin'], c['storage']['cache']
    q = lambda v: "'" + str(v).replace("'", "'\\''") + "'"
    const = {'MECHANISM': k['mechanism'], 'ORIGIN': o['imagePath'], 'ORIGIN_BYTES': o['bytes'],
             'ORIGIN_FREE_MARGIN': s['originFreeMarginBytes'], 'MNT': s['mountPoint'], 'DATADIR': c['datadir'], 'OWNER': c['serviceUser'],
             'NAME': 'enclave-base-holder', 'PY': '/usr/bin/python3', 'BUDGET_TOOL': budget_tool,
             'LEDGER': (s.get('nvmeBudget') or {}).get('ledgerPath', ''), 'RESERVATION': (s.get('nvmeBudget') or {}).get('reservationId', ''),
             'CDATA': k.get('dataImagePath', ''), 'CDATA_BYTES': k.get('dataBytes', 0), 'CMETA': k.get('metadataImagePath', ''),
             'CMETA_BYTES': k.get('metadataBytes', 0), 'BLOCK_SECTORS': k.get('blockBytes', 0) // 512,
             'NVME_FREE_MARGIN': s['nvmeFreeMarginBytes']}
    text = (HERE / 'holder-storage.sh.in').read_text()
    return text.replace('@CONSTANTS@', '\n'.join(f'{n}={q(v)}' for n, v in const.items()))


def budget_reservation(c):
    """This holder's entry for the shared ledger: the two fixed-size cache files plus slack."""
    k = c['storage']['cache']
    return {'id': c['storage']['nvmeBudget']['reservationId'], 'host': '<this host: /etc/machine-id>', 'owner': 'enclave-base-holder',
            'kind': 'preallocated-files', 'blockBytes': CACHE_FS_BLOCK, 'maxBytes': k['dataBytes'] + k['metadataBytes'] + k['slackBytes'],
            'slackBytes': k['slackBytes'],
            'files': [{'path': k['dataImagePath'], 'bytes': k['dataBytes']}, {'path': k['metadataImagePath'], 'bytes': k['metadataBytes']}]}


def budget_example(c):
    """An EXAMPLE ledger (not valid until root fills real machine ids and shares): one host share, this reservation."""
    rows = [budget_reservation(c)] if c['storage']['cache']['mechanism'] == 'dm-cache' else []
    return {'format': BUDGET.FORMAT, 'capBytes': BUDGET.CAP, 'targetBytes': BUDGET.TARGET,
            'hosts': [{'machineId': '<32-hex /etc/machine-id of the cache host>', 'label': 'workstation', 'shareBytes': BUDGET.TARGET}],
            'reservations': rows}


def render(c, outdir, holder_path='/opt/enclave-base-holder/holder.py', config_path='/etc/enclave-base-holder/holder.json',
           script_path='/opt/enclave-base-holder/holder-storage.sh'):
    out = Path(outdir)
    out.mkdir(mode=0o700)
    files = {'holder.json': json.dumps(c, indent=2, sort_keys=True) + '\n',
             'holder.argv.json': json.dumps(argv(c), indent=1) + '\n',
             'holder.env.json': json.dumps(child_env(c), indent=1, sort_keys=True) + '\n',
             'enclave-base-holder.service': unit_text(c, holder_path, config_path),
             'enclave-base-holder-storage.service': storage_unit_text(script_path),
             'holder-storage.sh': storage_script(c),
             'nvme-cache-budget.example.json': json.dumps(budget_example(c), indent=1) + '\n',
             'b-proof-source.json': json.dumps({'proofSources': {'untrusted': [f"http://127.0.0.1:{c['rpc']['port']}/"]},
                                                'note': "fragment for B's enclave-rpc-runtime/v1 config; B verifies every witness"}, indent=1) + '\n'}
    for name, text in files.items():
        (out / name).write_text(text)
        os.chmod(out / name, 0o700 if name.endswith('.sh') else 0o600)
    manifest = {'format': FORMAT + '-render', 'files': {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items()},
                'flagsSha256': hashlib.sha256((HERE / 'FLAGS.json').read_bytes()).hexdigest(),
                'holderSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'nvmeAccounting': c['storage']['nvmeAccounting'], 'labels': LABELS,
                'binary': BINARY['binary'], 'reviewOnly': bool(c.get('review'))}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    return manifest


LABELS = {
    'role': 'private untrusted witness source (B proofSources.untrusted); not a host-service role; no public serving',
    'freshness': 'proofs are only as fresh as this node; B refuses anything not at a verified fresh head',
    'l1': 'startup needs the declared L1 execution endpoint (unsafe-block signer read with 5 bounded retries); derivation '
          '(safe/finalized) needs L1 + beacon continuously; L1 watcher retry exhaustion stops the node (source, unexecuted)',
    'tx': 'transaction submission incomplete: no forwarding unless txForwarding.endpoint is set (hosted sequencer); P2P '
          'tx gossip is disabled by base-reth; L1 deposits are not a transparent replacement',
    'flags': 'every rendered flag is in the pinned official binary help (BINARY.json, executed offline); preflight re-checks the installed bytes',
}


# ---- host checks ------------------------------------------------------------------------------------------------------
def backing_disks(path):
    """sysfs walk: the leaf block devices (through dm and loop) holding `path`. Read-only."""
    st = os.stat(path)
    seen, leaves, todo = set(), [], [f'{os.major(st.st_dev)}:{os.minor(st.st_dev)}']
    while todo:
        mm = todo.pop()
        if mm in seen:
            continue
        seen.add(mm)
        sysdev = Path('/sys/dev/block') / mm
        if not sysdev.exists():
            continue
        real = sysdev.resolve()
        bf = real / 'loop' / 'backing_file'
        slaves = list((real / 'slaves').iterdir()) if (real / 'slaves').is_dir() else []
        if bf.exists():
            st2 = os.stat(bf.read_text().strip())
            todo.append(f'{os.major(st2.st_dev)}:{os.minor(st2.st_dev)}')
        elif slaves:
            todo += [(s / 'dev').read_text().strip() for s in slaves]
        else:
            disk = real if (real / 'queue').exists() else real.parent
            leaves.append({'device': disk.name, 'rotational': (disk / 'queue' / 'rotational').read_text().strip() == '1'})
    return leaves


def port_in_use(port, kind):
    for f in (f'/proc/net/{kind}', f'/proc/net/{kind}6'):
        try:
            with open(f) as fh:
                rows = fh.read().splitlines()[1:]
        except OSError:
            continue
        for r in rows:
            p = r.split()
            if int(p[1].rsplit(':', 1)[1], 16) == port and (kind == 'udp' or p[3] == '0A'):
                return True
    return False


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def check_binary(c, run_help=False):
    """The binary is a regular file, not group/other writable, matching its pin. With run_help: its own --version is
    the reviewed one and every rendered flag appears in its own help (closed env, no network needed)."""
    import subprocess
    p = c['binary']['path']
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        fail('binary must be a regular file, not group/other writable (no symlink)')
    if sha256_file(p) != c['binary']['sha256']:
        fail('binary hash differs from its pin')
    if run_help:
        env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}
        ver = subprocess.run([p, '--version'], env=env, capture_output=True, text=True, timeout=60).stdout.strip()
        if ver != BINARY['version']:
            fail(f'binary --version {ver!r} is not {BINARY["version"]!r}')
        root = subprocess.run([p, '--help'], env=env, capture_output=True, text=True, timeout=60).stdout
        rpc = subprocess.run([p, '--chain', 'mainnet', 'rpc', '--help'], env=env, capture_output=True, text=True, timeout=60).stdout
        missing = sorted({f for f in argv(c) if f.startswith('--') and f'      {f}' not in rpc and f'--chain' != f})
        if missing or '-c, --chain' not in root:
            fail(f'flags not in the binary help: {missing or ["--chain"]}')


def check_reth_toml(c):
    """The datadir carries the reth.toml that `base snapshot download --<prune>` writes (base/reth download/config_gen.rs
    config_for_selections): non-default prune segments for that profile and the snapshot's static-file segment sizes.
    A fresh node writes a DEFAULT reth.toml (no prune, i.e. archive), which must not pass. With no prune flag on the CLI
    the node keeps the file's prune config (launch/common.rs save_pruning_config)."""
    import tomllib
    toml = Path(c['datadir']) / 'reth.toml'
    if not toml.is_file():
        fail('datadir/reth.toml missing: restore with `base snapshot download --%s` first' % c['prune'])
    t = tomllib.loads(toml.read_text())
    seg = (t.get('prune') or {}).get('segments') or {}
    bpf = ((t.get('static_files') or {}).get('blocks_per_file') or {})
    if seg.get('sender_recovery') != 'full' or (c['prune'] == 'minimal' and seg.get('transaction_lookup') != 'full'):
        fail(f"datadir/reth.toml prune segments are not the `{c['prune']}` download profile (a default/archive config?)")
    if not bpf or not all(isinstance(v, int) and v > 0 for v in bpf.values()):
        fail('datadir/reth.toml has no snapshot static-file segment sizes ([static_files.blocks_per_file])')
    return f"reth.toml: {c['prune']} prune segments, blocks_per_file {sorted(set(bpf.values()))}"


def preflight(c, owner_uid=None, need_free=None):
    """Read-only. -> list of checks (all must pass before `run`)."""
    out = []
    if c.get('review'):
        fail('a review-only config never passes preflight')
    check_binary(c, run_help=True)
    out.append('binary pin, --version and help flags')
    if not os.path.isdir(c['datadir']):
        fail('datadir does not exist (storage not assembled?)')
    st = os.stat(c['datadir'])
    if st.st_mode & 0o077 or (owner_uid is not None and st.st_uid != owner_uid):
        fail('datadir must be 0700 and owned by the service user')
    leaves = backing_disks(c['datadir'])
    if not leaves:
        fail('cannot resolve the datadir backing device')
    if c['storage']['cache']['mechanism'] == 'none' and not all(l['rotational'] for l in leaves):
        fail(f'datadir must be HDD-backed (no silent NVMe state); backing: {leaves}')
    if c['storage']['cache']['mechanism'] == 'dm-cache':
        if not any(l['rotational'] for l in leaves) or not any(not l['rotational'] for l in leaves):
            fail(f'a cached datadir must resolve to an HDD origin plus an NVMe cache; backing: {leaves}')
        for p in (c['storage']['cache']['dataImagePath'], c['storage']['cache']['metadataImagePath']):
            if os.stat(p).st_blocks * 512 < os.stat(p).st_size:
                fail(f'{p} is sparse: the cap must be pre-allocated, not apparent')
    out.append(f'placement {leaves}')
    if c['storage']['cache']['mechanism'] == 'dm-cache':
        nb = c['storage']['nvmeBudget']
        try:
            want = budget_reservation(c)
            r = BUDGET.admit(nb['ledgerPath'], nb['reservationId'], {f['path']: f['bytes'] for f in want['files']})
            if (r['maxBytes'], r['slackBytes'], r['blockBytes']) != (want['maxBytes'], want['slackBytes'], want['blockBytes']):
                fail(f"ledger reservation {nb['reservationId']} maxBytes/slackBytes/blockBytes differ from this configuration")
            v = BUDGET.verify(nb['ledgerPath'], nb['reservationId'])
        except BUDGET.BudgetError as e:
            fail(f'NVMe cache budget: {e}')
        out.append(f"budget: reservation {nb['reservationId']} {r['maxBytes']} B; host charged {v['chargedBytes']} of share {v['shareBytes']}")
    out.append(check_reth_toml(c))
    vfs = os.statvfs(c['datadir'])
    free = vfs.f_bavail * vfs.f_frsize
    if need_free and free < need_free:
        fail(f'free space {free} < required {need_free}')
    out.append(f'free {free}')
    avail = int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable:'))) * 1024
    if avail < c['limits']['memoryMaxBytes']:
        fail(f"MemAvailable {avail} < limits.memoryMaxBytes {c['limits']['memoryMaxBytes']} (use the CURRENT value; "
             'cached memory of running guests is not assumed reclaimable)')
    out.append(f'MemAvailable {avail}')
    busy = [p for p in (c['rpc']['port'], c['consensusRpc']['port'], c['p2p']['executionPort'], c['p2p']['consensusTcpPort']) if port_in_use(p, 'tcp')]
    busy += [p for p in (c['p2p']['executionPort'], c['p2p']['discoveryV5Port'], c['p2p']['consensusUdpPort']) if port_in_use(p, 'udp')]
    if busy:
        fail(f'ports in use: {busy}')
    out.append('ports free')
    return out


# ---- supervision ------------------------------------------------------------------------------------------------------
PR_SET_PDEATHSIG = 1


def _child_setup(nofile):
    def f():
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)   # the child dies with its supervisor
        resource.setrlimit(resource.RLIMIT_NOFILE, (nofile, nofile))
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
    return f


def rpc_call(port, method, timeout=3):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        conn.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': []}),
                     {'Content-Type': 'application/json'})
        r = conn.getresponse()
        return json.loads(r.read(1 << 16)).get('result')
    finally:
        conn.close()


def sd_notify(msg):
    path = os.environ.get('NOTIFY_SOCKET')
    if not path:
        return
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        s.connect('\0' + path[1:] if path.startswith('@') else path)
        s.send(msg.encode())
    finally:
        s.close()


class Supervisor:
    """ONE child in its own process group. Stop = SIGTERM to the group, then SIGKILL after the grace period; the child
    also gets SIGKILL if the supervisor dies (PDEATHSIG). Readiness = the loopback RPC answers the expected chain id."""

    def __init__(self, argv, env, port, chain_id_hex, stop_timeout, ready_timeout, nofile, status_path=None, log=print, cwd=None):
        self.argv, self.env, self.port, self.chain, self.cwd = argv, env, port, chain_id_hex, cwd
        self.stop_timeout, self.ready_timeout, self.nofile = stop_timeout, ready_timeout, nofile
        self.status_path, self.log = status_path, log
        self.proc, self.stopping, self.ready, self.never_ready = None, False, False, False

    def _status(self, **kw):
        if self.status_path:
            tmp = f'{self.status_path}.tmp'
            with open(tmp, 'w') as f:
                json.dump(dict(kw, pid=self.proc and self.proc.pid, ready=self.ready, at=time.time()), f)
            os.replace(tmp, self.status_path)

    def _signal_group(self, sig):
        try:
            os.killpg(self.proc.pid, sig)   # the group id is the child's pid (start_new_session)
        except ProcessLookupError:
            pass

    def stop(self, *_):
        if self.stopping or not self.proc:
            self.stopping = True
            return
        self.stopping = True
        self.log(json.dumps({'event': 'stopping', 'pid': self.proc.pid}))
        sd_notify('STOPPING=1')
        self._signal_group(signal.SIGTERM)

    def run(self, install_signals=False):
        import subprocess
        if install_signals:                 # the process entry (main thread); embedded/test callers use stop()
            signal.signal(signal.SIGTERM, self.stop)
            signal.signal(signal.SIGINT, self.stop)
        self.proc = subprocess.Popen(self.argv, env=self.env, cwd=self.cwd, stdin=subprocess.DEVNULL, close_fds=True,
                                     start_new_session=True, preexec_fn=_child_setup(self.nofile))
        self.log(json.dumps({'event': 'started', 'pid': self.proc.pid, 'argvSha256': hashlib.sha256('\0'.join(self.argv).encode()).hexdigest()}))
        self._status(state='starting')
        start, kill_at = time.monotonic(), None
        while True:
            code = self.proc.poll()
            if code is not None:
                break
            now = time.monotonic()
            if self.stopping:
                kill_at = kill_at or now + self.stop_timeout
                if now >= kill_at:
                    self.log(json.dumps({'event': 'kill', 'pid': self.proc.pid, 'after': self.stop_timeout}))
                    self._signal_group(signal.SIGKILL)
                    kill_at = now + 3600
            elif not self.ready:
                try:
                    if rpc_call(self.port, 'eth_chainId', timeout=1) == self.chain:
                        self.ready = True
                        sd_notify('READY=1\nSTATUS=loopback RPC answers chain ' + self.chain)
                        self.log(json.dumps({'event': 'ready', 'pid': self.proc.pid, 'afterSec': round(now - start, 1)}))
                        self._status(state='ready')
                except (OSError, ValueError, http.client.HTTPException):
                    pass
                if not self.ready and now - start > self.ready_timeout:
                    self.log(json.dumps({'event': 'not-ready', 'afterSec': self.ready_timeout}))
                    self.never_ready = True
                    self.stop()
            time.sleep(0.2)
        # the child is gone; reap anything left in its group (it must not outlive the supervisor)
        self._signal_group(signal.SIGKILL)
        self._status(state='exited', code=code)
        self.log(json.dumps({'event': 'exited', 'code': code, 'stopping': self.stopping}))
        if self.never_ready:
            return 70                       # never became ready: a failure, even though we stopped it
        return 0 if self.stopping and code in (0, -signal.SIGTERM) else (code if code and code > 0 else 1)


def run(c):
    if c.get('review'):
        fail('a review-only config never runs')
    check_binary(c)
    if c['l1']['selfHosted'] is False:
        print(json.dumps({'event': 'label', 'l1': 'remote L1 endpoints (declared dependency)'}), flush=True)
    status = os.path.join(os.environ.get('RUNTIME_DIRECTORY', '/run/enclave-base-holder'), 'status.json')
    sup = Supervisor(argv(c), child_env(c), c['rpc']['port'], CHAIN_ID_HEX, c['limits']['stopTimeoutSec'],
                     c['limits']['readyTimeoutSec'], c['limits']['nofile'],
                     status_path=status if os.path.isdir(os.path.dirname(status)) else None,
                     log=lambda m: print(m, flush=True), cwd=c['datadir'])   # the consensus side writes l2_jwt.hex into its cwd
    return sup.run(install_signals=True)


def main(args):
    if len(args) < 2 or args[0] not in ('validate', 'render', 'preflight', 'run', 'status'):
        print(__doc__, file=sys.stderr)
        return 64
    review = '--review' in args
    args = [a for a in args if a != '--review']
    if review and args[0] not in ('validate', 'render'):
        print(json.dumps({'refused': '--review applies to validate and render only'}))
        return 2
    try:
        c = validate(json.loads(Path(args[1]).read_text()), review=review)
        if args[0] == 'validate':
            print(json.dumps({'valid': True, 'config': c, 'argv': argv(c), 'env': child_env(c), 'labels': LABELS}, indent=1))
        elif args[0] == 'render':
            print(json.dumps(render(c, args[2]), indent=1))
        elif args[0] == 'preflight':
            print(json.dumps({'preflight': preflight(c)}, indent=1))
        elif args[0] == 'status':
            print(json.dumps({'chainId': rpc_call(c['rpc']['port'], 'eth_chainId'), 'blockNumber': rpc_call(c['rpc']['port'], 'eth_blockNumber')}))
        else:
            return run(c)
    except Refused as e:
        print(json.dumps({'refused': str(e)}))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
