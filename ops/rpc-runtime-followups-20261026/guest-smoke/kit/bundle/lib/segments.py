#!/usr/bin/env python3
"""segments.py: L1 coverage of the ANCHORED range [l1Origin(N) - SEQ_WINDOW, toBlock] as contiguous <=30000-block segments.

Each segment is checked by the UNMODIFIED, sha-pinned coverage/coverage_gate.py (b4f6d639) `main()`: every per-block check it has
(EL parent links, receipts + recomputed header/tx/receipt roots via kzgcheck, beacon canonical/parent_root/EL-hash commitment, batcher blob
KZG, batcher-change refusal, L1 readiness, origin canonicality, loopback/bounds policy). Only three module globals are replaced in a private
copy of the module: `required_range` (returns the plan's segment start and the anchor label instead of the snapshot safe head), `Client`
(a subclass that RECORDS, never alters, the EL/beacon values the gate verified at the two segment ends and at l1Origin) and `FORMAT`
(segment gate reports are `enclave-base-l1-coverage-segment-gate/v1`, so no consumer of verdict/v1 can mistake one for a whole verdict).
The gate's own HARD_MAX_BLOCKS (30000) is unchanged and each run passes --max-blocks = its segment length.

  plan        --anchored DOC --receipt A1 --node NODE --to-block T --segment-blocks S --out PLAN
  run-segment --plan PLAN --index I --out-dir NEW_DIR --el URL --beacon URL --kzg P --kzg-sha256 H [gate bounds...]
  aggregate   --plan PLAN --segment DIR [--segment DIR ...] --out F [--max-evidence-age SECONDS]

plan re-verifies the anchored-origin document WITHOUT the DB: the recorded Isthmus header must again bind (pinned authenticateAnchor) to the
pinned A1 receipt's N and outputRoot. aggregate accepts only: one COVERED segment per planned index from THIS plan (sha), exact range
endpoints, no gap/overlap/duplicate, EL parentHash and beacon parent_root links across every boundary, the same L1 endpoints, gate and
kzgcheck pins, evidence no older than --max-evidence-age, and the L1 block at l1Origin carrying the anchor header's mixHash and
parentBeaconBlockRoot. Nothing here writes chain.json / coverageVerified. Exit 0 = written and accepted, 3 = refused, 2 = usage."""
import argparse, hashlib, json, math, os, re, sys, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchored_origin as AO  # noqa: E402

GATE = (f'{AO.ROOT}/vendor/coverage/coverage_gate.py',
        'b4f6d639c3f9b12f73938d5993ce0897fe56dcbec1ada3123c4ad80d0ff3854b')
SEQ_WINDOW = AO.SEQ_WINDOW
PLAN_FORMAT = 'enclave-base-l1-coverage-segment-plan/v1'
SEG_FORMAT = 'enclave-base-l1-coverage-segment/v1'
SEG_GATE_FORMAT = 'enclave-base-l1-coverage-segment-gate/v1'
AGG_FORMAT = 'enclave-base-l1-coverage-aggregate/v1'
RULE = 'anchor-origin-minus-seq-window'
MAX_EVIDENCE_AGE = 12 * 3600
HARD_MAX_BLOCKS = 30000                                       # == the pinned gate's HARD_MAX_BLOCKS (asserted when the gate is loaded)
H32 = re.compile(r'0x[0-9a-f]{64}')


class Refused(Exception):
    def __init__(self, code, detail):
        super().__init__(f'{code}: {detail}')
        self.code, self.detail = code, detail


def sha(b):
    return hashlib.sha256(b).hexdigest()


def load_gate(gate=None):
    path, want = gate or GATE
    b = open(path, 'rb').read()
    if sha(b) != want:
        raise Refused('gate-not-pinned', f'{path} is not the pinned coverage_gate.py {want[:12]}')
    m = types.ModuleType('coverage_gate_pinned'); m.__file__ = path
    exec(compile(b, path, 'exec'), m.__dict__)
    if m.HARD_MAX_BLOCKS != HARD_MAX_BLOCKS:
        raise Refused('gate-not-pinned', 'gate per-job cap differs from the reviewed 30000')
    return m, want


