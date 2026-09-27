#!/usr/bin/env python3
"""Exercise measurement-policy agreement against a pinned release and two bundles.

No guest is launched and no configuration or secrets are consumed. Expected
measurements must come from independent reconstruction or recorded attestation.
"""
import argparse
import hashlib
import pathlib
import subprocess
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--release', required=True)
p.add_argument('--pin', required=True)
p.add_argument('--bundle-one', required=True)
p.add_argument('--bundle-two', required=True)
p.add_argument('--expected-one', required=True)
p.add_argument('--expected-two', required=True)
a = p.parse_args()
script = pathlib.Path(__file__).with_name('expected-measurement.sh')
with tempfile.TemporaryDirectory() as tmp:
    output = pathlib.Path(tmp) / 'runtime.json'
    def run(bundle, vcpus):
        output.unlink(missing_ok=True)
        return subprocess.run([str(script), '--pin', a.pin, a.release, bundle, str(vcpus),
                               '--runtime-out', str(output)], capture_output=True, text=True, timeout=120)
    for bundle, cpus, expected in [(a.bundle_one, 1, a.expected_one), (a.bundle_two, 2, a.expected_two)]:
        r = run(bundle, cpus)
        assert r.returncode == 0, r.stderr
        fields = dict(line.split(' ', 1) for line in r.stdout.splitlines())
        assert fields['measurement'] == expected
        assert fields['app_id'] == hashlib.sha256(pathlib.Path(bundle).read_bytes()).hexdigest()
        assert output.is_file()
        print(f'PASS {cpus}-vCPU bundle reproduces expected measurement and AppID')
    for bundle, cpus in [(a.bundle_one, 2), (a.bundle_two, 1), (a.bundle_two, 0),
                         (a.bundle_two, 17), (a.bundle_two, '2x')]:
        r = run(bundle, cpus)
        assert r.returncode != 0
        assert not r.stdout.strip(), 'a refusal emitted acceptance output'
        assert not output.exists(), 'a refusal wrote a runtime acceptance artifact'
        assert ('does not match the bundle policy' in r.stderr or
                'integer from 1 through 16' in r.stderr), r.stderr
        print(f'PASS mismatched/invalid count {cpus!r} refuses without acceptance output')
