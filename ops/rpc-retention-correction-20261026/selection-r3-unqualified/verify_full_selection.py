#!/usr/bin/python3 -I
"""selection-r3: READ-ONLY evidence that the cached retention download's FULL reth selection (30 archives under the pinned manifest
and the 48000000 / 52500000 policy, from cached_download_preflight.py r3) is extracted, for use only AFTER the live retention unit
has exited. It writes nothing anywhere; it prints one JSON record and exits 0 (all selected outputs present), 1 (incomplete),
2 (refused: usage, unit still running, pin mismatch).

Why it exists: the live unit's ExecStartPost (activation-r2 retention_guard.py post) writes /srv/enclave-base-holder/retention-complete
after checking the r2 selection of 26 archives. That marker is unchanged and stays a 26-archive SUBSET record; it does not prove the
4 below-floor archives the CLI also selected. This record reports both and never treats the marker as the full selection.
Checks are path + exact size (as the guard does); reth itself verified BLAKE3 before reuse/extraction; this tool does not hash.
Coverage/readiness: may be claimed from the DECLARED floor only (history 48000000, state history 52500000), never from the lower
first block of a below-floor chunk; downloaded archives are not chain readiness.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_SHA256 = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
HISTORY_FROM, STATE_FROM = 48_000_000, 52_500_000
UNIT = 'enclave-base-retention.service'
MARKER_SCOPE_R2 = 26             # activation-r2 retention_guard SELECTED_TOTAL: what the live marker's "archives" field means


def _pf():
    spec = importlib.util.spec_from_file_location('pf_r3', os.path.join(HERE, 'cached_download_preflight.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def unit_state(run=subprocess.run):
    r = run(['systemctl', 'show', '--property=ActiveState,SubState,Result,MainPID', UNIT], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f'cannot read {UNIT} state')
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def evidence(manifest_path, datadir, root, state):
    pf = _pf()
    with open(manifest_path, 'rb') as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    if sha != MANIFEST_SHA256:
        return 2, {'complete': False, 'refusal': f'snapshot manifest sha256 {sha} is not the pinned {MANIFEST_SHA256}'}
    if state.get('ActiveState') not in ('inactive', 'failed') or state.get('MainPID', '0') != '0':
        return 2, {'complete': False, 'refusal': f'{UNIT} is still running or in an unexpected state: {state}'}
    manifest = json.loads(raw)
    p = pf.plan(manifest, HISTORY_FROM, STATE_FROM)
    rows, absent, partial = [], [], []
    for a in p['archives']:
        bad = [o['path'] for o in a['outputs'] if not os.path.isfile(os.path.join(datadir, o['path']))]
        wrong = [o['path'] for o in a['outputs'] if o['path'] not in bad and os.path.getsize(os.path.join(datadir, o['path'])) != o['size']]
        ok = not bad and not wrong
        rows.append({'component': a['component'], 'chunk': a['chunk'], 'fromBlock': a['fromBlock'], 'toBlock': a['toBlock'],
                     'belowDeclaredFloor': a['belowDeclaredFloor'], 'present': ok})
        if bad and not wrong and len(bad) == len(a['outputs']):
            absent.append(f"{a['component']}:{a['chunk']}")
        elif not ok:
            partial.append({'archive': f"{a['component']}:{a['chunk']}", 'absentOutputs': bad, 'wrongSizeOutputs': wrong})
    cli_all = pf.cli_all_archives(manifest)
    cli_missing = [f"{x['component']}:{x['chunk']}" for x in cli_all if not pf.present(datadir, x['outputs'])]
    marker = os.path.join(root, 'retention-complete')
    mrec = None
    if os.path.isfile(marker) and not os.path.islink(marker):
        try:
            mrec = json.loads(open(marker).read())
        except ValueError:
            mrec = 'unreadable'
    below = [r for r in rows if r['belowDeclaredFloor']]
    complete = all(r['present'] for r in rows) and not cli_missing
    rec = {'format': 'enclave-base-retention-full-selection-evidence/r3', 'manifestSha256': sha, 'unit': state,
           'declaredFloor': {'history': HISTORY_FROM, 'stateHistory': STATE_FROM}, 'readiness': pf.READINESS,
           'selected': len(rows), 'selectedPresent': sum(r['present'] for r in rows),
           'atOrAboveFloor': {'selected': len(rows) - len(below), 'present': sum(r['present'] for r in rows if not r['belowDeclaredFloor'])},
           'belowDeclaredFloor': {'selected': len(below), 'present': sum(r['present'] for r in below),
                                  'archives': [f"{r['component']}:{r['chunk']}" for r in below]},
           'absentArchives': absent, 'partialArchives': partial, 'cliAlsoPlannedMissing': cli_missing,
           'r2Marker': {'path': marker, 'record': mrec, 'scope': f'{MARKER_SCOPE_R2}-archive r2 subset; NOT the full selection'},
           'complete': complete, 'archives': rows}
    return (0 if complete else 1), rec


def main(argv=None, run=subprocess.run):
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default='/opt/enclave-rpc/snapshots/base-1792886410-manifest.json')
    ap.add_argument('--root', default='/srv/enclave-base-holder')
    ap.add_argument('--unit-state-json', help='testing only: the unit state instead of systemctl')
    a = ap.parse_args(argv)
    try:
        state = json.loads(a.unit_state_json) if a.unit_state_json else unit_state(run)
        rc, rec = evidence(a.manifest, os.path.join(a.root, 'data'), a.root, state)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as e:
        rc, rec = 2, {'complete': False, 'refusal': f'input: {e}'}
    print(json.dumps(rec, indent=1, sort_keys=True))
    return rc


if __name__ == '__main__':
    sys.exit(main())
