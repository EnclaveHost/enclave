"""anchored_acceptance.py (historical-origin-segments-stage/r3): verification of the N-anchored, segmented coverage evidence.

ONE core, `verify_anchored_evidence`, used by BOTH consumers so they accept exactly the same evidence:
  - the wrapper (chain_service.base_coverage, baseBootstrap.mode == 'anchored-segments') through `anchored_coverage_activation`, which adds
    the install bindings only the wrapper can see (bootstrap manifest, chain config identity, snapshot manifest content);
  - readiness_sampler (--coverage-anchored-dir) through `verify_anchored_evidence` with the root-pinned expectations from its settings.

Evidence directory (root-owned, not group/other writable, no symlinks; every file read O_NOFOLLOW, bounded, JSON object):
  receipt.json aggregate.json plan.json anchored-origin.json a1-receipt.json snapshot-manifest.json
  segments/<name>/{segment.json, gate-report.json, gate-input.json}            (exactly these three files per segment)

Every qualification is re-derived, never read from the aggregate: segments.aggregate() is re-run over the segment evidence at the
CURRENT verification time (r4; root review 1259: a historic review never extends the availability window, so every segment must still
be within maxEvidenceAge NOW), and, with only evaluatedAt normalized, must reproduce aggregate.json exactly (per-segment COVERED, exact range, no gap/overlap/duplicate, EL+CL
boundary links, uniform endpoints/KZG/blob scope, the 30000 cap, segment freshness, and the origin binding: the canonical L1 block whose
beacon parent_root == EL parentBeaconBlockRoot == header N's, with equal mixHash). Plan and anchored origin must agree on N / outputRoot /
header hash / mixHash / parentBeaconBlockRoot / L1 origin; the A1 receipt must be the source-pinned b9a90847 bytes. The evidence is
ORIGIN BINDING + AVAILABILITY, not consensus authority."""
import json, math, os, stat, time

import anchored_origin as AO
import segments as SG

RECEIPT_FORMAT = 'enclave-base-anchored-coverage-acceptance/v1'
MODE = 'anchored-segments'
A1_SHA256 = AO.PINS['receipt'][1]
MAX_EVIDENCE = 16 << 20
FILES = {'receiptSha256': 'receipt.json', 'aggregateSha256': 'aggregate.json', 'planSha256': 'plan.json',
         'anchoredOriginSha256': 'anchored-origin.json', 'a1ReceiptSha256': 'a1-receipt.json', 'snapshotManifestSha256': 'snapshot-manifest.json'}
SEGMENT_FILES = ('gate-input.json', 'gate-report.json', 'segment.json')


class Rejected(Exception):
    def __init__(self, code, detail):
        super().__init__(f'{code}: {detail}')
        self.code, self.detail = code, detail


