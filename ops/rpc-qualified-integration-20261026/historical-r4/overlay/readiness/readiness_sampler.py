#!/usr/bin/env python3
"""Bounded, read-only production readiness sampler for the RPC VM's own loopback chain clients.

Endpoints are fixed to 127.0.0.1 (only ports are configurable, for tests). Defaults are the client ports of
chain_service.py: reth EL 18645, Lighthouse 15052, Base EL 18545, Base embedded rollup RPC 19545. Never reads
keys/JWTs/chain.json; never writes anything but its own new --out file; never follows redirects or proxies.

APIs used, from the pinned client sources (no invented fields):
  Base v1.5.1  optimism_syncStatus (crates/consensus/rpc/src/jsonrpsee.rs:113) on --rpc.port 19545
               (crates/consensus/cli/src/rpc.rs:78). SyncStatus fields are snake_case
               (crates/consensus/protocol/src/sync.rs); L2 refs are {hash, number, parentHash, timestamp,
               l1origin{hash, number}, sequenceNumber} (crates/consensus/protocol/src/block.rs:107-117).
               Underived heads are ZEROED defaults (crates/consensus/rpc/src/rollup.rs:70-87): a zero hash
               is "not derived", never a head.
               optimism_rollupConfig: RollupConfig/ChainGenesis serde (crates/common/genesis/src/{rollup,genesis}.rs);
               mainnet constants crates/common/chains/src/config.rs:455-497.
  Lighthouse v8.3.2  GET /eth/v1/beacon/blinded_blocks/{head|finalized} -> {execution_optimistic, finalized,
               data.message.body.execution_payload_header}; /eth/v1/node/syncing {is_syncing, is_optimistic,
               el_offline} (beacon_node/http_api/src/{lib,block_id}.rs).

Readiness requires, across bounded samples: matching chain identities/genesis; L1 EL not syncing; L1 CL not
syncing, not optimistic, EL online; beacon head AND finalized execution payloads equal to the EL blocks
(hash, parent, timestamp) and the EL 'finalized' tag; fresh heads; >=64 custody groups; Base EL not syncing;
Base unsafe/safe/finalized from optimism_syncStatus each equal to the Base EL block at that height, their L1
origin decoded from the block's own L1-info deposit equal to the reported l1origin and canonical on OUR L1;
finalized L2 derived from L1 at or below our L1 finalized; Base EL 'safe'/'finalized' tag blocks identical
(number/hash/parent/timestamp) to the canonical block at their height, equal to the validated rollup ref at
the same height or at most LABEL_AHEAD_MAX blocks ahead, ordered finalized <= safe <= latest; every JSON-RPC
reply a strict 2.0 envelope with id 1 and exactly one of result/error; Base SAFE and FINALIZED strictly advancing over a
window of at least --min-window seconds, never regressing; finality never rewritten; and an independently
reviewed COVERED historical-coverage receipt whose SHA-256 bindings match the evidence bytes and the expected
snapshot/config identities supplied by root. An advancing unsafe 'latest' alone is never readiness.

Identity with pruned history: our L1 EL (and Base EL with its retention) prune genesis bodies, so block 0 may be
refused with reth's EIP-4444 error (code 4444, 'pruned history unavailable: requested 0, earliest available N').
Only that exact refusal switches identity to a compensated basis, and every pinned check still runs: L1 = chainId 1
+ mainnet CL genesis/spec + the beacon finalized payload served identically by our EL; Base = chainId 8453 + the
pinned mainnet rollupConfig + a derived finalized head served identically by our Base EL with an L1 origin canonical
on our L1. Such a pass is then downgraded unless the paired/derived gates it relies on pass for the whole window.
Any other error, a null block 0, or a mismatched genesis is never accepted.

Gate status: pass | fail (observed negative evidence) | incomplete (unavailable/unobserved/insufficient).
Exit 0 READY, 3 FAIL, 4 INCOMPLETE, 2 usage/bounds. 'activationAuthorized' and 'coverageVerifiedWritten' are
always false: this tool never authorizes or performs activation.
"""
import argparse, stat
import datetime
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

FORMAT = 'enclave-rpc-readiness-sample/v1'
RECEIPT_FORMAT = 'enclave-base-coverage-acceptance/v1'
VERDICT_FORMAT = 'enclave-base-l1-coverage-verdict/v1'      # coverage/coverage_gate.py
ORIGIN_FORMAT = 'enclave-base-snapshot-origin/v1'           # coverage/origin_extract.py
HOST = '127.0.0.1'
PORTS = {'el': 18645, 'beacon': 15052, 'base': 18545, 'rollup': 19545}

# Ethereum mainnet (same constants as chain_service.py / coverage_gate.py).
EL_GENESIS = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
CL_GVR = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'
CL_GENESIS_TIME = 1606824023
LIGHTHOUSE_VERSION = 'Lighthouse/v8.3.2'
MIN_CUSTODY_GROUPS = 64

# Base mainnet (base-v1.5.1 crates/common/chains/src/config.rs MAINNET).
BASE_CHAIN_ID = 8453
BASE_L2_GENESIS = '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd'
BASE_L2_TIME = 1686789347
BASE_L1_GENESIS = {'hash': '0x5c13d307623a926cd31415036c8b7fa14572f9dac64528e857a470511fc30771', 'number': 17481768}
BASE_BATCH_INBOX = '0xff00000000000000000000000000000000008453'
BASE_SYSTEM_CONFIG = '0x73a79fab69143498ed3712e519a88a918e1f4072'
BASE_SEQ_WINDOW = 3600

# Tool pins (stage_backend.py base binary; coverage/RESULT.md kzgcheck).
BASE_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'
KZGCHECK_SHA256 = '00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb'

ZERO32 = '0x' + '00' * 32
H32 = re.compile(r'0x[0-9a-fA-F]{64}')
HEX = re.compile(r'0x[0-9a-fA-F]+')
SHA = re.compile(r'[0-9a-f]{64}')
LABEL_AHEAD_MAX = 150   # Base blocks (5 min at 2 s): tolerated tag-ahead-of-syncStatus race between two reads
DETAIL_CAP = 200
MAX_OUTPUT = 1 << 20
MAX_EVIDENCE_FILE = 16 << 20

# L1-info deposit layouts: same table as coverage/origin_extract.py (base-v1.5.1 crates/common/consensus/src/info).
L1_INFO = {
    '015d8eb9': (4 + 32 * 8, 'bedrock'),
    '440a5e20': (4 + 32 * 5, 'ecotone'),
    '098999be': (4 + 32 * 5 + 4 + 8, 'isthmus'),
    '3db6be2b': (4 + 32 * 5 + 4 + 8 + 2, 'jovian'),
}

GATES = (
    'l1-identity', 'l1-execution-synced', 'l1-consensus-nonoptimistic', 'l1-head-paired-fresh',
    'l1-finalized-paired', 'l1-custody', 'l1-head-advancing',
    'base-identity', 'base-execution-synced', 'base-heads-consistent', 'base-el-labels',
    'base-unsafe-fresh', 'base-safe-fresh', 'base-finalized-fresh',
    'base-safe-advancing', 'base-finalized-advancing', 'historical-coverage', 'post-anchor-finality', 'sampling-complete',
)


def _cut(s):
    s = str(s)
    return s if len(s) <= DETAIL_CAP else s[:DETAIL_CAP - 3] + '...'


class Unavailable(Exception):
    """Could not observe (endpoint down, HTTP/RPC error, malformed, bound hit): never negative evidence."""

    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}')
        self.code, self.detail = code, _cut(detail)


class Negative(Exception):
    """Observed, well-formed evidence that the requirement is not met."""

    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}')
        self.code, self.detail = code, _cut(detail)


class RpcRefusal(Unavailable):
    """A well-formed JSON-RPC error object; still Unavailable, but keeps its code/message for exact matching."""

    def __init__(self, detail, rpc_code, rpc_message):
        super().__init__('rpc-error', detail)
        self.rpc_code, self.rpc_message = rpc_code, rpc_message


# reth EthApiError::PrunedHistoryUnavailable (rpc-eth-types/src/error/mod.rs:88-89,364-365): EIP-4444 code 4444 and
# exactly this message. Only this refusal, for block 0, may switch identity to the pruned-genesis basis.
PRUNED_CODE = 4444
PRUNED_MSG = re.compile(r'pruned history unavailable: requested (0|[1-9][0-9]*), earliest available ([1-9][0-9]*)')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a 3xx surfaces as an HTTPError: never follow to another host