def seg_rule(i, k, s):
    return f'{RULE} segment {i + 1}/{k} [{s["from"]},{s["to"]}]'


def _h32(v, what):
    if not (isinstance(v, str) and H32.fullmatch(v)):
        raise Refused('plan-invalid', f'{what} is not a lowercase 32-byte hex')
    return v


def validate_plan(P, hard_max):
    """The plan's own exact-coverage invariants (re-checked by run-segment and aggregate, never trusted from the writer)."""
    try:
        if P.get('format') != PLAN_FORMAT or P.get('rule') != RULE or P.get('seqWindow') != SEQ_WINDOW:
            raise Refused('plan-invalid', 'not an anchored segment plan for this SEQ_WINDOW')
        o, a, segs = P['l1Origin'], P['anchor'], P['segments']
        for v, w in ((o['hash'], 'l1Origin.hash'), (a['headerHash'], 'anchor.headerHash'), (a['outputRoot'], 'anchor.outputRoot'),
                     (a['mixHash'], 'anchor.mixHash'), (a['parentBeaconBlockRoot'], 'anchor.parentBeaconBlockRoot')):
            _h32(v, w)
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in (a['N'], o['number'], P['needFrom'], P['toBlock'], P['blocks'])):
            raise Refused('plan-invalid', 'non-integer block numbers')
        if P['needFrom'] != o['number'] - SEQ_WINDOW or P['needFrom'] < 0 or P['toBlock'] < o['number'] \
                or P['blocks'] != P['toBlock'] - P['needFrom'] + 1:
            raise Refused('plan-invalid', 'needFrom is not l1Origin - SEQ_WINDOW, toBlock is below l1Origin, or blocks != range size')
        if not segs or [s['index'] for s in segs] != list(range(len(segs))):
            raise Refused('plan-invalid', 'segment indexes are not 0..k-1')
        nxt = P['needFrom']
        for s in segs:
            if s['from'] != nxt:
                raise Refused('plan-invalid', f'segment {s["index"]} starts at {s["from"]}, expected {nxt} (gap or overlap)')
            if not (1 <= s['to'] - s['from'] + 1 <= hard_max):
                raise Refused('plan-invalid', f'segment {s["index"]} length outside 1..{hard_max}')
            nxt = s['to'] + 1
        if nxt != P['toBlock'] + 1:
            raise Refused('plan-invalid', 'segments do not end exactly at toBlock')
        if not (segs[0]['from'] <= o['number'] <= segs[0]['to']):
            raise Refused('plan-invalid', 'the first segment must hold l1Origin (the gate refuses an origin above its range end)')
    except (KeyError, TypeError) as e:
        raise Refused('plan-invalid', f'malformed plan: {e!r}')
    return P


def verify_anchored(anchored_path, receipt, node, pins=None):
    """Re-verify an anchored-origin document WITHOUT the DB: the recorded Isthmus header must bind again (pinned
    authenticateAnchor) to the pinned A1 receipt's N and outputRoot, and the recorded hash/mixHash/parentBeaconBlockRoot must
    be that header's. Returns (bytes, doc, rebound). The decoded l1Origin/batcher stay unauthenticated hints."""
    pins = pins or AO.PINS
    ab = open(anchored_path, 'rb').read()
    try:
        doc = json.loads(ab)
    except ValueError:
        raise Refused('anchored-format', 'anchored origin is not JSON')
    if doc.get('format') != AO.FORMAT or doc.get('rule') != RULE or (doc.get('binding') or {}).get('ok') is not True:
        raise Refused('anchored-format', 'not an anchor-bound enclave-base-anchored-origin/v1 document')
    try:
        _, rb = AO.pinned_bytes('receipt', {**pins, 'receipt': (receipt, pins['receipt'][1])})
    except AO.Refused as e:
        raise Refused('receipt-not-pinned', str(e))
    try:
        return _verify_anchored(ab, doc, rb, node, pins)
    except (KeyError, TypeError, ValueError, AttributeError) as e:
        raise Refused('anchored-format', f'anchored origin malformed: {e!r}')