def read_evidence(path, owner):
    """(sha256, JSON object) of an owner-owned, non-group/other-writable regular file (no symlink), within MAX_EVIDENCE."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise Rejected('evidence-unreadable', f'{os.path.basename(path)}: {type(e).__name__}')
    try:
        st = os.fstat(fd)
        if not (stat.S_ISREG(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022 and st.st_size <= MAX_EVIDENCE):
            raise Rejected('evidence-not-protected', f'{os.path.basename(path)} is not an operator-owned, non-writable regular file within bounds')
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
    if len(raw) > MAX_EVIDENCE:
        raise Rejected('evidence-not-protected', f'{os.path.basename(path)} too large')
    try:
        doc = json.loads(raw)
    except ValueError:
        raise Rejected('evidence-malformed', f'{os.path.basename(path)} is not JSON')
    if not isinstance(doc, dict):
        raise Rejected('evidence-malformed', f'{os.path.basename(path)} is not a JSON object')
    return SG.sha(raw), doc, raw


def _controlled_dir(path, owner, what):
    try:
        st = os.lstat(path)
    except OSError as e:
        raise Rejected('evidence-unreadable', f'{what}: {type(e).__name__}')
    if not (stat.S_ISDIR(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022):
        raise Rejected('evidence-not-protected', f'{what} directory not operator-controlled')


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def verify_anchored_evidence(directory, owner, receipt_sha256, kzgcheck_sha256, base_binary_sha256, seq_window,
                             a1_sha256=A1_SHA256, now=None):
    """The shared core. Returns the binding; raises Rejected(code, detail). receipt_sha256 is the root pin of receipt.json.
    `now` is the verification time: None (production, both consumers) = time.time() at this call; an explicit value only for tests.
    The receipt's/aggregate's own clocks are never the authority for freshness."""
    now = time.time() if now is None else now
    directory = str(directory)
    _controlled_dir(directory, owner, 'coverage evidence')
    ev = {k: read_evidence(os.path.join(directory, f), owner) for k, f in FILES.items()}
    if ev['receiptSha256'][0] != receipt_sha256:
        raise Rejected('receipt-not-pinned', 'anchored coverage evidence bytes differ from the operator-pinned hashes (receipt.json)')
    rc, agg, plan, anch, a1, snap = (ev[k][1] for k in FILES)
    if rc.get('format') != RECEIPT_FORMAT or rc.get('decision') != 'accepted':
        raise Rejected('receipt-format', 'anchored coverage receipt not an accepted review')
    rv = rc.get('review') if isinstance(rc.get('review'), dict) else {}
    reviewer, runner = rv.get('reviewer'), rv.get('gateRunner')
    if not (isinstance(reviewer, str) and reviewer.strip() and isinstance(runner, str) and runner.strip()
            and reviewer.strip() != runner.strip() and isinstance(rv.get('reviewedAt'), str)):
        raise Rejected('review-not-independent', 'coverage review not independent')
    for k in FILES:
        if k != 'receiptSha256' and rc.get(k) != ev[k][0]:
            raise Rejected('evidence-hash-mismatch', f'anchored coverage receipt does not bind {FILES[k]}')
    if rc.get('kzgcheckSha256') != kzgcheck_sha256 or rc.get('baseBinarySha256') != base_binary_sha256 or rc.get('gateSha256') != SG.GATE[1]:
        raise Rejected('tool-pin-mismatch', 'coverage receipt tool pins differ')
    # A1: the source-pinned bytes; every document names its N and outputRoot.
    if ev['a1ReceiptSha256'][0] != a1_sha256 or a1.get('verdict') != 'A1-authenticated' or not str(a1.get('N', '')).isdigit():
        raise Rejected('foreign-a1', 'A1 receipt is not the source-pinned one')
    n, root = int(a1['N']), str(a1.get('outputRoot', '')).lower()
    src = anch.get('source') if isinstance(anch.get('source'), dict) else {}
    A, H, O = anch.get('anchor') or {}, anch.get('header') or {}, anch.get('l1Origin') or {}
    if anch.get('format') != AO.FORMAT or anch.get('rule') != SG.RULE or (anch.get('binding') or {}).get('ok') is not True \
            or src.get('datadirReadOnlyMount') is not True or src.get('binarySha256') != base_binary_sha256:
        raise Rejected('anchored-origin-provenance', 'anchored origin provenance (format, binding, read-only extraction by this base binary)')
    if (A.get('N'), A.get('outputRoot'), A.get('receiptSha256'), H.get('number')) != (n, root, a1_sha256, n):
        raise Rejected('anchored-origin-mismatch', 'anchored origin is not for the A1 anchor')
    try:
        SG.plan_matches_anchored(plan, ev['anchoredOriginSha256'][2])
        SG.validate_plan(plan, SG.HARD_MAX_BLOCKS)
    except (SG.Refused, KeyError, TypeError, ValueError, AttributeError) as e:
        raise Rejected('plan-anchored-mismatch', f'plan does not bind this anchored origin: {e}')
    PA, PO = plan['anchor'], plan['l1Origin']
    if plan.get('gateSha256') != SG.GATE[1] or PA.get('receiptSha256') != a1_sha256:
        raise Rejected('plan-anchored-mismatch', 'plan pins differ (gate or A1 receipt)')       # SEQ_WINDOW: range-rule below
    # Segments: root-owned directories holding exactly the three evidence files each, then the full re-aggregation.
    seg_root = os.path.join(directory, 'segments')
    _controlled_dir(seg_root, owner, 'segment evidence')
    dirs = []
    for name in sorted(os.listdir(seg_root)):
        p = os.path.join(seg_root, name)
        _controlled_dir(p, owner, f'segment {name}')
        if sorted(os.listdir(p)) != list(SEGMENT_FILES):
            raise Rejected('segment-evidence', f'segment {name} holds unexpected files')
        for f in SEGMENT_FILES:
            read_evidence(os.path.join(p, f), owner)
        dirs.append(p)
    if agg.get('format') != SG.AGG_FORMAT or agg.get('verdict') != 'COVERED_ALL_SEGMENTS' or agg.get('coverageVerifiedWritten') is not False \
            or not _int(agg.get('maxEvidenceAge')):
        raise Rejected('aggregate-not-covered', 'aggregate is not COVERED_ALL_SEGMENTS')
    evaluated_at = agg.get('evaluatedAt')
    if not (isinstance(evaluated_at, (int, float)) and not isinstance(evaluated_at, bool) and math.isfinite(evaluated_at)
            and evaluated_at <= now + 60):
        raise Rejected('aggregate-evaluation-invalid', 'aggregate evaluatedAt is not a finite, non-boolean time at or before now (+60 s)')
    try:      # every segment's age window is checked at the CURRENT time, not at the saved evaluation time
        again = SG.aggregate(os.path.join(directory, 'plan.json'), os.path.join(directory, 'anchored-origin.json'), dirs,
                             now=now, max_age=agg['maxEvidenceAge'])
        again['evaluatedAt'] = evaluated_at          # the ONLY normalized field for the exact historic-content comparison
    except SG.Refused as e:
        raise Rejected(f'segments-{e.code}', f'segment evidence does not re-aggregate: {e.code}: {e.detail}')
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise Rejected('segment-evidence', f'segment evidence unreadable: {e!r}')
    if json.loads(json.dumps(again)) != agg:
        raise Rejected('aggregate-mismatch', 'aggregate.json differs from the re-aggregated segment evidence')
    if agg['planSha256'] != ev['planSha256'][0] or agg['anchoredOriginSha256'] != ev['anchoredOriginSha256'][0] or agg['kzgSha256'] != kzgcheck_sha256:
        raise Rejected('aggregate-mismatch', 'aggregate pins differ')
    need, slot = agg['l1Block'], agg['blobSlot']
    if not (need == plan['needFrom'] == agg['range']['needFrom'] == PO['number'] - seq_window):
        raise Rejected('range-rule', f'anchored range is not l1Origin(N) - {seq_window}')
    rb = rc.get('baseBootstrap') if isinstance(rc.get('baseBootstrap'), dict) else {}
    if not (rb.get('l1Block') == need and rb.get('blobSlot') == slot and _int(rb.get('l1Block')) and _int(rb.get('blobSlot'))):
        raise Rejected('coverage-binding-mismatch', 'coverage receipt/aggregate bindings disagree')
    return {'mode': MODE, 'l1Block': need, 'blobSlot': slot, 'toBlock': agg['range']['toBlock'],
            'anchor': {'N': n, 'outputRoot': root, 'headerHash': PA['headerHash']},
            'l1Origin': {'number': PO['number'], 'hash': PO['hash']},
            'qualification': agg['authority'], 'evidence': {k: ev[k][0] for k in FILES},
            'receipt': rc, 'snapshotManifest': snap,
            'review': {'reviewer': reviewer, 'gateRunner': runner}}


def anchored_coverage_activation(cs, cfg, manifest_path, base_binary_sha256, directory, owner=0, a1_sha256=A1_SHA256, now=None):
    """The wrapper consumer (cs = the running chain_service module). AssertionError on any refusal, as coverage_activation."""
    try:
        bb = cfg.get('baseBootstrap')
        assert isinstance(bb, dict) and bb.get('coverageVerified') is True and bb.get('mode') == MODE, 'anchored coverage not approved'
        assert 'coverageAcceptance' not in bb, 'anchored mode must not also carry the snapshot-safe-head acceptance'
        acc = bb.get('anchoredCoverageAcceptance')
        assert isinstance(acc, dict) and set(acc) == set(FILES) and all(isinstance(acc[k], str) and cs.SHA_RE.fullmatch(acc[k]) for k in FILES), \
            'anchored coverage acceptance hashes missing'
        assert isinstance(base_binary_sha256, str) and cs.SHA_RE.fullmatch(base_binary_sha256), 'installed base binary pin missing'
        b = verify_anchored_evidence(directory, owner, acc['receiptSha256'], cs.KZGCHECK_SHA256, base_binary_sha256, cs.BASE_SEQ_WINDOW,
                                     a1_sha256, now)
        assert b['evidence'] == acc, 'anchored coverage evidence bytes differ from the operator-pinned hashes'
        rc = b['receipt']
        manifest_raw = open(manifest_path, 'rb').read()
        installed = json.loads(manifest_raw)
        assert isinstance(installed, dict) and (installed.get('binaries') or {}).get('base') == base_binary_sha256, \
            'installed bootstrap manifest does not pin this base binary'
        b_sha = SG.sha(manifest_raw)
        assert rc.get('bootstrapManifestSha256') == b_sha and acc['snapshotManifestSha256'] != b_sha, \
            'anchored coverage receipt reviewed a different installed bootstrap manifest'
        snapshot_url = (installed.get('snapshotManifests') or {}).get('base')
        assert rc.get('snapshotManifestUrl') == snapshot_url, 'coverage receipt names a different snapshot manifest URL'
        snapshot = cs.snapshot_manifest_check(b['snapshotManifest'], installed, snapshot_url)
        assert rc.get('chainConfigSha256') == cs.config_identity(cfg), 'coverage receipt reviewed a different chain config'
        assert b['anchor']['N'] <= snapshot['block'], 'snapshot does not hold the anchor block N'
        for k, v in (('l1Block', b['l1Block']), ('blobSlot', b['blobSlot'])):
            assert k not in bb or (bb[k] == v and not isinstance(bb[k], bool)), f'chain config {k} differs from the reviewed binding'
    except Rejected as e:
        raise AssertionError(f'{e.code}: {e.detail}')
    except (OSError, ValueError) as e:
        raise AssertionError(f'anchored coverage evidence unreadable ({type(e).__name__})')
    return {'mode': MODE, 'l1Block': b['l1Block'], 'blobSlot': b['blobSlot'], 'toBlock': b['toBlock'], 'anchor': b['anchor'],
            'l1Origin': b['l1Origin'], 'snapshot': snapshot, 'bootstrapManifestSha256': b_sha,
            'qualification': b['qualification'], 'evidence': b['evidence']}