class Http:
    """Loopback-only HTTP with per-request wall timeout, response byte cap, request budget and run deadline."""

    def __init__(self, ports, timeout, max_body, max_requests, deadline):
        self.ports, self.timeout, self.max_body = ports, timeout, max_body
        self.max_requests, self.deadline = max_requests, deadline
        self.requests = self.bytes = 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)

    def fetch(self, name, path, body=None):
        if self.requests >= self.max_requests:
            raise Unavailable('request-budget-exhausted', f'more than {self.max_requests} requests')
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise Unavailable('deadline-exceeded', 'run deadline reached')
        self.requests += 1
        limit = min(self.timeout, left)
        url = f'http://{HOST}:{self.ports[name]}{path}'
        headers = {'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, body, headers)
        start = time.monotonic()
        chunks, n = [], 0
        try:
            with self.opener.open(req, timeout=limit) as r:
                status = r.getcode()
                # read1 returns as soon as any bytes arrive, so a slow-drip peer is cut off at about
                # 2x --timeout (wall check here plus the socket timeout of the last recv).
                while status == 200 and n <= self.max_body:
                    c = r.read1(min(65536, self.max_body + 1 - n))
                    if not c:
                        break
                    chunks.append(c)
                    n += len(c)
                    if time.monotonic() - start > limit:
                        raise Unavailable('response-timeout', f'{name}{path[:60]}: over {limit:.1f}s')
        except urllib.error.HTTPError as e:
            e.close()
            raise Unavailable(f'http-{e.code}', f'{name}{path[:60]}')
        except Unavailable:
            raise
        except (urllib.error.URLError, OSError, http.client.HTTPException, socket.timeout, ValueError) as e:
            raise Unavailable('endpoint-unreachable', f'{name}: {type(e).__name__}')
        self.bytes += n
        if n > self.max_body:
            raise Unavailable('response-too-large', f'{name}{path[:60]}: over {self.max_body} bytes')
        if status != 200:
            raise Unavailable(f'http-{status}', f'{name}{path[:60]}')
        try:
            return json.loads(b''.join(chunks))
        except ValueError:
            raise Unavailable('malformed-response', f'{name}{path[:60]}: not JSON')


# ---- strict field parsing (malformed => Unavailable, never silently accepted) ----

def _h32(v, where):
    if not (isinstance(v, str) and H32.fullmatch(v)):
        raise Unavailable('malformed-response', f'{where}: not a 32-byte hash')
    return v.lower()


def _qty(v, where):
    if not (isinstance(v, str) and HEX.fullmatch(v)):
        raise Unavailable('malformed-response', f'{where}: not a hex quantity')
    return int(v, 16)


def _dec(v, where):
    if not (isinstance(v, str) and v.isdigit()):
        raise Unavailable('malformed-response', f'{where}: not a decimal string')
    return int(v)


def _u64(v, where):
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise Unavailable('malformed-response', f'{where}: not an unsigned integer')
    return v


def _obj(v, where):
    if not isinstance(v, dict):
        raise Unavailable('malformed-response', f'{where}: not an object')
    return v


def _addr(v, where):
    if not (isinstance(v, str) and re.fullmatch(r'0x[0-9a-fA-F]{40}', v)):
        raise Unavailable('malformed-response', f'{where}: not an address')
    return v.lower()


def decode_l1_info(data_hex):
    """L1 origin, sequence number and batcher from an L1-info deposit's calldata (origin_extract.py layouts)."""
    if not (isinstance(data_hex, str) and re.fullmatch(r'0x([0-9a-fA-F]{2})+', data_hex)):
        raise Negative('base-l1-info-invalid', 'L1-info calldata is not hex')
    r = bytes.fromhex(data_hex[2:])
    sel = r[:4].hex()
    if sel not in L1_INFO:
        raise Negative('base-l1-info-invalid', f'first transaction is not an L1-attributes deposit (selector {sel})')
    length, layout = L1_INFO[sel]
    if len(r) != length:
        raise Negative('base-l1-info-invalid', f'{layout} L1-info calldata length {len(r)} != {length}')
    if layout == 'bedrock':
        word = lambda i: r[4 + 32 * i: 4 + 32 * (i + 1)]
        number, block_hash, seq, batcher = int.from_bytes(word(0), 'big'), word(3), int.from_bytes(word(4), 'big'), word(5)
        if any(word(i)[:24] != bytes(24) for i in (0, 1, 4)):
            raise Negative('base-l1-info-invalid', 'bedrock L1-info uint64 word has high bits set')
    else:
        number = int.from_bytes(r[28:36], 'big')
        seq = int.from_bytes(r[12:20], 'big')
        block_hash, batcher = r[100:132], r[132:164]
    if batcher[:12] != bytes(12):
        raise Negative('base-l1-info-invalid', 'batcherHash is not a version-0 address')
    return {'layout': layout, 'l1Origin': {'number': number, 'hash': '0x' + block_hash.hex()},
            'sequenceNumber': seq, 'batcher': '0x' + batcher[12:].hex()}


# ---- historical coverage receipt (validated, never a boolean) ----

def _read_evidence(path, what):
    try:
        size = os.path.getsize(path)
        if size > MAX_EVIDENCE_FILE:
            raise Negative('coverage-evidence-too-large', f'{what} over {MAX_EVIDENCE_FILE} bytes')
        with open(path, 'rb') as f:
            raw = f.read(MAX_EVIDENCE_FILE + 1)
    except OSError as e:
        raise Unavailable('coverage-evidence-unreadable', f'{what}: {type(e).__name__}')
    try:
        doc = json.loads(raw)
    except ValueError:
        raise Negative('coverage-evidence-malformed', f'{what} is not JSON')
    if not isinstance(doc, dict):
        raise Negative('coverage-evidence-malformed', f'{what} is not a JSON object')
    return hashlib.sha256(raw).hexdigest(), doc


FINALITY_STATUS_FORMAT = 'enclave-base-finality-status/v1'   # finality_state.py status-publish (base-finality-proof-stage/r5)


def validate_finality_status(a):
    """Gate post-anchor-finality (base-finality-proof-stage/r5). READY needs a root-published finality status that is CURRENT for
    the RUNNING Base node: state `qualified` for that exact process (pid + kernel start time, unchanged since root's proof). After
    ANY restart the proven process is gone or has another start time, so the gate stays incomplete until root records a NEW
    post-restart proof (finality_state record) and republishes (status-publish). Absent -> incomplete: never READY."""
    if a.finality_status is None:
        raise Unavailable('finality-status-absent', 'no --finality-status: a post-anchor finality proof for the running Base node is required')
    try:
        fd = os.open(a.finality_status, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        raise Unavailable('finality-status-unreadable', type(e).__name__)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != a.finality_status_uid or st.st_mode & 0o022:
            raise Negative('finality-status-untrusted', f'the status must be a regular file owned by uid {a.finality_status_uid}, not group/other writable')
        b = f.read((1 << 20) + 1)
    try:
        s = json.loads(b)
    except ValueError:
        raise Negative('finality-status-malformed', 'not JSON')
    if not isinstance(s, dict) or s.get('format') != FINALITY_STATUS_FORMAT or len(b) > 1 << 20:
        raise Negative('finality-status-malformed', f'not a bounded {FINALITY_STATUS_FORMAT} document')
    if s.get('state') != 'qualified' or s.get('qualified') is not True:
        raise Unavailable('finality-not-current', f'published finality state {s.get("state")!r}: a new post-anchor proof is required')
    # r7: proven is not accepted. READY needs the proof DURABLY recorded (producer record-finality: watermark entry + the launch journal's
    # `bootstrapped` event naming it); finality_state reports that event's sha as recordedAs, which is bound into this report.
    if not re.fullmatch(r'[0-9a-f]{64}', str(s.get('recordedAs'))):
        raise Unavailable('finality-not-recorded', 'the proof is not durably recorded (record-finality): consumers are not admitted yet')
    p = s.get('process') if isinstance(s.get('process'), dict) else {}
    try:
        with open(os.path.join(a.proc_root, str(int(p['pid'])), 'stat')) as f:
            start = f.read().rsplit(')', 1)[1].split()[19]
    except (OSError, KeyError, ValueError, TypeError, IndexError):
        raise Unavailable('finality-stale-after-restart', 'the proven node process is not running: a post-restart proof is required')
    if start != p.get('startTime'):
        raise Unavailable('finality-stale-after-restart', 'the node restarted since the proof: a post-restart proof is required')
    try:                                                  # r6: a FINITE freshness window on root's publication
        age = time.time() - datetime.datetime.fromisoformat(str(s.get('publishedAt')).replace('Z', '+00:00')).timestamp()
    except ValueError:
        raise Negative('finality-status-malformed', 'publishedAt is not an ISO time')
    if not 0 <= age <= a.max_finality_status_age:
        raise Unavailable('finality-status-stale', f'published {int(age)} s ago (max {a.max_finality_status_age}): the status timer is not running')
    if not isinstance(s.get('freshN'), int) or not re.fullmatch(r'0x[0-9a-f]{64}', str(s.get('freshBlockHash'))):
        raise Negative('finality-status-malformed', 'freshN/freshBlockHash')
    return {'freshN': s.get('freshN'), 'freshBlockHash': s.get('freshBlockHash'), 'entrySha256': s.get('entrySha256'), 'pid': p['pid'],
            'startTime': p.get('startTime'), 'publishedAt': s.get('publishedAt'), 'recordedAs': s.get('recordedAs')}   # r6-ops: the consumer gate re-binds the LIVE holder to it


def served_chain_check(info, rpc):
    """r6: the Base EL the consumers use serves the proven block: freshN -> exactly freshBlockHash (else another chain)."""
    try:
        blk = rpc('base', 'eth_getBlockByNumber', [hex(info['freshN']), False])
    except RpcRefusal as e:
        raise Unavailable('finality-block-not-served', str(e)[:120])
    if not isinstance(blk, dict):
        raise Unavailable('finality-block-not-served', f'the Base EL does not serve block {info["freshN"]}')
    if str(blk.get('hash', '')).lower() != str(info['freshBlockHash']).lower():
        raise Negative('finality-served-chain-mismatch', f'the served block {info["freshN"]} is not the proven block: another chain')
    return True


# ---- N-anchored segmented coverage (historical-origin-segments-stage/r4): the SAME verification core the wrapper runs ----------
ANCHORED_COVERAGE_LIB = '/opt/enclave-rpc/lib/anchored-coverage'
ANCHORED_COVERAGE_PINS = {
    'anchored_origin.py': 'ed1a547d4d8aea112cae66479c64cd9e556b531063ef361c9b156c6d2948ddfa',
    'segments.py': '8764f5cc55cc42307eadbe71695bb986ca5fa86c07db671553d50d0635c51aa1',
    'anchored_acceptance.py': 'cb68413866d0534822bdfc37702e253acfe04abad30d98e34b2231595518138d'}
ANCHORED_A1_SHA256 = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'   # the source-pinned original A1 receipt (N 52866960)
ANCHORED_SEQ_WINDOW = BASE_SEQ_WINDOW                         # need_from = l1Origin(N) - 3600 (the same Base seq_window_size)


def _anchored_lib(owner):
    """Load the pinned verification modules from the root-owned library (no symlink, not group/other writable, exact bytes)."""
    st = os.lstat(ANCHORED_COVERAGE_LIB)
    if not (stat.S_ISDIR(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022):
        raise Negative('anchored-verifier-not-pinned', 'anchored coverage library directory is not operator-controlled')
    mods = {}
    for name in ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py'):   # dependency order
        p = os.path.join(ANCHORED_COVERAGE_LIB, name)
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as f:
            fs = os.fstat(f.fileno())
            raw = f.read(1 << 22)
        if not (stat.S_ISREG(fs.st_mode) and fs.st_uid == owner and not fs.st_mode & 0o022) \
                or hashlib.sha256(raw).hexdigest() != ANCHORED_COVERAGE_PINS[name]:
            raise Negative('anchored-verifier-not-pinned', f'{name} is not the pinned, operator-owned verifier')
        mod = type(sys)(name[:-3]); mod.__file__ = p
        sys.modules[name[:-3]] = mod
        exec(compile(raw, p, 'exec'), mod.__dict__)
        mods[name] = mod
    return mods['anchored_acceptance.py']


def validate_anchored_coverage(a):
    """--coverage-anchored-dir: header N authenticated by the original A1 output root, its L1 origin bound by the parent-beacon-root/
    mixHash linkage, complete segmented coverage re-aggregated from root-owned evidence: exactly the wrapper's verification. The
    binding has the legacy shape, so the live gate is unchanged: the running Base chain must serve block N with the authenticated
    header hash, and the bound L1 origin must be canonical on our L1."""
    if a.expect_anchored_receipt_sha256 is None:
        raise Unavailable('anchored-receipt-pin-absent', '--expect-anchored-receipt-sha256 (root pin of receipt.json) is required')
    if a.expect_snapshot_manifest_sha256 is None or a.expect_chain_config_sha256 is None:
        raise Unavailable('expected-identity-absent',
                          '--expect-snapshot-manifest-sha256 and --expect-chain-config-sha256 must be pinned by root')
    try:
        aa = _anchored_lib(a.coverage_owner_uid)
    except OSError as e:
        raise Unavailable('anchored-verifier-unavailable', f'anchored coverage library: {type(e).__name__}')
    try:
        b = aa.verify_anchored_evidence(a.coverage_anchored_dir, a.coverage_owner_uid, a.expect_anchored_receipt_sha256,
                                        a.expect_kzg_sha256, a.expect_base_sha256, ANCHORED_SEQ_WINDOW, ANCHORED_A1_SHA256, time.time())
    except aa.Rejected as e:
        if e.code == 'evidence-unreadable':
            raise Unavailable('coverage-evidence-unreadable', e.detail)
        raise Negative(e.code, e.detail)
    rc = b['receipt']
    if rc.get('snapshotManifestSha256') != a.expect_snapshot_manifest_sha256:
        raise Negative('snapshot-identity-mismatch', 'receipt snapshot manifest differs from the expected pin')
    if rc.get('chainConfigSha256') != a.expect_chain_config_sha256:
        raise Negative('config-identity-mismatch', 'receipt chain config differs from the expected pin')
    return {'mode': 'anchored-segments', 'receiptSha256': b['evidence']['receiptSha256'], 'aggregateSha256': b['evidence']['aggregateSha256'],
            'snapshotSafe': {'number': b['anchor']['N'], 'hash': b['anchor']['headerHash']},
            'snapshotSafeL1Origin': {'number': b['l1Origin']['number'], 'hash': b['l1Origin']['hash']},
            'needFromBlock': b['l1Block'], 'toBlock': b['toBlock'], 'blobSlot': b['blobSlot'], 'anchor': b['anchor'],
            'review': {'reviewer': _cut(b['review']['reviewer']), 'gateRunner': _cut(b['review']['gateRunner'])},
            'trust': 'origin binding + availability (not consensus authority); evidence hash-bound to the root-pinned receipt; '
                     'reviewer identity is unsigned'}


def validate_coverage_files(a):
    """Static validation. Returns the binding the live check must confirm, or raises Unavailable/Negative."""
    if getattr(a, 'coverage_anchored_dir', None) is not None:
        if a.coverage_receipt is not None or a.coverage_verdict is not None or a.coverage_origin is not None:
            raise Negative('coverage-mode-conflict', 'anchored coverage and the legacy receipt/verdict/origin are mutually exclusive')
        return validate_anchored_coverage(a)
    if a.coverage_receipt is None:
        raise Unavailable('coverage-receipt-absent',
                          'historical coverage UNCHECKED: root must attach an independently reviewed COVERED receipt')
    if a.coverage_verdict is None or a.coverage_origin is None:
        raise Unavailable('coverage-evidence-absent', '--coverage-verdict and --coverage-origin are required with a receipt')
    if a.expect_snapshot_manifest_sha256 is None or a.expect_chain_config_sha256 is None:
        raise Unavailable('expected-identity-absent',
                          '--expect-snapshot-manifest-sha256 and --expect-chain-config-sha256 must be pinned by root')
    _, rc = _read_evidence(a.coverage_receipt, 'receipt')
    v_sha, verdict = _read_evidence(a.coverage_verdict, 'verdict')
    o_sha, origin = _read_evidence(a.coverage_origin, 'origin')
    if rc.get('format') != RECEIPT_FORMAT:
        raise Negative('receipt-format', f'receipt is not {RECEIPT_FORMAT}')
    if rc.get('decision') != 'accepted':
        raise Negative('receipt-not-accepted', f'decision {rc.get("decision")!r}')
    rv = rc.get('review') if isinstance(rc.get('review'), dict) else {}
    reviewer, runner = rv.get('reviewer'), rv.get('gateRunner')
    if not (isinstance(reviewer, str) and reviewer.strip() and isinstance(runner, str) and runner.strip()
            and reviewer.strip() != runner.strip() and isinstance(rv.get('reviewedAt'), str)):
        raise Negative('review-not-independent', 'receipt lacks a distinct reviewer, gateRunner and reviewedAt')
    for k in ('verdictSha256', 'originSha256', 'snapshotManifestSha256', 'chainConfigSha256',
              'kzgcheckSha256', 'baseBinarySha256'):
        if not (isinstance(rc.get(k), str) and SHA.fullmatch(rc[k])):
            raise Negative('receipt-format', f'receipt {k} is not a lowercase sha256')
    if rc['verdictSha256'] != v_sha:
        raise Negative('verdict-hash-mismatch', 'verdict bytes do not match receipt verdictSha256')
    if rc['originSha256'] != o_sha:
        raise Negative('origin-hash-mismatch', 'origin bytes do not match receipt originSha256')
    if rc['snapshotManifestSha256'] != a.expect_snapshot_manifest_sha256:
        raise Negative('snapshot-identity-mismatch', 'receipt snapshot manifest differs from the expected pin')
    if rc['chainConfigSha256'] != a.expect_chain_config_sha256:
        raise Negative('config-identity-mismatch', 'receipt chain config differs from the expected pin')
    if rc['kzgcheckSha256'] != a.expect_kzg_sha256 or rc['baseBinarySha256'] != a.expect_base_sha256:
        raise Negative('tool-pin-mismatch', 'receipt kzgcheck/base binary pins differ from the expected pins')
    # Origin: persisted safe label, extracted read-only with the pinned base binary.
    src = origin.get('source') if isinstance(origin.get('source'), dict) else {}
    labels = origin.get('labels') if isinstance(origin.get('labels'), dict) else {}
    safe = labels.get('safe') if isinstance(labels.get('safe'), dict) else None
    if origin.get('format') != ORIGIN_FORMAT or origin.get('status') != 'SAFE_HEAD_PERSISTED' or safe is None:
        raise Negative('origin-not-safe-labeled', 'origin is not a SAFE_HEAD_PERSISTED extraction')
    if src.get('datadirReadOnlyMount') is not True or src.get('binarySha256') != rc['baseBinarySha256']:
        raise Negative('origin-provenance', 'origin not extracted read-only by the pinned base binary')
    so = safe.get('l1Origin') if isinstance(safe.get('l1Origin'), dict) else {}
    if not (isinstance(safe.get('number'), int) and isinstance(safe.get('hash'), str) and H32.fullmatch(safe['hash'])
            and isinstance(so.get('number'), int) and isinstance(so.get('hash'), str) and H32.fullmatch(so['hash'])):
        raise Negative('origin-not-safe-labeled', 'origin safe label malformed')
    # Verdict: complete COVERED under the safe-label rule, nothing missing or mismatched.
    counts = verdict.get('counts') if isinstance(verdict.get('counts'), dict) else {}
    prop = verdict.get('proposedBaseBootstrap') if isinstance(verdict.get('proposedBaseBootstrap'), dict) else {}
    if verdict.get('format') != VERDICT_FORMAT or verdict.get('verdict') != 'COVERED' or 'refusal' in verdict \
            or verdict.get('coverageVerifiedWritten') is not False:
        raise Negative('verdict-not-covered', f'verdict {verdict.get("verdict")!r} is not a COVERED coverage gate result')
    if verdict.get('rule') != 'safe-origin-minus-seq-window' or prop.get('coverageVerifiedEligible') is not True:
        raise Negative('verdict-not-eligible', 'verdict was not produced under the persisted safe-label rule')
    need, to = verdict.get('needFromBlock'), verdict.get('toBlock')
    if not (isinstance(need, int) and isinstance(to, int) and to >= so['number'] >= need >= 0):
        raise Negative('verdict-incomplete', 'verdict range does not cover the safe L1 origin')
    if counts.get('missingData') != 0 or counts.get('mismatches') != 0 or not isinstance(counts.get('blobsVerified'), int) \
            or counts['blobsVerified'] < 1 or counts.get('blocks') != to - need + 1:
        raise Negative('verdict-incomplete', 'verdict counts show missing, mismatched, unverified or partial coverage')
    bb = rc.get('baseBootstrap') if isinstance(rc.get('baseBootstrap'), dict) else {}
    if not (need == so['number'] - BASE_SEQ_WINDOW == prop.get('l1Block') == bb.get('l1Block')
            and isinstance(prop.get('blobSlot'), int) and prop.get('blobSlot') == bb.get('blobSlot')):
        raise Negative('coverage-binding-mismatch', 'receipt/verdict/origin l1Block or blobSlot disagree')
    if verdict.get('batcher') is not None and str(verdict.get('batcher')).lower() != str(safe.get('batcher', '')).lower():
        raise Negative('coverage-binding-mismatch', 'verdict batcher differs from origin safe batcher')
    return {'verdictSha256': v_sha, 'originSha256': o_sha, 'snapshotSafe': {'number': safe['number'], 'hash': safe['hash'].lower()},
            'snapshotSafeL1Origin': {'number': so['number'], 'hash': so['hash'].lower()},
            'needFromBlock': need, 'toBlock': to, 'blobSlot': prop['blobSlot'],
            'review': {'reviewer': _cut(reviewer), 'gateRunner': _cut(runner)},
            'trust': 'receipt fields are hash-bound to evidence bytes and expected pins; reviewer identity is unsigned'}


# ---- sampler ----

class Sampler:
    def __init__(self, a, http):
        self.a, self.http = a, http
        self.gates = {g: [] for g in GATES}
        self.samples = []
        self.cache = {}
        self.last = {}   # last verified L1 finalized / Base heads, for continuity across samples

    # memoized per sample so independent checks share one fetch; errors are cached too
    def _get(self, key, fn, fresh=False):
        if fresh or key not in self.cache:
            try:
                self.cache[key] = ('ok', fn())
            except (Unavailable, Negative) as e:
                self.cache[key] = ('err', e)
        kind, v = self.cache[key]
        if kind == 'err':
            raise v
        return v

    def rpc(self, name, method, params, fresh=False):
        def call():
            doc = self.http.fetch(name, '', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                                         'params': params}).encode())
            if not isinstance(doc, dict) or doc.get('jsonrpc') != '2.0' or doc.get('id') != 1 \
                    or isinstance(doc.get('id'), bool) or ('result' in doc and 'error' in doc):
                raise Unavailable('malformed-response', f'{name} {method}: invalid JSON-RPC 2.0 envelope')
            if 'error' in doc:
                err = doc['error']
                if isinstance(err, dict) and isinstance(err.get('code'), int) and not isinstance(err.get('code'), bool) \
                        and isinstance(err.get('message'), str):
                    raise RpcRefusal(f'{name} {method}: JSON-RPC error {err["code"]}', err['code'], err['message'])
                raise Unavailable('rpc-error', f'{name} {method}: JSON-RPC error')
            if 'result' not in doc:
                raise Unavailable('malformed-response', f'{name} {method}: JSON-RPC response lacks result')
            return doc['result']
        return self._get((name, method, json.dumps(params)), call, fresh)

    def bn(self, path, fresh=False):
        def call():
            return _obj(self.http.fetch('beacon', path), path)
        return self._get(('beacon', path), call, fresh)

    def record(self, gate, idx, fn):
        try:
            info = fn()
            self.gates[gate].append({'sample': idx, 'status': 'pass', **({'info': info} if info else {})})
        except Negative as e:
            self.gates[gate].append({'sample': idx, 'status': 'fail', 'code': e.code, 'detail': e.detail})
        except Unavailable as e:
            self.gates[gate].append({'sample': idx, 'status': 'unavailable', 'code': e.code, 'detail': e.detail})

    # ---- L1 ----
    def el_block(self, name, tag, fresh=False):
        b = self.rpc(name, 'eth_getBlockByNumber', [tag, False], fresh)
        if b is None:
            return None
        b = _obj(b, f'{name} block {tag}')
        return {'number': _qty(b.get('number'), 'number'), 'hash': _h32(b.get('hash'), 'hash'),
                'parentHash': _h32(b.get('parentHash'), 'parentHash'), 'timestamp': _qty(b.get('timestamp'), 'timestamp')}

    def genesis(self, name, want):
        """Genesis block 0 of a client. Returns (basis, earliestAvailable). A served block must be the pinned genesis.
        Only reth's exact EIP-4444 refusal for block 0 yields the 'pruned' basis, which the caller must then
        compensate; any other error, a null block, or a malformed reply stays Unavailable (never a pass)."""
        try:
            g = self.el_block(name, '0x0')
        except RpcRefusal as e:
            m = PRUNED_MSG.fullmatch(e.rpc_message)
            if e.rpc_code == PRUNED_CODE and m and m[1] == '0':
                return 'pruned', int(m[2])
            raise
        if g is None:
            raise Unavailable('genesis-unavailable', f'{name} returned no block 0 and no pruned-history refusal')
        if g['number'] != 0 or g['hash'] != want:
            raise Negative('wrong-chain', f'{name} genesis hash mismatch')
        return 'block', 0

    def l1_identity(self):
        if self.rpc('el', 'eth_chainId', []) != '0x1':
            raise Negative('wrong-chain', 'L1 EL chainId is not 0x1')
        basis, earliest = self.genesis('el', EL_GENESIS)
        gen = _obj(self.bn('/eth/v1/beacon/genesis').get('data'), 'genesis')
        if _h32(gen.get('genesis_validators_root'), 'gvr') != CL_GVR or _dec(gen.get('genesis_time'), 'genesis_time') != CL_GENESIS_TIME:
            raise Negative('wrong-chain', 'L1 CL genesis mismatch')
        spec = _obj(self.bn('/eth/v1/config/spec').get('data'), 'spec')
        if spec.get('DEPOSIT_CHAIN_ID') != '1' or spec.get('SECONDS_PER_SLOT') != '12' or spec.get('FULU_FORK_EPOCH') != '411392':
            raise Negative('wrong-chain', 'L1 CL spec is not mainnet/Fulu')
        ver = _obj(self.bn('/eth/v1/node/version').get('data'), 'version').get('version')
        if not isinstance(ver, str):
            raise Unavailable('malformed-response', 'CL version')
        if not ver.startswith(LIGHTHOUSE_VERSION):
            raise Negative('wrong-client', f'CL version {ver!r} is not {LIGHTHOUSE_VERSION}')
        if basis == 'block':
            ident = {'basis': 'el-genesis-block'}
        else:
            # EL genesis body pruned: the EL's chain is identified through the mainnet beacon chain instead. The
            # beacon finalized block (non-optimistic, flagged finalized, on the CL whose GVR/genesis time/spec were
            # just checked) commits to an execution block hash; our EL must serve exactly that block. Block hashes
            # commit to all ancestors, so the EL's chain contains mainnet's. Operational identity only: it trusts
            # the local CL, as every gate here does; it is not cryptographic authority against this host.
            cl = self.cl_payload('finalized')
            if cl['finalized'] is not True:
                raise Negative('cl-finalized-flag', 'beacon finalized block not flagged finalized')
            if cl['number'] < earliest:
                raise Unavailable('identity-pairing-unavailable',
                                  f'beacon finalized {cl["number"]} is below EL earliest available {earliest}')
            el = self._paired('finalized', cl)
            ident = {'basis': 'pruned-el-genesis+mainnet-cl-paired-finalized', 'elEarliestAvailable': earliest,
                     'pairedFinalized': {'number': el['number'], 'hash': el['hash']},
                     'requires': ['l1-finalized-paired', 'l1-head-paired-fresh']}
        try:
            el_ver = self.rpc('el', 'web3_clientVersion', [])
        except Unavailable:
            el_ver = None
        return {'clVersion': _cut(ver), 'elClientVersion': _cut(el_ver) if isinstance(el_ver, str) else None,
                'identity': ident}

    def l1_execution_synced(self):
        s = self.rpc('el', 'eth_syncing', [])
        if s is not False:
            raise Negative('el-syncing', 'L1 execution client reports syncing')

    def l1_consensus(self):
        d = _obj(self.bn('/eth/v1/node/syncing').get('data'), 'syncing')
        for k in ('is_syncing', 'is_optimistic', 'el_offline'):
            if not isinstance(d.get(k), bool):
                raise Unavailable('malformed-response', f'syncing.{k}')
        if d['is_optimistic']:
            raise Negative('cl-optimistic', 'L1 consensus head is optimistic (execution unvalidated)')
        if d['el_offline']:
            raise Negative('cl-el-offline', 'L1 consensus reports the EL offline')
        if d['is_syncing']:
            raise Negative('cl-syncing', 'L1 consensus is syncing')

    def cl_payload(self, block_id, fresh=False):
        doc = self.bn(f'/eth/v1/beacon/blinded_blocks/{block_id}', fresh)
        if not isinstance(doc.get('execution_optimistic'), bool):
            raise Unavailable('malformed-response', f'blinded_blocks/{block_id}: execution_optimistic')
        if doc['execution_optimistic']:
            raise Negative('cl-optimistic', f'beacon {block_id} block is execution-optimistic')
        msg = _obj(_obj(doc.get('data'), 'data').get('message'), 'message')
        p = _obj(_obj(msg.get('body'), 'body').get('execution_payload_header'), 'execution_payload_header')
        return {'slot': _dec(msg.get('slot'), 'slot'), 'finalized': doc.get('finalized'),
                'number': _dec(p.get('block_number'), 'block_number'), 'hash': _h32(p.get('block_hash'), 'block_hash'),
                'parentHash': _h32(p.get('parent_hash'), 'parent_hash'), 'timestamp': _dec(p.get('timestamp'), 'timestamp')}

    def _paired(self, what, cl):
        el = self.el_block('el', hex(cl['number']))
        if el is None:
            raise Negative(f'el-cl-{what}-mismatch', f'EL lacks beacon {what} payload block {cl["number"]}')
        for k in ('hash', 'parentHash', 'timestamp'):
            if el[k] != cl[k]:
                raise Negative(f'el-cl-{what}-mismatch', f'EL block {cl["number"]} {k} differs from beacon {what} payload')
        return el

    def _age(self, ts, max_age, code, what):
        age = time.time() - ts
        if not -15 <= age < max_age:
            raise Negative(code, f'{what} age {age:.0f}s outside [-15, {max_age})')
        return round(age, 1)

    def l1_head(self, obs):
        cl = self.cl_payload('head')
        self._paired('head', cl)
        head = self.el_block('el', 'latest')
        if head is None:
            raise Unavailable('malformed-response', 'L1 EL latest is null')
        obs['l1Head'] = {'number': head['number'], 'hash': head['hash'], 'clHeadNumber': cl['number']}
        return {'elHeadAge': self._age(head['timestamp'], self.a.max_l1_head_age, 'l1-head-stale', 'L1 EL head'),
                'clHeadAge': self._age(cl['timestamp'], self.a.max_l1_head_age, 'l1-head-stale', 'beacon head payload')}

    def l1_finalized(self, obs):
        cl = self.cl_payload('finalized')
        if cl['finalized'] is not True:
            raise Negative('cl-finalized-flag', 'beacon finalized block not flagged finalized')
        self._paired('finalized', cl)
        tag = self.el_block('el', 'finalized')
        if tag is None or tag['hash'] != cl['hash']:
            # one race-tolerant re-read: finality may advance between the two reads at an epoch boundary
            cl = self.cl_payload('finalized', fresh=True)
            self._paired('finalized', cl)
            tag = self.el_block('el', 'finalized', fresh=True)
            if tag is None:
                raise Negative('el-finalized-absent', 'L1 EL has no finalized block')
            if tag['hash'] != cl['hash']:
                raise Negative('el-cl-finalized-diverge', f'EL finalized {tag["number"]} != beacon finalized {cl["number"]}')
        p = self.last.get('l1Finalized')
        if p:
            if tag['number'] < p['number']:
                raise Negative('l1-finality-regressed', f'L1 finalized went from {p["number"]} to {tag["number"]}')
            again = self.el_block('el', hex(p['number']))
            if again is None or again['hash'] != p['hash']:
                raise Negative('l1-finality-violated', f'L1 finalized block {p["number"]} was rewritten')
        obs['l1Finalized'] = self.last['l1Finalized'] = {'number': tag['number'], 'hash': tag['hash']}
        return {'age': self._age(tag['timestamp'], self.a.max_l1_finalized_age, 'l1-finality-stale', 'L1 finalized')}

    def l1_custody(self):
        ident = _obj(self.bn('/eth/v1/node/identity').get('data'), 'identity')
        cgc = _dec(_obj(ident.get('metadata'), 'metadata').get('custody_group_count'), 'custody_group_count')
        if cgc < MIN_CUSTODY_GROUPS:
            raise Negative('insufficient-custody', f'custody_group_count {cgc} < {MIN_CUSTODY_GROUPS}')
        return {'custodyGroupCount': cgc}

    # ---- Base ----
    def base_identity(self):
        if self.rpc('base', 'eth_chainId', []) != hex(BASE_CHAIN_ID):
            raise Negative('wrong-chain', 'Base EL chainId is not 0x2105')
        basis, earliest = self.genesis('base', BASE_L2_GENESIS)
        cfg = _obj(self.rpc('rollup', 'optimism_rollupConfig', []), 'rollupConfig')
        gen = _obj(cfg.get('genesis'), 'rollupConfig.genesis')
        l1, l2 = _obj(gen.get('l1'), 'genesis.l1'), _obj(gen.get('l2'), 'genesis.l2')
        got = {'l1_chain_id': _u64(cfg.get('l1_chain_id'), 'l1_chain_id'), 'l2_chain_id': _u64(cfg.get('l2_chain_id'), 'l2_chain_id'),
               'l1': (_h32(l1.get('hash'), 'l1.hash'), _u64(l1.get('number'), 'l1.number')),
               'l2': (_h32(l2.get('hash'), 'l2.hash'), _u64(l2.get('number'), 'l2.number')),
               'l2_time': _u64(gen.get('l2_time'), 'l2_time'), 'seq_window_size': _u64(cfg.get('seq_window_size'), 'seq_window_size'),
               'batch_inbox_address': _addr(cfg.get('batch_inbox_address'), 'batch_inbox_address'),
               'l1_system_config_address': _addr(cfg.get('l1_system_config_address'), 'l1_system_config_address')}
        want = {'l1_chain_id': 1, 'l2_chain_id': BASE_CHAIN_ID, 'l1': (BASE_L1_GENESIS['hash'], BASE_L1_GENESIS['number']),
                'l2': (BASE_L2_GENESIS, 0), 'l2_time': BASE_L2_TIME, 'seq_window_size': BASE_SEQ_WINDOW,
                'batch_inbox_address': BASE_BATCH_INBOX, 'l1_system_config_address': BASE_SYSTEM_CONFIG}
        bad = [k for k in want if got[k] != want[k]]
        if bad:
            raise Negative('wrong-chain', f'rollupConfig differs from Base mainnet: {",".join(bad)}')
        if basis == 'block':
            ident = {'basis': 'base-genesis-block'}
        else:
            # Base EL genesis body pruned (retention): the rollup node, configured with the pinned Base mainnet
            # genesis/inbox/system config just checked, must have DERIVED a finalized head that our Base EL serves
            # exactly, whose L1 origin is canonical on our (identified) L1. Operational identity only.
            f = self.sync_status()['finalized_l2']
            if f['hash'] == ZERO32 or f['number'] == 0:
                raise Unavailable('identity-pairing-unavailable', 'rollup finalized_l2 not derived')
            if f['number'] < earliest:
                raise Unavailable('identity-pairing-unavailable',
                                  f'finalized_l2 {f["number"]} is below Base EL earliest available {earliest}')
            el = self.el_block('base', hex(f['number']))
            if el is None:
                raise Negative('base-el-rollup-mismatch', f'Base EL lacks derived finalized block {f["number"]}')
            for k in ('hash', 'parentHash', 'timestamp'):
                if el[k] != f[k]:
                    raise Negative('base-el-rollup-mismatch', f'Base EL block {f["number"]} {k} differs from finalized_l2')
            o = f['l1origin']
            l1 = self.el_block('el', hex(o['number']))
            if l1 is None or l1['hash'] != o['hash']:
                raise Negative('base-l1-origin-not-canonical', f'finalized_l2 L1 origin {o["number"]} not canonical on our L1')
            ident = {'basis': 'pruned-base-genesis+mainnet-rollupConfig-derived-finalized', 'elEarliestAvailable': earliest,
                     'derivedFinalized': {'number': f['number'], 'hash': f['hash']},
                     'requires': ['l1-identity', 'base-heads-consistent']}
        try:
            ver = self.rpc('rollup', 'optimism_version', [])
        except Unavailable:
            ver = None
        return {'rollupVersion': _cut(ver) if isinstance(ver, str) else None, 'identity': ident}

    def base_execution_synced(self):
        if self.rpc('base', 'eth_syncing', []) is not False:
            raise Negative('base-el-syncing', 'Base execution client reports syncing')

    def sync_status(self):
        st = _obj(self.rpc('rollup', 'optimism_syncStatus', []), 'syncStatus')
        out = {}
        for k in ('unsafe_l2', 'safe_l2', 'finalized_l2'):
            r = _obj(st.get(k), k)
            o = _obj(r.get('l1origin'), f'{k}.l1origin')
            out[k] = {'number': _u64(r.get('number'), f'{k}.number'), 'hash': _h32(r.get('hash'), f'{k}.hash'),
                      'parentHash': _h32(r.get('parentHash'), f'{k}.parentHash'),
                      'timestamp': _u64(r.get('timestamp'), f'{k}.timestamp'),
                      'l1origin': {'number': _u64(o.get('number'), f'{k}.l1origin.number'),
                                   'hash': _h32(o.get('hash'), f'{k}.l1origin.hash')},
                      'sequenceNumber': _u64(r.get('sequenceNumber'), f'{k}.sequenceNumber')}
        r = _obj(st.get('finalized_l1'), 'finalized_l1')
        out['finalized_l1'] = {'number': _u64(r.get('number'), 'finalized_l1.number'),
                               'hash': _h32(r.get('hash'), 'finalized_l1.hash')}
        return out

    def base_heads(self, obs):
        st = self.sync_status()
        for k in ('unsafe_l2', 'safe_l2', 'finalized_l2'):
            if st[k]['hash'] == ZERO32 or st[k]['number'] == 0:
                raise Negative(f'base-{k.split("_")[0]}-not-derived', f'optimism_syncStatus {k} is zeroed (not derived)')
        u, s, f = st['unsafe_l2'], st['safe_l2'], st['finalized_l2']
        obs['baseReported'] = {k: st[k]['number'] for k in ('unsafe_l2', 'safe_l2', 'finalized_l2')}
        if not f['number'] <= s['number'] <= u['number']:
            raise Negative('base-head-order', 'finalized <= safe <= unsafe violated')
        for k in ('unsafe_l2', 'safe_l2', 'finalized_l2'):
            r = st[k]
            el = self.el_block('base', hex(r['number']))
            if el is None:
                raise Negative('base-el-rollup-mismatch', f'Base EL lacks {k} block {r["number"]}')
            for f2 in ('hash', 'parentHash', 'timestamp'):
                if el[f2] != r[f2]:
                    raise Negative('base-el-rollup-mismatch', f'Base EL block {r["number"]} {f2} differs from {k}')
            tx = self.rpc('base', 'eth_getTransactionByBlockNumberAndIndex', [hex(r['number']), '0x0'])
            if tx is None:
                raise Negative('base-l1-info-invalid', f'{k} block {r["number"]} has no L1-info deposit')
            tx = _obj(tx, 'deposit')
            if str(tx.get('type', '')).lower() != '0x7e':
                raise Negative('base-l1-info-invalid', f'{k} block {r["number"]} first tx is not a deposit')
            info = decode_l1_info(tx.get('input'))
            if info['l1Origin'] != r['l1origin'] or info['sequenceNumber'] != r['sequenceNumber']:
                raise Negative('base-l1-origin-mismatch', f'{k} L1-info deposit disagrees with reported l1origin/sequenceNumber')
        # L1 origins of derived heads must be canonical on OUR L1; finalized must derive from our finalized L1.
        l1_fin_now = self.el_block('el', 'finalized', fresh=True)
        if l1_fin_now is None:
            raise Negative('el-finalized-absent', 'L1 EL has no finalized block')
        fl1 = st['finalized_l1']
        if fl1['hash'] == ZERO32 or fl1['number'] == 0:
            raise Negative('base-finalized-not-derived', 'rollup reports zeroed finalized_l1')
        if fl1['number'] > l1_fin_now['number']:
            raise Negative('base-l1-finality-ahead', f'rollup finalized_l1 {fl1["number"]} above our L1 finalized {l1_fin_now["number"]}')
        for what, ref in (('finalized_l1', fl1), ('safe_l2.l1origin', s['l1origin']), ('finalized_l2.l1origin', f['l1origin'])):
            b = self.el_block('el', hex(ref['number']))
            if b is None or b['hash'] != ref['hash']:
                raise Negative('base-l1-origin-not-canonical', f'{what} {ref["number"]} is not canonical on our L1')
        if f['l1origin']['number'] > fl1['number']:
            raise Negative('base-finalized-beyond-l1-finality', 'finalized_l2 origin above finalized_l1')
        # Continuity with the last VERIFIED sample: finality must never be rewritten or regress.
        last = self.last.get('base')
        if last:
            pf = last['finalized_l2']
            if f['number'] < pf['number']:
                raise Negative('base-finality-regressed', f'Base finalized went from {pf["number"]} to {f["number"]}')
            again = self.el_block('base', hex(pf['number']))
            if again is None or again['hash'] != pf['hash']:
                raise Negative('base-finality-violated', f'Base finalized block {pf["number"]} was rewritten')
        verified = {k: {'number': st[k]['number'], 'hash': st[k]['hash'], 'parentHash': st[k]['parentHash'],
                        'timestamp': st[k]['timestamp'], 'l1origin': st[k]['l1origin']}
                    for k in ('unsafe_l2', 'safe_l2', 'finalized_l2')}
        obs['base'] = self.last['base'] = verified
        if last:
            ps = last['safe_l2']
            again = self.el_block('base', hex(ps['number']))
            if again is None or again['hash'] != ps['hash'] or s['number'] < ps['number']:
                # A legitimate L1 reorg can move safe: not negative evidence, but this window is unusable.
                raise Unavailable('base-safe-reorged', f'Base safe {ps["number"]} reorged during the window; resample')
        return {'unsafe': u['number'], 'safe': s['number'], 'finalized': f['number']}

    def base_el_labels(self, obs):
        st = obs.get('base')
        if not st:
            raise Unavailable('not-evaluated', 'syncStatus unavailable in this sample')
        tags = {}
        for tag, k in (('safe', 'safe_l2'), ('finalized', 'finalized_l2')):
            b = self.el_block('base', tag)
            if b is None:
                raise Unavailable('base-el-label-absent', f'Base EL {tag!r} tag returned null')
            # The tag's block must be the canonical block at its own height (number/hash/parent/timestamp).
            canon = self.el_block('base', hex(b['number']))
            if canon is None or canon != b:
                raise Negative('base-el-label-noncanonical',
                               f'Base EL {tag!r} block {b["number"]} differs from the canonical block at that height')
            ref = st[k]
            if b['number'] < ref['number']:
                raise Unavailable('base-el-label-behind', f'Base EL {tag!r} {b["number"]} behind rollup {k} {ref["number"]}')
            if b['number'] == ref['number']:
                if b['hash'] != ref['hash'] or b['parentHash'] != ref['parentHash'] or b['timestamp'] != ref['timestamp']:
                    raise Negative('base-el-label-mismatch', f'Base EL {tag!r} differs from the validated rollup {k}')
            elif b['number'] - ref['number'] > LABEL_AHEAD_MAX:
                # Only a short race (labels advancing between the two reads) is tolerated.
                raise Negative('base-el-label-ahead-incoherent',
                               f'Base EL {tag!r} {b["number"]} is {b["number"] - ref["number"]} blocks ahead of rollup {k}')
            tags[tag] = b
        latest = self.el_block('base', 'latest', fresh=True)
        if latest is None:
            raise Unavailable('base-el-label-absent', "Base EL 'latest' returned null")
        if not tags['finalized']['number'] <= tags['safe']['number'] <= latest['number']:
            raise Negative('base-el-label-order', "Base EL tags violate finalized <= safe <= latest")
        return {t: b['number'] for t, b in tags.items()}

    def base_fresh(self, obs, k, max_age, code):
        st = obs.get('base')
        if not st:
            raise Unavailable('not-evaluated', 'syncStatus unavailable in this sample')
        return {'age': self._age(st[k]['timestamp'], max_age, code, f'Base {k}')}

    def coverage_live(self, binding):
        b = self.el_block('base', hex(binding['snapshotSafe']['number']))
        if b is None:
            raise Unavailable('snapshot-block-unavailable', 'Base EL does not serve the covered snapshot safe block')
        if b['hash'] != binding['snapshotSafe']['hash']:
            raise Negative('snapshot-not-ancestor', 'running Base chain does not contain the covered snapshot safe block')
        o = binding['snapshotSafeL1Origin']
        l1 = self.el_block('el', hex(o['number']))
        if l1 is None:
            raise Unavailable('snapshot-origin-unavailable', 'L1 EL does not serve the covered safe L1 origin')
        if l1['hash'] != o['hash']:
            raise Negative('snapshot-origin-not-canonical', 'covered safe L1 origin is not canonical on our L1')

    # ---- driver ----
    def one(self, idx, coverage):
        self.cache = {}
        obs = {'index': idx, 'unixTime': round(time.time(), 3), 'monotonic': time.monotonic()}
        if idx == 0:
            self.record('l1-identity', idx, self.l1_identity)
            self.record('l1-custody', idx, self.l1_custody)
            self.record('base-identity', idx, self.base_identity)
            if coverage.get('binding'):
                self.record('historical-coverage', idx, lambda: self.coverage_live(coverage['binding']))
        self.record('l1-execution-synced', idx, self.l1_execution_synced)
        self.record('l1-consensus-nonoptimistic', idx, self.l1_consensus)
        self.record('l1-head-paired-fresh', idx, lambda: self.l1_head(obs))
        self.record('l1-finalized-paired', idx, lambda: self.l1_finalized(obs))
        self.record('base-execution-synced', idx, self.base_execution_synced)
        self.record('base-heads-consistent', idx, lambda: self.base_heads(obs))
        self.record('base-el-labels', idx, lambda: self.base_el_labels(obs))
        self.record('base-unsafe-fresh', idx, lambda: self.base_fresh(obs, 'unsafe_l2', self.a.max_unsafe_age, 'base-unsafe-stale'))
        self.record('base-safe-fresh', idx, lambda: self.base_fresh(obs, 'safe_l2', self.a.max_safe_age, 'base-safe-stale'))
        self.record('base-finalized-fresh', idx,
                    lambda: self.base_fresh(obs, 'finalized_l2', self.a.max_finalized_age, 'base-finalized-stale'))
        return obs

    def any_fail(self):
        return any(r['status'] == 'fail' for rs in self.gates.values() for r in rs)

    def advancing(self, gate, key, label):
        pts = [(o['monotonic'], o[key[0]][key[1]]['number'] if key[1] else o[key[0]]['number'])
               for o in self.samples if o.get(key[0]) and (not key[1] or o[key[0]].get(key[1]))]
        if len(pts) < 2:
            self.gates[gate].append({'sample': None, 'status': 'unavailable', 'code': 'insufficient-samples',
                                     'detail': f'{len(pts)} usable samples for {label}'})
            return
        window = pts[-1][0] - pts[0][0]
        nums = [n for _, n in pts]
        if pts[-1][1] <= pts[0][1]:
            self.gates[gate].append({'sample': None, 'status': 'fail', 'code': f'{label}-not-advancing',
                                     'detail': f'{label} {nums[0]} -> {nums[-1]} over {window:.0f}s'})
        elif window < self.a.min_window:
            self.gates[gate].append({'sample': None, 'status': 'unavailable', 'code': 'window-too-short',
                                     'detail': f'{window:.0f}s < --min-window {self.a.min_window}s'})
        else:
            self.gates[gate].append({'sample': None, 'status': 'pass',
                                     'info': {'from': nums[0], 'to': nums[-1], 'windowSeconds': round(window, 1)}})


def summarize(results):
    if not results:
        return {'status': 'incomplete', 'code': 'not-evaluated'}
    for want, status in (('fail', 'fail'), ('unavailable', 'incomplete')):
        bad = [r for r in results if r['status'] == want]
        if bad:
            return {'status': status, 'code': bad[0]['code'], 'detail': bad[0].get('detail', ''),
                    'samples': [r['sample'] for r in bad][:8], 'count': len(bad)}
    info = [r['info'] for r in results if r.get('info')]
    return {'status': 'pass', **({'info': info[-1]} if info else {})}


def enforce_identity_basis(gates):
    """A pruned-genesis identity pass stands only if every gate it relies on passed across the whole window;
    otherwise the identity gate itself is downgraded (never left passing on its own)."""
    for gate in ('l1-identity', 'base-identity'):
        for r in list(gates[gate]):
            req = r['status'] == 'pass' and (r.get('info') or {}).get('identity', {}).get('requires')
            if not req:
                continue
            weak = [g for g in req if summarize(gates[g])['status'] != 'pass']
            if weak:
                gates[gate].append({'sample': None, 'status': 'unavailable', 'code': 'identity-basis-unconfirmed',
                                    'detail': f'pruned-genesis identity requires passing {",".join(weak)}'})


def run(a):
    started = time.time()
    deadline = time.monotonic() + a.max_duration
    http = Http(dict(PORTS, el=a.el_port, beacon=a.beacon_port, base=a.base_port, rollup=a.rollup_port),
                a.timeout, a.max_body, a.max_requests, deadline)
    s = Sampler(a, http)
    coverage = {}
    try:
        coverage['binding'] = validate_coverage_files(a)
    except Negative as e:
        s.gates['historical-coverage'].append({'sample': None, 'status': 'fail', 'code': e.code, 'detail': e.detail})
    except Unavailable as e:
        s.gates['historical-coverage'].append({'sample': None, 'status': 'unavailable', 'code': e.code, 'detail': e.detail})
    try:
        info = validate_finality_status(a)
        # r6: the SERVED chain holds the proven block: the Base EL at the sampler's port answers freshN with exactly freshBlockHash
        served_chain_check(info, lambda name, method, params: s.rpc(name, method, params, fresh=True))
        s.gates['post-anchor-finality'].append({'sample': None, 'status': 'pass', 'info': info})
    except Negative as e:
        s.gates['post-anchor-finality'].append({'sample': None, 'status': 'fail', 'code': e.code, 'detail': e.detail})
    except Unavailable as e:
        s.gates['post-anchor-finality'].append({'sample': None, 'status': 'unavailable', 'code': e.code, 'detail': e.detail})
    stopped_early = False
    for i in range(a.samples):
        t0 = time.monotonic()
        s.samples.append(s.one(i, coverage))
        if s.any_fail() and not a.continue_on_fail:
            stopped_early = i + 1 < a.samples
            break
        if i + 1 < a.samples:
            wait = t0 + a.interval - time.monotonic()
            if wait > 0:
                if time.monotonic() + wait >= deadline:
                    break
                time.sleep(wait)
    taken = len(s.samples)
    s.advancing('l1-head-advancing', ('l1Head', None), 'l1-head')
    s.advancing('base-safe-advancing', ('base', 'safe_l2'), 'base-safe')
    s.advancing('base-finalized-advancing', ('base', 'finalized_l2'), 'base-finalized')
    if taken == a.samples:
        s.gates['sampling-complete'].append({'sample': None, 'status': 'pass', 'info': {'samples': taken}})
    elif stopped_early:
        s.gates['sampling-complete'].append({'sample': None, 'status': 'unavailable', 'code': 'stopped-on-fail',
                                             'detail': f'{taken}/{a.samples} samples; a gate already failed'})
    else:
        s.gates['sampling-complete'].append({'sample': None, 'status': 'unavailable', 'code': 'deadline',
                                             'detail': f'{taken}/{a.samples} samples within --max-duration'})
    enforce_identity_basis(s.gates)
    gates = {g: summarize(s.gates[g]) for g in GATES}
    statuses = {v['status'] for v in gates.values()}
    overall = 'FAIL' if 'fail' in statuses else 'INCOMPLETE' if 'incomplete' in statuses else 'READY'
    for o in s.samples:
        o.pop('monotonic', None)
    report = {
        'format': FORMAT, 'overall': overall, 'acceptance': overall == 'READY',
        'activationAuthorized': False, 'coverageVerifiedWritten': False,
        'unsafeLatestAloneIsNeverReadiness': True,
        'startedAt': round(started, 3), 'finishedAt': round(time.time(), 3),
        'endpoints': {k: f'http://{HOST}:{v}' for k, v in http.ports.items()},
        'bounds': {'samples': a.samples, 'interval': a.interval, 'minWindow': a.min_window, 'timeout': a.timeout,
                   'maxBody': a.max_body, 'maxRequests': a.max_requests, 'maxDuration': a.max_duration},
        'http': {'requests': http.requests, 'bytes': http.bytes},
        'gates': gates,
        'coverage': coverage.get('binding') or {'status': gates['historical-coverage']['status'],
                                                 'note': 'no validated coverage receipt binding'},
        'samples': s.samples,
        'notes': ['Sampler evidence only. Root review is required; this never authorizes activation.',
                  'One operator / one site; Base sequencer dependence and forced inclusion remain out of scope.'],
    }
    return report, {'READY': 0, 'FAIL': 3, 'INCOMPLETE': 4}[overall]


def _sha_arg(v):
    if not SHA.fullmatch(v):
        raise argparse.ArgumentTypeError('expected a lowercase sha256 hex digest')
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True, help='new file; existing files are never overwritten')
    ap.add_argument('--samples', type=int, default=8)
    ap.add_argument('--interval', type=float, default=120.0, help='seconds between sample starts')
    ap.add_argument('--min-window', type=float, default=600.0,
                    help='minimum observed seconds for an advancement gate to pass')
    ap.add_argument('--timeout', type=float, default=5.0)
    ap.add_argument('--max-body', type=int, default=4 << 20)
    ap.add_argument('--max-requests', type=int, help='default: 40 per sample + 40, at most 2000')
    ap.add_argument('--max-duration', type=float)
    ap.add_argument('--max-l1-head-age', type=int, default=120)
    ap.add_argument('--max-l1-finalized-age', type=int, default=3600)
    ap.add_argument('--max-unsafe-age', type=int, default=120)
    ap.add_argument('--max-safe-age', type=int, default=1800)
    ap.add_argument('--max-finalized-age', type=int, default=3600)
    ap.add_argument('--continue-on-fail', action='store_true')
    for k, v in PORTS.items():
        ap.add_argument(f'--{k}-port', type=int, default=v)
    ap.add_argument('--coverage-receipt')
    ap.add_argument('--coverage-anchored-dir', help='N-anchored segmented coverage evidence directory (root-owned)')
    ap.add_argument('--expect-anchored-receipt-sha256', type=_sha_arg)
    ap.add_argument('--coverage-owner-uid', type=int, default=0)
    ap.add_argument('--finality-status', help='root-published finality_state status-publish file (gate post-anchor-finality)')
    ap.add_argument('--finality-status-uid', type=int, default=0)
    ap.add_argument('--max-finality-status-age', type=int, default=900)
    ap.add_argument('--proc-root', default='/proc')
    ap.add_argument('--coverage-verdict')
    ap.add_argument('--coverage-origin')
    ap.add_argument('--expect-snapshot-manifest-sha256', type=_sha_arg)
    ap.add_argument('--expect-chain-config-sha256', type=_sha_arg)
    ap.add_argument('--expect-kzg-sha256', type=_sha_arg, default=KZGCHECK_SHA256)
    ap.add_argument('--expect-base-sha256', type=_sha_arg, default=BASE_BINARY_SHA256)
    a = ap.parse_args(argv)
    if a.max_duration is None:
        a.max_duration = min(3900, (a.samples - 1) * a.interval + 30 * a.timeout + 60)
    if a.max_requests is None:
        a.max_requests = min(2000, 40 * a.samples + 40)
    ok = (2 <= a.samples <= 32 and 0.05 <= a.interval <= 600 and (a.samples - 1) * a.interval <= 3600
          and 0 <= a.min_window <= 3600 and 0 < a.timeout <= 15 and 64 << 10 <= a.max_body <= 16 << 20
          and 1 <= a.max_requests <= 2000 and 1 <= a.max_duration <= 3900
          and 1 <= a.max_l1_head_age <= 600 and 1 <= a.max_l1_finalized_age <= 7200
          and 1 <= a.max_unsafe_age <= 600 and 1 <= a.max_safe_age <= 7200 and 1 <= a.max_finalized_age <= 7200
          and all(1 <= getattr(a, f'{k}_port') <= 65535 for k in PORTS))
    if not ok:
        ap.error('bounds outside the allowed envelope')
    if os.path.lexists(a.out):
        ap.error('--out exists; refusing to overwrite evidence')
    report, rc = run(a)
    text = json.dumps(report, indent=1, sort_keys=True)
    if len(text) > MAX_OUTPUT:
        report['samples'] = [{'truncated': len(report['samples'])}]
        text = json.dumps(report, indent=1, sort_keys=True)
    if len(text) > MAX_OUTPUT:
        raise SystemExit('report exceeds the output bound even without samples')
    with open(a.out, 'x') as f:
        f.write(text)
    print(json.dumps({'overall': report['overall'], 'acceptance': report['acceptance'],
                      'failing': sorted(g for g, v in report['gates'].items() if v['status'] == 'fail'),
                      'incomplete': sorted(g for g, v in report['gates'].items() if v['status'] == 'incomplete'),
                      'out': a.out}))
    return rc


if __name__ == '__main__':
    sys.exit(main())
