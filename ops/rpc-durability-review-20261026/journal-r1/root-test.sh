#!/bin/bash
# SOURCE-ONLY prepared job. Root admits through the shared memory queue.
# unit: 256 MiB; full: 1024 MiB. No downloads or live services.
# Keep full qualification out of the exclusive retention window.
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-unit}"
case "$mode" in unit|full) ;; *) exit 2;; esac
cd "$stage"
sha256sum -c --quiet SHA256SUMS
run="$stage/results/$(date -u +%Y%m%dT%H%M%SZ)-$$-$mode"
mkdir -p "$run"
scratch="$(mktemp -d /tmp/journal-durability.XXXXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
cp -a "$stage/network" "$stage/test" "$scratch/"
ln -s /home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/node_modules "$scratch/node_modules"
node_bin="$(command -v node)"
"$node_bin" --version > "$run/node-version.txt"
sha256sum "$node_bin" > "$run/node.sha256"
cd "$scratch"
python3 -I - "$stage/expected-counts.json" "$mode" "$run" "$node_bin" <<'PY'
import json, pathlib, re, subprocess, sys
expected = json.load(open(sys.argv[1])); mode, output, node = sys.argv[2:]
for name, count in expected.items():
    if mode == 'unit' and name != 'test/journal-durability.test.mjs': continue
    log = pathlib.Path(output) / (name.replace('/', '_') + '.tap')
    with log.open('w') as out:
        result = subprocess.run([node, '--max-old-space-size=128', '--test', '--test-concurrency=1', '--test-reporter=tap', name], stdout=out, stderr=subprocess.STDOUT, timeout=180)
    text = log.read_text()
    def stat(key):
        values = re.findall(r'^# '+key+r' (\d+)$', text, re.M)
        assert len(values) == 1, (name, key, 'missing/unexpected summary')
        return int(values[0])
    assert result.returncode == 0, (name, result.returncode, str(log))
    assert stat('tests') == count and stat('pass') == count, (name, 'wrong test/pass count')
    assert all(stat(key) == 0 for key in ['fail', 'cancelled', 'skipped', 'todo']), (name, 'incomplete test')
    print(f'PASS {name}: {count}', flush=True)
if mode == 'full':
    with (pathlib.Path(output) / 'native-owner.log').open('w') as out:
        subprocess.run([node, '--max-old-space-size=64', 'test/deployment-journal-native.mjs'], stdout=out, stderr=subprocess.STDOUT, timeout=30, check=True)
    print('PASS native owner process death/exclusion', flush=True)
PY
cd "$stage"
sha256sum -c --quiet SHA256SUMS
printf 'PASS %s\n' "$mode" > "$run/RESULT"
printf 'Results: %s\n' "$run"