def _verify_anchored(ab, doc, rb, node, pins):
    rec = json.loads(rb)
    n, root = int(rec['N']), str(rec['outputRoot']).lower()
    hdr, anchor = doc['header'], doc['anchor']
    if anchor.get('N') != n or anchor.get('outputRoot') != root or anchor.get('receiptSha256') != pins['receipt'][1]:
        raise Refused('anchor-mismatch', 'anchored document is not for the pinned A1 receipt')
    try:                                                      # the binding again, from the recorded header only (no DB)
        b = AO.bind(node, pins, hdr['raw'], root, n)
    except AO.Refused as e:
        raise Refused('anchor-binding', str(e))
    raw = hdr['raw']
    mix, pbr = str(raw.get('mixHash', '')).lower(), str(raw.get('parentBeaconBlockRoot', '')).lower()
    if b['blockHash'] != hdr.get('hash') or mix != hdr.get('mixHash') or pbr != hdr.get('parentBeaconBlockRoot') \
            or hdr.get('number') != n or not H32.fullmatch(mix) or not H32.fullmatch(pbr):
        raise Refused('anchor-binding', 'recorded header fields differ from the re-bound header')
    return ab, doc, {'N': n, 'outputRoot': root, 'receiptSha256': pins['receipt'][1], 'headerHash': b['blockHash'], 'mixHash': mix,
                     'parentBeaconBlockRoot': pbr, 'game': anchor.get('game')}


def plan_matches_anchored(P, ab):
    """Pure agreement of a plan with the anchored-origin bytes it names (used by aggregate and the acceptance overlay)."""
    doc = json.loads(ab)
    h, o = doc.get('header') or {}, doc.get('l1Origin') or {}
    a = P['anchor']
    if P.get('anchoredOriginSha256') != sha(ab) or (a['N'], a['outputRoot'], a['headerHash'], a['mixHash'], a['parentBeaconBlockRoot']) \
            != ((doc.get('anchor') or {}).get('N'), (doc.get('anchor') or {}).get('outputRoot'), h.get('hash'), h.get('mixHash'),
                h.get('parentBeaconBlockRoot')) or (P['l1Origin']['number'], P['l1Origin']['hash']) != (o.get('number'), o.get('hash')) \
            or P['needFrom'] != doc.get('needFrom'):
        raise Refused('plan-anchored-mismatch', 'plan does not carry the anchor/header/origin of the anchored-origin document it names')


def make_plan(anchored_path, receipt, node, to_block, segment_blocks, now=None, pins=None, gate=None):
    cg, gate_sha = load_gate(gate)
    ab, doc, A = verify_anchored(anchored_path, receipt, node, pins)
    o = doc['l1Origin']
    if not isinstance(o.get('number'), int) or not H32.fullmatch(str(o.get('hash'))) or doc.get('needFrom') != o['number'] - SEQ_WINDOW:
        raise Refused('anchored-format', 'needFrom is not l1Origin - SEQ_WINDOW')
    if not (SEQ_WINDOW < segment_blocks <= HARD_MAX_BLOCKS):
        raise Refused('segment-size', f'--segment-blocks must be in ({SEQ_WINDOW}, {HARD_MAX_BLOCKS}] (the reviewed per-job cap is not raised)')
    need_from = doc['needFrom']
    if to_block < o['number']:
        raise Refused('to-block-below-origin', f'--to-block {to_block} is below l1Origin {o["number"]}')
    total = to_block - need_from + 1
    k = math.ceil(total / segment_blocks)
    base, extra = divmod(total, k)                            # balanced: lengths differ by at most one
    segs, at = [], need_from
    for i in range(k):
        ln = base + (1 if i < extra else 0)
        segs.append({'index': i, 'from': at, 'to': at + ln - 1})
        at += ln
    P = {'format': PLAN_FORMAT, 'rule': RULE, 'seqWindow': SEQ_WINDOW, 'chain': 'base-mainnet', 'l1Chain': 'ethereum-mainnet',
         'anchor': A,
         'l1Origin': {'number': o['number'], 'hash': o['hash'], 'evidence': 'UNAUTHENTICATED DB hint until aggregate binds it to the anchor header'},
         'batcherHintUnauthenticated': str(doc.get('batcher', '')).lower(), 'needFrom': need_from, 'toBlock': to_block, 'blocks': total,
         'segmentBlocks': segment_blocks, 'segments': segs, 'gateSha256': gate_sha, 'gateHardMaxBlocks': HARD_MAX_BLOCKS,
         'anchoredOriginSha256': sha(ab), 'createdAt': time.time() if now is None else now,
         'note': 'toBlock is the caller-chosen L1 range end; each segment run requires it to be at or below L1 finalized at that time'}
    return validate_plan(P, HARD_MAX_BLOCKS)


