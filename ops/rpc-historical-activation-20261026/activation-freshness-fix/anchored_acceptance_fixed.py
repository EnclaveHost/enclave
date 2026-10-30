"""anchored_acceptance.py: activation acceptance for the N-anchored, segmented coverage evidence (NEW; not wired anywhere).

The existing chain_service.coverage_activation (source 75c879ec) accepts only enclave-base-l1-coverage-verdict/v1 under the
safe-label rule with a snapshot-origin/v1 SAFE_HEAD_PERSISTED origin, so it fails closed on every document this stage produces
(tested). This overlay is the anchored counterpart. It is called with the running chain_service module `cs` and reuses that module's own
_evidence (root-owned, non-writable regular files with a size bound), config_identity, snapshot_manifest_check and KZGCHECK_SHA256. Root wires it only for
baseBootstrap.mode == 'anchored-segments':

  cfg.baseBootstrap = {coverageVerified: true, mode: 'anchored-segments', anchoredCoverageAcceptance: {receiptSha256, aggregateSha256,
                       planSha256, anchoredOriginSha256, a1ReceiptSha256, snapshotManifestSha256}}
  directory: receipt.json aggregate.json plan.json anchored-origin.json a1-receipt.json snapshot-manifest.json
             segments/<name>/{segment.json, gate-report.json, gate-input.json}

Every qualification is re-checked, not read from the aggregate: segments.aggregate() is re-run over the root-owned segment evidence at the
aggregate's own evaluatedAt and must reproduce aggregate.json exactly (so per-segment COVERED, exact range, no gap/overlap/duplicate, EL+CL
boundary links, uniform endpoints/KZG/blob scope, the 30000 cap, the origin binding and freshness at aggregation all hold); plan and anchored
origin must agree on the anchor N/outputRoot/header hash/mixHash/parentBeaconBlockRoot/L1 origin; the A1 receipt must be the source-pinned
b9a90847 bytes. The aggregate is ORIGIN BINDING + AVAILABILITY evidence, not consensus authority."""
import json, os, stat, math, time

import anchored_origin as AO
import segments as SG

RECEIPT_FORMAT = 'enclave-base-anchored-coverage-acceptance/v1'
MODE = 'anchored-segments'
FILES = {'receiptSha256': 'receipt.json', 'aggregateSha256': 'aggregate.json', 'planSha256': 'plan.json',
         'anchoredOriginSha256': 'anchored-origin.json', 'a1ReceiptSha256': 'a1-receipt.json', 'snapshotManifestSha256': 'snapshot-manifest.json'}
SEGMENT_FILES = ('segment.json', 'gate-report.json', 'gate-input.json')


