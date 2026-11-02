#!/bin/bash
# Real pinned base v1.5.1 binary, offline, inside `unshare -rmn`: init a scratch Base datadir, bind-mount it
# read-only, run origin_extract.py, and prove (a) the db get path parses real output, (b) the tree is unchanged.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=/home/steven/Documents/Codex/2026-10-18/wo/work/fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base
SHA=9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f
T=$(mktemp -d /tmp/covreal.XXXXXX)
trap 'umount "$T/ro" 2>/dev/null || true; rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/ro"
HOME=$T/home timeout -k 5 300 "$BIN" reth init --chain base --datadir "$T/rw" > "$T/init.log" 2>&1 || { tail -20 "$T/init.log"; exit 1; }
mount --bind "$T/rw" "$T/ro"
mount -o remount,bind,ro "$T/ro"
before=$(find "$T/rw" -printf '%P %s %T@ %m\n' | sort | sha256sum)
before_c=$(find "$T/rw" -type f -exec sha256sum {} + | sort | sha256sum)
set +e
mkdir "$T/scratch"
timeout -k 5 600 python3 "$HERE/origin_extract.py" --base-bin "$BIN" --base-sha256 "$SHA" --datadir "$T/ro" --scratch "$T/scratch" --out "$T/origin.json"
rc=$?
set -e
after=$(find "$T/rw" -printf '%P %s %T@ %m\n' | sort | sha256sum)
after_c=$(find "$T/rw" -type f -exec sha256sum {} + | sort | sha256sum)
cat "$T/origin.json"; echo
[ "$before" = "$after" ] && [ "$before_c" = "$after_c" ] || { echo "FAIL: datadir changed"; exit 1; }
python3 - "$T/origin.json" "$rc" <<'PY'
import json, sys
d, rc = json.load(open(sys.argv[1])), int(sys.argv[2])
p = d.get('progress', {})
# A genesis-only datadir: no persisted safe/finalized labels, tip 0, and block 0 has no L1-attributes deposit.
assert rc == 2 and d['status'] == 'REFUSED', d
assert p.get('lastSafeBlock') is None and p.get('lastFinalizedBlock') is None and p.get('finishBlock') == 0, p
assert p['tipHeader']['hash'] == '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd', p
assert 'tip block 0: body pruned or empty' in d['refusal'], d['refusal']
print('REAL-ORIGIN PASS: pinned base reth db get ran read-only; labels absent reported; genesis hash matched; tree unchanged')
PY
