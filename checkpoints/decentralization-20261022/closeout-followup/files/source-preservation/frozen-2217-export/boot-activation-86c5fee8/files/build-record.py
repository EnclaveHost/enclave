# PHASE B (read-only, local; root or Claude): python3 work/custody-boot-activation-20261023/build-record.py --log <the build's queue log>
# Turns the COMPLETED build-approved.sh run of the reviewed commit into build.json, refusing on any deviation:
#   the reviewed commit itself (child of a6b1378c, delta exactly supervisor.js + its test, supervisor.js = the reviewed bytes);
#   the restore folder's APPROVED-COMMIT.txt = exactly that commit with extra NONE; the build log's every success marker once
#   (control identical, reproducible, manifest/entry delta = app/supervisor.js + manifest, image files = source, measurement
#   recipe reproduces ed918e4b and ee5df6b8, queue exit 0) and no refusal; the logged inventory = stage INVENTORY.sha256; kernel
#   and cmdline unchanged; MEASUREMENT = the logged candidate; every staged file re-hashed. Root reviews build.json and then writes
#   APPROVED-BUILD.txt = "build-sha256 <sha256 of build.json>\n". Nothing later accepts a build without that line.
import argparse, json, sys
from common import *
ap = argparse.ArgumentParser(); ap.add_argument('--log', required=True); a = ap.parse_args()
assert not (A/'build.json').exists(), 'build.json exists: inspect'
probs = source_problems()
log = Path(a.log).read_text()
rec, p = build_problems(log, (RESTORE/'APPROVED-COMMIT.txt').read_text(), (REVIEWED['stage']/'INVENTORY.sha256').read_text(),
                        (REVIEWED['stage']/REVIEWED['name']/'MEASUREMENT').read_text())
probs += p
if rec: probs += staged_problems(REVIEWED['stage']/REVIEWED['name'], rec['files'])
if probs: sys.exit('REFUSED: ' + '; '.join(probs))
rec.update(recordedAt=utc(), buildLog=str(Path(a.log).resolve()), stagedFrom=str(REVIEWED['stage']/REVIEWED['name']))
raw = (json.dumps(rec, indent=2) + '\n').encode(); (A/'build.json').write_bytes(raw)
print(raw.decode(), end=''); print(f'ROOT: review build.json, then write APPROVED-BUILD.txt containing exactly: build-sha256 {sha(raw)}')
