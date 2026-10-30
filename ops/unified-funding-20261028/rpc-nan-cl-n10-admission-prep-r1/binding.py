"""Local metadata binding only; imported only on root's separately admitted run."""
from pathlib import Path
import hashlib
import json

HERE = Path(__file__).resolve().parent

def digest(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def checked_binding():
    pins = json.loads((HERE/'PREPARED-PINS.json').read_text())
    assert all(digest(HERE/name) == value for name, value in pins.items()), 'preparation-drift'
    binding = json.loads((HERE/'BINDING.json').read_text())
    runtime = Path(binding['runtime'])
    assert digest(runtime/'PINS.json') == binding['runtimePinsSha256'], 'runtime-pins-drift'
    inputs = json.loads((runtime/'PINS.json').read_text())
    assert all(digest(runtime/name) == value for name, value in inputs.items()), 'runtime-input-drift'
    manifest = json.loads((runtime/'MANIFEST.json').read_text())
    assert manifest['nonce'] == binding['nonce'] and manifest['bootId'] == binding['bootId']
    assert manifest['admission']['authorized'] is False
    assert manifest['admission']['at'] == manifest['admission']['expiresAt'] == 0
    timing = manifest['timingPolicy']
    assert (timing['outerSeconds'], timing['freshAdmissionSeconds'],
            timing['minimumAdmissionRemainingSeconds'], timing['minimumAdmissionRemainingAtSampleSeconds']) == (2500, 2100, 2010, 1805)
    return binding, runtime, manifest

def write_exclusive(path, value):
    with Path(path).open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
