#!/usr/bin/env bash
# Rebuild patches/ and closure-manifest.json from the candidate tree against the snapshot base (base-manifest.sha256,
# taken from work/enclave at main e762a9c5 + its working tree on 2026-10-20T13:12:06-07:00). Deterministic; touches no
# other workers' files.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf patches && mkdir -p patches
MODIFIED="relay/dns-relay.js relay/network-runtime.mjs isolation/m2/bootstrap/names.go isolation/m2/front/names.go isolation/m2/front/main.go
isolation/m2/front/bootstrap.go isolation/m2/front/names_test.go sdk/bootstrap/package.mjs relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json"
NEW="network/app-zone-challenge.mjs isolation/m2/front/appzone.go isolation/m2/front/appzone_test.go isolation/m2/front/appzone_process_test.go
isolation/m2/bootstrap/appzone_test.go isolation/m2/bootstrap/testdata/appzone-vectors.json test/app-zone-fixture.mjs test/app-zone-challenge.test.mjs
test/app-zone-sdk.test.mjs test/app-zone-replica.test.mjs test/app-zone-fleet.mjs test/run-app-zone.sh docs/network/app-zone-certificates.md"
python3 - "$MODIFIED" "$NEW" <<'PY'
import hashlib, json, subprocess, sys, pathlib
mod, new = sys.argv[1].split(), sys.argv[2].split()
base = dict((l.split('  ',1)[1].strip()[2:], l.split()[0]) for l in open('base-manifest.sha256'))
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
out = {'snapshotHead': open('snapshot-head.txt').read().strip(), 'snapshotTime': open('snapshot-time.txt').read().strip(), 'modified': {}, 'new': {}, 'deploy': {}}
for f in mod:
    b = 'source/base/' + f
    assert sha(b) == base[f], f + ': base copy differs from the snapshot manifest'
    p = 'patches/' + f.replace('/', '__') + '.patch'
    d = subprocess.run(['diff', '-u', '--label', 'a/' + f, '--label', 'b/' + f, b, 'tree/' + f], capture_output=True)
    assert d.returncode == 1, f + ': no change or diff error'
    open(p, 'wb').write(d.stdout)
    out['modified'][f] = {'base': base[f], 'result': sha('tree/' + f), 'patch': sha(p)}
for f in new:
    assert f not in base, f + ' exists in the base'
    out['new'][f] = sha('tree/' + f)
for f in sorted(pathlib.Path('deploy').rglob('*')):
    if f.is_file(): out['deploy'][str(f)] = sha(f)
json.dump(out, open('closure-manifest.json', 'w'), indent=1); open('closure-manifest.json', 'a').write('\n')
print(json.dumps({k: len(v) if isinstance(v, dict) else v for k, v in out.items()}))
PY