def anchored_coverage_activation(cs, cfg, manifest_path, base_binary_sha256, directory, owner=0, a1_sha256=AO.PINS['receipt'][1]):
    bb = cfg.get('baseBootstrap')
    assert isinstance(bb, dict) and bb.get('coverageVerified') is True and bb.get('mode') == MODE, 'anchored coverage not approved'
    assert 'coverageAcceptance' not in bb, 'anchored mode must not also carry the snapshot-safe-head acceptance'
    acc = bb.get('anchoredCoverageAcceptance')
    assert isinstance(acc, dict) and all(isinstance(acc.get(k), str) and cs.SHA_RE.fullmatch(acc[k]) for k in FILES), \
        'anchored coverage acceptance hashes missing'
    assert isinstance(base_binary_sha256, str) and cs.SHA_RE.fullmatch(base_binary_sha256), 'installed base binary pin missing'
    d = os.lstat(directory)
    assert stat.S_ISDIR(d.st_mode) and d.st_uid == owner and not d.st_mode & 0o022, 'coverage evidence directory not operator-controlled'
    ev = {k: cs._evidence(directory / f, owner) for k, f in FILES.items()}
    assert all(ev[k][0] == acc[k] for k in FILES), 'anchored coverage evidence bytes differ from the operator-pinned hashes'
    rc, agg, plan, anch, a1, snap = (ev[k][1] for k in FILES)
    manifest_raw = manifest_path.read_bytes()
    installed = json.loads(manifest_raw)
    assert isinstance(installed, dict) and (installed.get('binaries') or {}).get('base') == base_binary_sha256, \
        'installed bootstrap manifest does not pin this base binary'
    # Receipt: an independent accepted review binding every evidence byte, this install, this config and these tools.
    assert rc.get('format') == RECEIPT_FORMAT and rc.get('decision') == 'accepted', 'anchored coverage receipt not an accepted review'
    rv = rc.get('review') if isinstance(rc.get('review'), dict) else {}
    reviewer, runner = rv.get('reviewer'), rv.get('gateRunner')
    assert isinstance(reviewer, str) and reviewer.strip() and isinstance(runner, str) and runner.strip() \
        and reviewer.strip() != runner.strip() and isinstance(rv.get('reviewedAt'), str), 'coverage review not independent'
    for k in FILES:
        if k != 'receiptSha256':
            assert rc.get(k) == ev[k][0], f'anchored coverage receipt does not bind {FILES[k]}'
    b_sha = cs.hashlib.sha256(manifest_raw).hexdigest()
    assert rc.get('bootstrapManifestSha256') == b_sha and ev['snapshotManifestSha256'][0] != b_sha, \
        'anchored coverage receipt reviewed a different installed bootstrap manifest'
    snapshot_url = (installed.get('snapshotManifests') or {}).get('base')
    assert rc.get('snapshotManifestUrl') == snapshot_url, 'coverage receipt names a different snapshot manifest URL'
    snapshot = cs.snapshot_manifest_check(snap, installed, snapshot_url)
    assert rc.get('chainConfigSha256') == cs.config_identity(cfg), 'coverage receipt reviewed a different chain config'
    assert rc.get('kzgcheckSha256') == cs.KZGCHECK_SHA256 and rc.get('baseBinarySha256') == base_binary_sha256 \
        and rc.get('gateSha256') == SG.GATE[1], 'coverage receipt tool pins differ'
    # A1 receipt: the source-pinned bytes; the anchored origin, plan and aggregate all name its N and outputRoot.
    assert ev['a1ReceiptSha256'][0] == a1_sha256 and a1.get('verdict') == 'A1-authenticated', 'A1 receipt is not the source-pinned one'
    n, root = int(a1['N']), str(a1['outputRoot']).lower()
    src = anch.get('source') if isinstance(anch.get('source'), dict) else {}
    assert anch.get('format') == AO.FORMAT and anch.get('rule') == SG.RULE and (anch.get('binding') or {}).get('ok') is True \
        and src.get('datadirReadOnlyMount') is True and src.get('binarySha256') == base_binary_sha256, 'anchored origin provenance'
    A, H, O = anch.get('anchor') or {}, anch.get('header') or {}, anch.get('l1Origin') or {}
    assert (A.get('N'), A.get('outputRoot'), A.get('receiptSha256')) == (n, root, a1_sha256), 'anchored origin is not for the A1 anchor'
    assert cs._int(n) and n <= snapshot['block'], 'snapshot does not hold the anchor block N'
    PA, PO = plan.get('anchor') or {}, plan.get('l1Origin') or {}
    try:
        ab = (directory / 'anchored-origin.json').read_bytes()
        assert SG.sha(ab) == ev['anchoredOriginSha256'][0], 'anchored origin changed while being validated'
        SG.plan_matches_anchored(plan, ab)
    except (SG.Refused, KeyError, TypeError, ValueError) as e:
        raise AssertionError(f'plan does not bind this anchored origin: {e}')
    assert plan.get('gateSha256') == SG.GATE[1] and PA.get('receiptSha256') == a1_sha256, 'plan pins differ'
    # Aggregate: recomputed from the root-owned segment evidence; must be byte-for-byte the reviewed document's content.
    seg_root = directory / 'segments'
    st = os.lstat(seg_root)
    assert stat.S_ISDIR(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022, 'segment evidence directory not operator-controlled'
    dirs = []
    for name in sorted(os.listdir(seg_root)):
        p = seg_root / name
        s = os.lstat(p)
        assert stat.S_ISDIR(s.st_mode) and s.st_uid == owner and not s.st_mode & 0o022, f'segment {name} not operator-controlled'
        assert sorted(os.listdir(p)) == sorted(SEGMENT_FILES), f'segment {name} holds unexpected files'
        for f in SEGMENT_FILES:
            cs._evidence(p / f, owner)
        dirs.append(str(p))
    assert agg.get('format') == SG.AGG_FORMAT and agg.get('verdict') == 'COVERED_ALL_SEGMENTS' and agg.get('coverageVerifiedWritten') is False \
        and cs._int(agg.get('maxEvidenceAge')) and isinstance(agg.get('evaluatedAt'), (int, float)), 'aggregate is not COVERED_ALL_SEGMENTS'
    # Recheck availability age at activation, not at the saved aggregation time.
    # A valid historic review does not extend the availability window.
    activation_now = time.time()
    evaluated_at = agg['evaluatedAt']
    assert not isinstance(evaluated_at, bool) and math.isfinite(evaluated_at) \
        and evaluated_at <= activation_now + 60, 'aggregate evaluation time is invalid or in the future'
    try:
        again = SG.aggregate(str(directory / 'plan.json'), str(directory / 'anchored-origin.json'), dirs,
                             now=activation_now, max_age=agg['maxEvidenceAge'])
        # The evidence content must still reproduce exactly; only the evaluation
        # timestamp changes when rechecking the same immutable evidence now.
        again['evaluatedAt'] = evaluated_at
    except SG.Refused as e:
        raise AssertionError(f'segment evidence does not re-aggregate: {e.code}: {e.detail}')
    assert json.loads(json.dumps(again)) == agg, 'aggregate.json differs from the re-aggregated segment evidence'
    assert agg['planSha256'] == ev['planSha256'][0] and agg['anchoredOriginSha256'] == ev['anchoredOriginSha256'][0] and agg['kzgSha256'] == cs.KZGCHECK_SHA256, 'aggregate pins differ'
    need, slot = agg['l1Block'], agg['blobSlot']
    assert need == plan['needFrom'] == agg['range']['needFrom'] == PO['number'] - cs.BASE_SEQ_WINDOW, 'anchored range is not l1Origin(N) - 3600'
    rb = rc.get('baseBootstrap') if isinstance(rc.get('baseBootstrap'), dict) else {}
    assert rb.get('l1Block') == need and rb.get('blobSlot') == slot and not isinstance(rb.get('l1Block'), bool) \
        and not isinstance(rb.get('blobSlot'), bool), 'coverage receipt/aggregate bindings disagree'
    for k, v in (('l1Block', need), ('blobSlot', slot)):
        assert k not in bb or (bb[k] == v and not isinstance(bb[k], bool)), f'chain config {k} differs from the reviewed binding'
    return {'mode': MODE, 'l1Block': need, 'blobSlot': slot, 'toBlock': agg['range']['toBlock'],
            'anchor': {'N': n, 'outputRoot': root, 'headerHash': PA['headerHash']},
            'l1Origin': {'number': PO['number'], 'hash': PO['hash']}, 'snapshot': snapshot, 'bootstrapManifestSha256': b_sha,
            'qualification': agg['authority'],
            'evidence': {k: ev[k][0] for k in FILES}}
