#!/usr/bin/env python3
"""Writes RESULT.json for the RPC budget review (inventory hashes, root measurements cited, source model, findings, tests)."""
import json, hashlib, pathlib, datetime

sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def t(f):
    s = pathlib.Path(f).read_text().splitlines()
    g = lambda k: next((l.split()[-1] for l in s if l.startswith(k)), None)
    return {'log': f, 'pass': g('# pass'), 'fail': g('# fail'), 'queueExit': g('[queue] EXIT')}


res = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    'task': 'Source-only RPC budget review: policy/host/wallet/gas-relay Base RPC cadence; avoidable duplicates/retries; minimal fixes',
    'scope': 'Source only. No probe/SSH/production/process observer/wallet/build/endpoint change. One small regression test, queue 256. Root measurements read, not repeated.',
    'measuredByRoot': {
        'gate': {'file': 'work/root-platform-gate-20261022/result.json', 'at': '2026-10-22T04:12:03.548Z', 'bundle': '6bef372d', 'option': 'R',
                 'rpcHosts': 5, 'minAgree': 3, 'reason': 'only 2 RPCs answered (need 3)', 'verdict': 'UNKNOWN'},
        'rpcDiag': {'file': 'work/root-policy-rpc-20261022/result.json', 'at': '2026-10-22T04:16:31.712Z',
                    'firstCall429': ['base-public.nodies.app', 'base.drpc.org', 'base.gateway.tenderly.co'], 'quotaRefusal': 'public.1rpc.io',
                    'ok': ['mainnet.base.org', 'base-rpc.publicnode.com']},
        'blockpi': {'file': 'work/root-policy-rpc-blockpi-20261022/result.json', 'at': '2026-10-22T04:19:39.540Z',
                    'url': 'https://base.blockpi.network/v1/rpc/public', 'http': 503, 'error': 'Apikey not found'},
        'earlier': {'files': ['work/root-rpc-recovery-20261022/native-rpc.json', 'work/root-rpc-recovery-20261022/native-tenderly-mainnet.json'],
                    'at': '2026-10-22T02:49:48Z / 02:50:11Z', 'nodies': '429 on first call', 'tenderly': '200 on all calls'},
    },
    'versions': {
        'live': {'source': 'work/root-live-control-20261022/snapshot.json (01:44:55Z) + root postflight 03:09Z "host control OLD"',
                 'host.mjs': 'c4629529', 'chain.mjs': '753818e2', 'host-admission.bundle.mjs': '66c6e15a', 'lease-gas-runtime.bundle.mjs': 'd2e363c5',
                 'privacy-agent.mjs': 'cfb69370 (live since 02:22:18Z)'},
        'candidate': {'source': 'work/root-control-rpc-final-20261022/control-package (NOT executed)', 'host.mjs': '9634cb40', 'chain.mjs': '86c81124',
                      'host-admission.bundle.mjs': '6bef372d', 'lease-gas-runtime.bundle.mjs': '159108d1', 'wallet-admission.mjs': '0fa7678f'},
        'bundle6befSource': 'work/node-hold-host-review-20261021/tree with PRODUCTION_MIRRORS emptied (byte-exact rebuild proven there, logs/repro.out); closure copied to src-6bef/',
        'walletReaderSettingsIdenticalLiveAndCandidate': True,
        'rpcSets': {'liveNodeAndPrivacy': 'publicnode, drpc, mainnet (run-node.cmd line-12 override; last recorded 02:38Z; root reports configs unchanged 04:20Z; not re-read)',
                    'chainDefaultAndCutoverRepair': 'publicnode, tenderly, nodies, drpc, mainnet',
                    'gateProductionDefault': 'mainnet, publicnode, drpc, base.public.blockpi.network (minAgree 3 of 4)'},
    },
    'perCallCost': {
        'leaseReaderAgreed': '2N head (eth_chainId + eth_blockNumber to every client, lease-reader.mjs:264) + up to H*(R+2) reads; 429 retried only until decided (wallet reader budget 10 s)',
        'platformGateSnapshot': 'N heads (eth_blockNumber) + 9*H reads (2 getBlock, 4 book calls, getCode, 2 host-row calls); viem retryCount 0 (quorum.mjs:103-131, platform-host-policy.mjs:137)',
        'chainMjsSingleReads': 'viem fallback, publicnode first; per-URL retryCount:2 inert (fallback forces 0); outer default 3 whole-list retries only when every URL fails (chain.mjs:138)',
    },
    'cadence': {
        'nodeTick': '30 s single-flight (host.mjs:59, :326): chain.mjs scan/readDeployment (publicnode) + per tracked deployment one uncached catalog agreed() + authority agreed() cached 15 s',
        'platformGate': '60 s, coalesced, only when ENCLAVE_PLATFORM_HOST_POLICY is set (host-service-gate.mjs:30)',
        'privacyAgent': '15 s refreshAuthorization -> one coalesced LeaseReader snapshot (privacy-agent.mjs:86879)',
        'gasRelay': 'event-driven (no interval in the bundle)',
        'estimatePer30s_sourceOnly': {
            'live3': {'publicnode': '~58-77', 'mainnet': '~43-52', 'drpc': '~24-44 (all refused)', 'tenderly': 0, 'nodies': 0},
            'candidate5_addedPerProvider': {'tenderly': '~25-27 head requests', 'nodies': '~25-27 head requests'},
            'note': 'SOURCE ESTIMATE for 9 tracked deployments, not measured traffic; bursts ~2-4 req/s per RPC during a pass'},
    },
    'findings': {
        'F1_proved_chainid_redundancy': {
            'what': 'eth_chainId re-asked of every RPC on every LeaseReader.agreed() call',
            'share': 'half of head requests; ~20% of requests to answering RPCs, 50% to 429-ing RPCs',
            'patch': {'file': 'proposed/lease-reader-chainid-memo.patch', 'sha256': sha('proposed/lease-reader-chainid-memo.patch'),
                      'patchedFile': 'proposed-tree/network/lease-reader.mjs', 'patchedSha256': sha('proposed-tree/network/lease-reader.mjs'),
                      'baseSha256': sha('src-6bef/network/lease-reader.mjs')},
            'preserves': 'first-use and 10-min recheck chain-id verification, mismatch refusal, head every call, 2-distinct-peer agreement, freshness, deadlines, fail-closed, admin authority',
            'integrationCost': 'lease-reader.mjs is bundled in host-admission.bundle (6bef) and privacy-agent (cfb69370): rebuild both, new pins, review, activation; not proposed for the current cutover'},
        'F2_structural_catalog_per_deployment': 'one uncached catalog snapshot per deployment per pass (9 of ~11 wallet snapshots); a per-pass batch at one fresh block would cut ~70% but changes when moderation is read; root decision, not implemented',
        'F3_fallback_retries': 'not contributing while publicnode answers; per-URL retry options inert',
        'F4_not_avoidable': 'double getBlock, heads to all RPCs, gate reads on all answering RPCs, existing 15 s authority cache',
        'F5_429_retries_drpc': '0-1 extra head pair per call until decided; effect on the provider window not provable from source',
    },
    'tests': {
        'patched': t('logs/memo-patched-expect-patched.out'),
        'originalOwnExpectations': t('logs/memo-original-expect-original.out'),
        'negativeControl_originalWithPatchedExpectations': {**t('logs/memo-original-expect-patched.out'), 'expectedFailure': 'once-per-client: actual [3,3,3] vs expected [1,1,1]'},
        'earlierRunsBeforeExpectVar': ['logs/memo-patched.out', 'logs/memo-original.out'],
    },
    'conclusion': ("Option R UNKNOWN is correct fail-closed behaviour: 3 of 5 keyless providers refused a FIRST single request from this IP, so 3-of-5 is "
                   "unreachable; no source-level request reduction makes them answer, and the live 3-host config sends tenderly/nodies nothing. F1 reduces "
                   "this host's own load (worth applying in a later bundle rebuild); no fabricated capacity fix. Root options: defer activation until a fresh "
                   "measurement shows >= minAgree answering providers; reduce other same-IP workloads; F1 follow-up. No weakening recommended."),
    'notDone': ['No measured traffic of node/privacy agent (process observation and probes out of scope)', 'run-node.cmd current content not re-read',
                'base.public.blockpi.network (PRODUCTION_RPCS spelling) not measured'],
}
res['inventory'] = {str(p): sha(p) for p in sorted(pathlib.Path('.').rglob('*'))
                    if p.is_file() and 'node_modules' not in p.parts and p.name != 'RESULT.json'}
pathlib.Path('RESULT.json').write_text(json.dumps(res, indent=1) + '\n')
print(json.dumps(res['tests'], indent=1))
