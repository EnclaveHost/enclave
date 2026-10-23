# PHASE B (read-only, local; root or Claude), AFTER root's build-price.sh run in work/custody-boot-price-release-20261023:
#   python3 work/custody-boot-price-activation-20261023/build-record.py --log <that run's queue log, e.g. .../logs/build-price-1.out>
# Turns the COMPLETED build into build.json, refusing on any deviation:
#   the SOURCE re-derived from git objects with the build folder's own hash-pinned precheck.py (root's APPROVED-COMMIT.txt there:
#   single parent 9f6d37bd, delta exactly supervisor.js + the approved tests + gsup.mjs REVIEWED, builder unchanged, the patch),
#   the pending-GPU expectation present, and the hashes of supervisor.js, gsup.mjs and the boot decision function;
#   stage/build-record.json = that source; the build log's every success marker exactly once (precheck line, control = 08d1,
#   reproducible, exact manifest/entry delta, image = source, kernel/cmdline unchanged, ed918e4b/ee5df6b8/08d1f838 reproduced,
#   BUILD-RECORD hash, queue exit 0) and no refusal; inventory = the log = build-record.json; MEASUREMENT = the logged candidate;
#   every staged file re-hashed. Root reviews build.json and then writes APPROVED-BUILD.txt = "build-sha256 <sha256 of build.json>\n"
#   HERE. Nothing later accepts a build without that line.
import argparse, json, sys
from common import *
ap = argparse.ArgumentParser(); ap.add_argument('--log', required=True); a = ap.parse_args()
assert not (A/'build.json').exists(), 'build.json exists: inspect'
approval = (BUILD/'APPROVED-COMMIT.txt').read_text()
try: src = source_record(approval)
except AssertionError as e: sys.exit(f'REFUSED: {e}')
name = 'dist-leasegas-' + src['commit'][:9]
log = Path(a.log).read_text()
rec, probs = build_problems(log, approval, (BUILD/'stage/build-record.json').read_text(), (BUILD/'stage/INVENTORY.sha256').read_text(),
                            (BUILD/'stage'/name/'MEASUREMENT').read_text(), src)
if rec: probs += staged_problems(BUILD/'stage'/name, rec['files'])
if probs: sys.exit('REFUSED: ' + '; '.join(probs))
rec.update(recordedAt=utc(), buildLog=str(Path(a.log).resolve()), stagedFrom=str(BUILD/'stage'/name))
raw = (json.dumps(rec, indent=2) + '\n').encode(); (A/'build.json').write_bytes(raw)
print(raw.decode(), end=''); print(f'ROOT: review build.json, then write APPROVED-BUILD.txt here containing exactly: build-sha256 {sha(raw)}')
