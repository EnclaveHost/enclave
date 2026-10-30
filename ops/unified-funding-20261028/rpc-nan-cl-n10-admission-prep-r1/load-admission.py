"""Seal ONLY a newly reviewed observation for exact n10. Never launches clients."""
from pathlib import Path
import ast
import hashlib
import json
import os
import sys
import time
from binding import HERE, checked_binding, digest, write_exclusive

def main():
    os.umask(0o077)
    binding, runtime, manifest = checked_binding()
    assert os.sched_getaffinity(0) == {1}
    assert len(sys.argv) == 2, 'provide-new-root-review-json'
    review_path = Path(sys.argv[1])
    assert review_path.resolve() != (HERE/'ROOT-REVIEW-TEMPLATE.json').resolve(), 'unadmitted-template'
    assert review_path.stat().st_size <= 65536
    review = json.loads(review_path.read_text())
    observation_path = HERE/'FRESH-OBSERVATION.json'
    assert observation_path.stat().st_size <= 1048576
    observation = json.loads(observation_path.read_text())
    observation_sha = digest(observation_path)
    assert review['authorized'] is True and review['elTrialTerminalAndClean'] is True, 'root-review-required'
    assert review['scope'] == binding['scope']
    assert review['runtimePinsSha256'] == binding['runtimePinsSha256']
    assert review['observationSha256'] == observation_sha, 'review-observation-mismatch'
    assert isinstance(review['rootReview'], str) and 20 <= len(review['rootReview']) <= 8192
    assert review['scheduleAndTimersReviewedThroughAt'] >= observation['at']+2500, 'outer-horizon-not-reviewed'
    assert observation['readOnly'] is True and not observation['errors'] and observation['boot'] == binding['bootId']
    assert type(review['observedPendingMiB']) is int and review['observedPendingMiB'] >= 0
    for name in ('jobs', 'atQueue'):
        row = observation[name]
        assert row['rc'] == 0 and not row['reason'] and not row['truncated'] and not row['stdout'].strip(), 'pending-work'
    for key in ('ordinaryOsExecutables', 'existingOtherProcesses'):
        assert isinstance(review[key], list) and all(isinstance(v, str) for v in review[key])
    creator = next(p for p in observation['processes'] if p['pid'] == 1281392)
    assert creator['start'] == '867080689' and creator['exe'] == '/usr/bin/bash'
    assert creator['cmdlineSha256'] == review['creatorCmdlineSha256'] == '8a016019ad176a0fcc7113d7117b64a69fdde83a4f54ffc33dc2017f147ea65f'
    creator_id = f"{creator['pid']}:{creator['start']}:{creator['exe']}"
    assert creator_id in review['existingOtherProcesses'], 'creator-not-classified'
    # The root review classifies all observed work and timer/cron activity. This
    # is operational admission, not a universal reservation against new work.
    memory = observation['memory']
    assert memory['rc'] == 0 and not memory['reason'] and not memory['truncated']
    available = next(int(line.split()[1])*1024 for line in memory['stdout'].splitlines() if line.startswith('MemAvailable:'))
    residual = available-((4096+128+128+review['observedPendingMiB'])<<20)
    assert residual >= 2048<<20, 'Nan-residual-reserve'
    a = dict(manifest['admission'])
    a.update(authorized=True, at=observation['at'], expiresAt=observation['at']+2100,
             observedPendingMiB=review['observedPendingMiB'],
             ordinaryOsExecutables=review['ordinaryOsExecutables'],
             existingOtherProcesses=review['existingOtherProcesses'],
             creatorCmdlineSha256=review['creatorCmdlineSha256'])
    for key in ('scheduleFiles', 'scheduleDirectories', 'timerConfigFiles', 'timerUnitPaths', 'creatorClassification'):
        a[key] = observation[key]
    a['timerRows'] = sorted([line.split()[-2:], line.split()[:4] if line.split()[0] != '-' else ['-']]
                            for line in observation['timers']['stdout'].splitlines() if line.strip())
    now = time.time()
    admit = {'authorized': True, 'at': now, 'scope': binding['scope'], 'nonce': binding['nonce'],
             'bootId': binding['bootId'], 'pinsSha256': binding['runtimePinsSha256'],
             'observationSha256': observation_sha, 'admission': a,
             'admissionSha256': hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest(),
             'rootReview': review['rootReview'], 'rootReviewSha256': digest(review_path)}
    # Use the EXACT assembled validator, without importing/executing the runner.
    tree = ast.parse((runtime/'run-body.py').read_text())
    selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'validate_admission_metadata']
    assert len(selected) == 1
    namespace = {'json': json, 'hashlib': hashlib}
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'qualified-n10-admission-validator', 'exec'), namespace)
    namespace['validate_admission_metadata'](admit, observation, observation_sha, now, manifest, binding['runtimePinsSha256'])
    for name in ('ATTEMPT.json', 'ROOT-ADMISSION.json', 'FRESH-OBSERVATION.json'):
        assert not (runtime/name).exists(), 'runtime-already-used'
    checked_binding()
    # Admission timestamp remains anchored to the remote observation, NEVER reset
    # by this write. No retry/renewal. A partial write requires root reconciliation.
    write_exclusive(runtime/'FRESH-OBSERVATION.json', observation)
    assert digest(runtime/'FRESH-OBSERVATION.json') == observation_sha
    write_exclusive(runtime/'ROOT-ADMISSION.json', admit)
    write_exclusive(HERE/'ROOT-ADMISSION-PREFLIGHT.json', {
        'actualValidatorPassed': True, 'age': now-observation['at'],
        'admissionFileSha256': digest(runtime/'ROOT-ADMISSION.json'), 'sourceUnchanged': True,
        'residualBytes': residual, 'policyNotWorstCaseReservation': True, 'nativeLaunched': False})
    print(json.dumps({'metadataSealed': True, 'nativeLaunched': False,
                      'remainingSeconds': a['expiresAt']-time.time(), 'runtimePinsSha256': binding['runtimePinsSha256']}))

if __name__ == '__main__':
    main()