def _load_plan(plan_path, hard_max):
    pb = open(plan_path, 'rb').read()
    try:
        P = json.loads(pb)
    except ValueError:
        raise Refused('plan-invalid', 'plan is not JSON')
    return pb, validate_plan(P, hard_max)


def run_segment(plan_path, index, out_dir, el, beacon, kzg, kzg_sha256, bounds=(), gate=None, blob_scope='batcher'):
    if blob_scope not in ('batcher', 'all'):
        raise Refused('blob-scope', 'blob scope must be batcher (every BATCH_INBOX blob, any sender) or all')
    cg, gate_sha = load_gate(gate)
    pb, P = _load_plan(plan_path, HARD_MAX_BLOCKS)
    if P['gateSha256'] != gate_sha:
        raise Refused('gate-not-pinned', 'plan was made for a different gate')
    k = len(P['segments'])
    if not (0 <= index < k):
        raise Refused('segment-not-in-plan', f'index {index} not in 0..{k - 1}')
    seg = P['segments'][index]
    ln, origin_n = seg['to'] - seg['from'] + 1, P['l1Origin']['number']
    os.mkdir(out_dir)                                         # refuses an existing directory: evidence is never overwritten
    # batcher None: the DB-decoded batcher is unauthenticated and must not reach the gate (whose 'batcher' scope selects every
    # blob tx sent to BATCH_INBOX regardless of sender, coverage_gate.py:364-366; the label's batcher is only echoed there).
    label = {'number': P['anchor']['N'], 'hash': P['anchor']['headerHash'], 'batcher': None,
             'l1Origin': {'number': origin_n, 'hash': P['l1Origin']['hash']}}
    overlay = {'format': 'enclave-base-anchored-origin-gate-overlay/v1',
               'note': 'private gate input: labels.safe is only the gate slot whose l1Origin is re-checked canonical; range comes from the plan',
               'labels': {'tip': None, 'safe': label, 'finalized': None}}
    overlay_path, gate_out = os.path.join(out_dir, 'gate-input.json'), os.path.join(out_dir, 'gate-report.json')
    with open(overlay_path, 'x') as f:
        json.dump(overlay, f, indent=1, sort_keys=True)
    rule = seg_rule(index, k, seg)
    cg.required_range = lambda origin, accept_tip_rule: (seg['from'], rule, label)
    cg.FORMAT = SEG_GATE_FORMAT
    rec = {'el': {}, 'cl': {}, 'slots': {}}
    watch = {seg['from'], seg['to'], origin_n}

    class Recording(cg.Client):
        def must(self, method, params):
            res = super().must(method, params)
            try:
                if method == 'eth_getBlockByNumber' and len(params) == 2 and params[1] is True and isinstance(res, dict) \
                        and int(params[0], 16) in watch:
                    n = int(params[0], 16)
                    rec['el'][n] = {key: res.get(key) for key in ('hash', 'parentHash', 'timestamp', 'mixHash', 'parentBeaconBlockRoot')}
                    rec['slots'][(int(res['timestamp'], 16) - cg.GENESIS_TIME) // cg.SECONDS_PER_SLOT] = n
            except (TypeError, ValueError, KeyError):
                pass                                          # malformed values are the gate's to refuse; nothing is recorded
            return res

        def bn(self, path):
            st, doc = super().bn(path)
            m = re.fullmatch(r'/eth/v1/beacon/(headers|blinded_blocks)/(\d+)', path)
            if m and st == 200 and int(m[2]) in rec['slots'] and isinstance(doc, dict):
                d = rec['cl'].setdefault(int(m[2]), {})
                data = doc.get('data') if isinstance(doc.get('data'), dict) else {}
                if m[1] == 'headers':
                    d['root'] = data.get('root')
                else:
                    msg = data.get('message') if isinstance(data.get('message'), dict) else {}
                    d['parentRoot'] = msg.get('parent_root')
                    d['blockHash'] = ((msg.get('body') or {}).get('execution_payload_header') or {}).get('block_hash')
            return st, doc

    cg.Client = Recording
    started = time.time()
    rc = cg.main(['--origin', overlay_path, '--el', el, '--beacon', beacon, '--kzg', kzg, '--kzg-sha256', kzg_sha256,
                  '--out', gate_out, '--to-block', str(seg['to']), '--max-blocks', str(ln), '--blob-scope', blob_scope, *bounds])
    finished = time.time()
    gb = open(gate_out, 'rb').read()
    G = json.loads(gb)

    def end(n):
        e = rec['el'].get(n) or {}
        slot = next((s for s, m in rec['slots'].items() if m == n), None)
        c = rec['cl'].get(slot) or {}
        return {'number': n, 'hash': e.get('hash'), 'parentHash': e.get('parentHash'), 'slot': slot,
                'beaconRoot': c.get('root'), 'beaconParentRoot': c.get('parentRoot'), 'beaconBlockHash': c.get('blockHash')}

    o = end(origin_n) if seg['from'] <= origin_n <= seg['to'] else None
    if o is not None:
        e = rec['el'].get(origin_n) or {}
        o.update(mixHash=e.get('mixHash'), parentBeaconBlockRoot=e.get('parentBeaconBlockRoot'))
    S = {'format': SEG_FORMAT, 'planSha256': sha(pb), 'index': index, 'of': k, 'from': seg['from'], 'to': seg['to'], 'rule': rule,
         'gateRc': rc, 'gateVerdict': G.get('verdict'), 'gateRefusal': G.get('refusal'), 'gateReportSha256': sha(gb),
         'gateSha256': gate_sha, 'kzgSha256': kzg_sha256, 'endpoints': {'el': el, 'beacon': beacon},
         'startedAt': started, 'finishedAt': finished, 'boundary': {'first': end(seg['from']), 'last': end(seg['to'])},
         'blobScope': blob_scope, 'originBlock': o,
         'coverageVerifiedWritten': False}
    with open(os.path.join(out_dir, 'segment.json'), 'x') as f:
        json.dump(S, f, indent=1, sort_keys=True)
    return S


def aggregate(plan_path, anchored_path, seg_dirs, now=None, max_age=MAX_EVIDENCE_AGE, gate_sha=GATE[1]):
    """Pure re-verification of recorded evidence (no gate import, no network, no node): reusable by the acceptance overlay.
    The CLI additionally re-binds the anchored header (verify_anchored) before calling this."""
    now = time.time() if now is None else now
    if not (0 < max_age <= MAX_EVIDENCE_AGE):
        raise Refused('stale-segment', f'max evidence age must be in (0, {MAX_EVIDENCE_AGE}]')
    pb, P = _load_plan(plan_path, HARD_MAX_BLOCKS)
    ab = open(anchored_path, 'rb').read()
    try:
        plan_matches_anchored(P, ab)
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise Refused('plan-anchored-mismatch', f'anchored origin unreadable: {e!r}')
    segs, k = P['segments'], len(P['segments'])
    got, common = {}, None
    for d in seg_dirs:
        try:
            S = json.load(open(os.path.join(d, 'segment.json')))
            gb = open(os.path.join(d, 'gate-report.json'), 'rb').read()
            G = json.loads(gb)
        except (OSError, ValueError) as e:
            raise Refused('segment-unreadable', f'{d}: {e}')
        if S.get('format') != SEG_FORMAT or S.get('planSha256') != sha(pb):
            raise Refused('segment-from-other-plan', f'{d}: not a segment of this plan')
        i = S.get('index')
        if not isinstance(i, int) or not (0 <= i < k):
            raise Refused('segment-not-in-plan', f'{d}: index {i!r}')
        if i in got:
            raise Refused('duplicate-segment', f'index {i} supplied twice ({got[i]["dir"]}, {d})')
        if sha(gb) != S.get('gateReportSha256'):
            raise Refused('gate-report-tampered', f'{d}: gate-report.json differs from the recorded sha256')
        s, ln = segs[i], segs[i]['to'] - segs[i]['from'] + 1
        if S.get('gateRc') != 0 or G.get('verdict') != 'COVERED' or 'refusal' in G or S.get('gateVerdict') != 'COVERED':
            raise Refused('segment-not-covered', f'segment {i}: gate rc {S.get("gateRc")} verdict {G.get("verdict")} {G.get("refusal")}')
        c = G.get('counts') or {}
        if (G.get('format') != SEG_GATE_FORMAT or G.get('rule') != seg_rule(i, k, s) or S.get('rule') != seg_rule(i, k, s)
                or (S.get('from'), S.get('to')) != (s['from'], s['to']) or (G.get('needFromBlock'), G.get('toBlock')) != (s['from'], s['to'])):
            raise Refused('segment-range-mismatch', f'segment {i}: gate range/rule is not the planned [{s["from"]},{s["to"]}]')
        if c.get('blocks') != ln or c.get('missingData') != 0 or c.get('mismatches') != 0 or G.get('coverageVerifiedWritten') is not False:
            raise Refused('partial-segment', f'segment {i}: {c.get("blocks")}/{ln} blocks, missing {c.get("missingData")}, mismatches {c.get("mismatches")}')
        if not isinstance((G.get('l1') or {}).get('finalized'), int) or G['l1']['finalized'] < s['to']:
            raise Refused('segment-range-mismatch', f'segment {i}: range end above the L1 finalized it recorded')
        if S.get('gateSha256') != gate_sha or P['gateSha256'] != gate_sha:
            raise Refused('gate-not-pinned', f'segment {i}: run by a different gate')
        if G.get('batcher') is not None or G.get('blobScope') != S.get('blobScope') or S.get('blobScope') not in ('batcher', 'all'):
            raise Refused('blob-scope', f'segment {i}: a batcher reached the gate or the blob scope is not recorded')
        mine = (json.dumps(S.get('endpoints'), sort_keys=True), S.get('kzgSha256'), S.get('blobScope'))
        if common is None:
            common = mine
        elif mine != common:
            raise Refused('endpoint-mismatch', f'segment {i}: L1 endpoints, kzgcheck pin or blob scope differ from the other segments')
        if not (isinstance(S.get('startedAt'), (int, float)) and isinstance(S.get('finishedAt'), (int, float))
                and P['createdAt'] <= S['startedAt'] <= S['finishedAt'] <= now + 60 and now - S['finishedAt'] <= max_age):
            raise Refused('stale-segment', f'segment {i}: evidence outside [plan creation, now - {max_age}s]')
        b = S.get('boundary') or {}
        for side, n in (('first', s['from']), ('last', s['to'])):
            e = b.get(side) or {}
            if e.get('number') != n or not all(isinstance(e.get(x), str) and H32.fullmatch(e[x]) for x in
                                               ('hash', 'parentHash', 'beaconRoot', 'beaconParentRoot', 'beaconBlockHash')) \
                    or e['beaconBlockHash'] != e['hash'] or not isinstance(e.get('slot'), int):
                raise Refused('boundary-evidence-missing', f'segment {i}: {side} block {n} EL/beacon values not recorded')
        got[i] = {'dir': d, 'S': S, 'G': G}
    missing = sorted(set(range(k)) - got.keys())
    if missing:
        raise Refused('partial-coverage', f'segments {missing} of {k} not supplied')
    boundary_missed = 0
    for i in range(1, k):
        prev, cur = got[i - 1]['S']['boundary']['last'], got[i]['S']['boundary']['first']
        if cur['number'] != prev['number'] + 1:
            raise Refused('gap-or-overlap', f'segment {i} starts at {cur["number"]}, previous ends at {prev["number"]}')
        if cur['parentHash'] != prev['hash']:
            raise Refused('el-discontinuity-at-boundary', f'L1 block {cur["number"]} parentHash does not link to {prev["number"]}')
        if cur['beaconParentRoot'] != prev['beaconRoot'] or cur['slot'] <= prev['slot']:
            raise Refused('cl-discontinuity-at-boundary', f'slot {cur["slot"]} parent_root does not link to slot {prev["slot"]}')
        boundary_missed += cur['slot'] - prev['slot'] - 1      # empty slots proved by the parent_root link, as the gate classifies them
    o_n = P['l1Origin']['number']
    holder = next(i for i in range(k) if segs[i]['from'] <= o_n <= segs[i]['to'])
    ob = got[holder]['S'].get('originBlock') or {}
    pbr = P['anchor']['parentBeaconBlockRoot']
    # The authenticated header N carries its L1 origin's parent_beacon_block_root and mix_hash (stateful.rs:251/257/259 ->
    # proof/executor/src/builder/assemble.rs:107/112). The canonical beacon chain has exactly one block whose parent_root is
    # pbr, so the canonical L1 block at the hinted number is N's origin only if its beacon block (canonical, committing to
    # this EL hash, both checked by the gate) has parent_root == pbr; the EL header field and mixHash must agree too.
    if (ob.get('number'), ob.get('hash'), ob.get('beaconBlockHash')) != (o_n, P['l1Origin']['hash'], P['l1Origin']['hash']) \
            or ob.get('beaconParentRoot') != pbr or ob.get('parentBeaconBlockRoot') != pbr or ob.get('mixHash') != P['anchor']['mixHash']:
        raise Refused('origin-not-bound-to-anchor-header',
                      f'L1 block {o_n} verified in segment {holder} is not the unique canonical child of the anchor header\'s '
                      'parentBeaconBlockRoot, or its mixHash differs')
    keys = ('blocks', 'transactions', 'receipts', 'blobTxs', 'blobsVerified', 'missedSlots', 'missingData', 'mismatches')
    counts = {x: sum(got[i]['G']['counts'][x] for i in range(k)) for x in keys}
    if counts['blocks'] != P['toBlock'] - P['needFrom'] + 1 or counts['blocks'] != P['blocks']:
        raise Refused('partial-coverage', f'{counts["blocks"]} blocks checked, plan range has {P["blocks"]}')
    blob_slot = (got[0]['G'].get('proposedBaseBootstrap') or {}).get('blobSlot')
    if not isinstance(blob_slot, int) or isinstance(blob_slot, bool):
        raise Refused('partial-segment', 'segment 0 recorded no first batch-inbox blob slot')
    return {'format': AGG_FORMAT, 'verdict': 'COVERED_ALL_SEGMENTS', 'planSha256': sha(pb), 'anchoredOriginSha256': sha(ab), 'anchor': P['anchor'],
            'l1Origin': {'number': o_n, 'hash': P['l1Origin']['hash'], 'segment': holder, 'slot': ob['slot'],
                         'boundToAnchorHeader': 'beacon parent_root == EL parentBeaconBlockRoot == header N parentBeaconBlockRoot; mixHash equal'},
            'l1Block': P['needFrom'], 'blobSlot': blob_slot, 'blobScope': common[2],
            'segmentEvidenceSha256': [sha(open(os.path.join(got[i]['dir'], 'segment.json'), 'rb').read()) for i in range(k)],
            'range': {'needFrom': P['needFrom'], 'toBlock': P['toBlock'], 'blocks': P['blocks'], 'rule': RULE},
            'segments': [{'index': i, 'from': segs[i]['from'], 'to': segs[i]['to'], 'gateReportSha256': got[i]['S']['gateReportSha256'],
                          'l1FinalizedAtRun': got[i]['G']['l1']['finalized'], 'finishedAt': got[i]['S']['finishedAt']} for i in range(k)],
            'counts': counts, 'missedSlotsAtBoundaries': boundary_missed, 'endpoints': json.loads(common[0]), 'kzgSha256': common[1],
            'gateSha256': gate_sha, 'evaluatedAt': now, 'maxEvidenceAge': max_age, 'rootReviewRequired': True,
            'coverageVerifiedWritten': False,
            'authority': 'ORIGIN BINDING + AVAILABILITY only: header N authenticated by the A1 output root; its L1 origin bound by '
                         'the parent-beacon-root/mixHash linkage on our own finalized L1; every block/receipt/beacon block/inbox blob '
                         'in range present and recomputed at run time. NOT consensus authority: L1 canonicality is our own L1 node\'s '
                         'finalized view, and nothing here re-derives or re-executes Base',
            'note': 'eligible only after root review; blobs remain subject to the CL retention window after these times'}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('plan')
    for x in ('anchored', 'receipt', 'node', 'out'):
        p.add_argument('--' + x, required=True)
    p.add_argument('--to-block', type=int, required=True)
    p.add_argument('--segment-blocks', type=int, default=30000)
    r = sub.add_parser('run-segment')
    for x in ('plan', 'out-dir', 'el', 'beacon', 'kzg', 'kzg-sha256'):
        r.add_argument('--' + x, required=True)
    r.add_argument('--index', type=int, required=True)
    r.add_argument('--max-requests', type=int)
    r.add_argument('--blob-scope', choices=('batcher', 'all'), default='batcher')
    for x, t in (('rps', float), ('timeout', float), ('max-body', int), ('max-head-age', int), ('max-final-age', int),
                 ('min-custody-groups', int)):
        r.add_argument('--' + x, type=t)
    g = sub.add_parser('aggregate')
    for x in ('plan', 'anchored', 'receipt', 'node'):
        g.add_argument('--' + x, required=True)
    g.add_argument('--segment', action='append', required=True)
    g.add_argument('--out', required=True)
    g.add_argument('--max-evidence-age', type=int, default=MAX_EVIDENCE_AGE)
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'plan':
            if os.path.exists(a.out):
                ap.error('--out exists; refusing to overwrite evidence')
            P = make_plan(a.anchored, a.receipt, a.node, a.to_block, a.segment_blocks)
            with open(a.out, 'x') as f:
                json.dump(P, f, indent=1, sort_keys=True)
            print(json.dumps({'ok': True, 'needFrom': P['needFrom'], 'toBlock': P['toBlock'],
                              'segments': [[s['from'], s['to']] for s in P['segments']], 'out': a.out}))
            return 0
        if a.cmd == 'run-segment':
            if os.path.exists(a.out_dir):
                ap.error('--out-dir exists; refusing to overwrite evidence')
            pb = open(a.plan, 'rb').read()
            ln = next((s['to'] - s['from'] + 1 for s in json.loads(pb).get('segments', []) if s.get('index') == a.index), 1)
            bounds = ['--max-requests', str(a.max_requests or 6 * ln + 200)]
            for x in ('rps', 'timeout', 'max_body', 'max_head_age', 'max_final_age', 'min_custody_groups'):
                if getattr(a, x) is not None:
                    bounds += ['--' + x.replace('_', '-'), str(getattr(a, x))]
            S = run_segment(a.plan, a.index, a.out_dir, a.el, a.beacon, a.kzg, a.kzg_sha256, bounds, blob_scope=a.blob_scope)
            print(json.dumps({'index': S['index'], 'from': S['from'], 'to': S['to'], 'gateVerdict': S['gateVerdict'],
                              'gateRefusal': S['gateRefusal'], 'out': a.out_dir}))
            return 0 if S['gateRc'] == 0 else 3
        if os.path.exists(a.out):
            ap.error('--out exists; refusing to overwrite evidence')
        try:
            verify_anchored(a.anchored, a.receipt, a.node)    # the header binding again, then the pure evidence check
            doc, rc = aggregate(a.plan, a.anchored, a.segment, max_age=a.max_evidence_age), 0
        except Refused as e:
            doc, rc = {'format': AGG_FORMAT, 'verdict': 'REFUSED', 'refusal': {'code': e.code, 'detail': e.detail},
                       'coverageVerifiedWritten': False}, 3
        with open(a.out, 'x') as f:
            json.dump(doc, f, indent=1, sort_keys=True)
        print(json.dumps({'verdict': doc['verdict'], 'refusal': doc.get('refusal'), 'out': a.out}))
        return rc
    except Refused as e:
        print(json.dumps({'refused': {'code': e.code, 'detail': e.detail}}))
        return 3


if __name__ == '__main__':
    sys.exit(main())
