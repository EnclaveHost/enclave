#!/bin/bash
# PREFLIGHT for root's LATER fresh, quiesced, COUPLED cutover backup (NOT executed by the worker; root runs it).
#   ./preflight-fresh-backup.sh <input-dir>
# <input-dir> must have the same layout as work/indexd-production-rehearsal (prepared by root, decrypted by root):
#   retirement-snapshot/{indexd.pgdump,consensus.db,indexd,GeoLite2-City.mmdb}   (the fresh coupled backup)
#   retirement-extraction-receipt.json   {"persistedOnly": {name: sha256}, "snapshotCounts": {...}, ...}
#   live-dump-receipt.json               {"file": <path whose file name is in <input-dir>>, "sha256": ...} (for a coupled
#                                        backup: the same quiesced dump)
# It only checks. It does not decrypt, does not read file CONTENTS (beyond hashes and the 5-byte pg_dump magic), and
# starts no container or process. It prints booleans and hashes. Exit 0 = ready for:
#   RH_INPUT_DIR=<input-dir> RH_LIVE_DUMP=<live dump file name> ./run.sh <run-id>
set -u
dir=${1:?input dir}
here=$(cd "$(dirname "$0")" && pwd)
work=$(cd "$here/.." && pwd)
fail=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "== layout and modes (private: dirs 0700, files 0600)"
check "input dir exists, mode 0700" '[ -d "$dir" ] && [ "$(stat -c %a "$dir")" = 700 ]'
for f in retirement-snapshot/indexd.pgdump retirement-snapshot/consensus.db retirement-snapshot/indexd retirement-snapshot/GeoLite2-City.mmdb \
         retirement-extraction-receipt.json live-dump-receipt.json; do
  check "$f present, mode 0600" '[ -f "$dir/$f" ] && [ "$(stat -c %a "$dir/$f")" = 600 ]'
done
echo "== receipts (hashes only)"
python3 - "$dir" <<'EOF' || fail=1
import hashlib, json, sys
from pathlib import Path
d = Path(sys.argv[1]); bad = 0
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
rr = json.loads((d / "retirement-extraction-receipt.json").read_text())
lr = json.loads((d / "live-dump-receipt.json").read_text())
for n, h in rr.get("persistedOnly", {}).items():
    m = sha(d / "retirement-snapshot" / n) == h
    print(f"  {'ok  ' if m else 'FAIL'} snapshot {n} matches receipt"); bad |= not m
live = d / Path(lr["file"]).name  # the receipt records a workspace-relative path; the dump lives in the input dir
m = live.exists() and sha(live) == lr["sha256"]
print(f"  {'ok  ' if m else 'FAIL'} live dump {live.name} matches receipt"); bad |= not m
for p in (d / "retirement-snapshot" / "indexd.pgdump", live):
    with open(p, "rb") as f:
        m = f.read(5) == b"PGDMP"
    print(f"  {'ok  ' if m else 'FAIL'} {p.name} is a pg_dump custom archive"); bad |= not m
has = {"snapshotCounts", "persistedOnly"} <= set(rr)
print(f"  {'ok  ' if has else 'FAIL'} receipt has snapshotCounts and persistedOnly"); bad |= not has
print(f"  info deployed binary in the backup: {sha(d / 'retirement-snapshot' / 'indexd')} "
      f"(the rehearsal expects 2d7a637e... = v0.6.0; a different deployed binary needs ORIG_SHA reviewed first)")
print(f"  info configAndOperationsSecretsExtracted = {rr.get('configAndOperationsSecretsExtracted')} (must be false)")
bad |= rr.get("configAndOperationsSecretsExtracted") is not False
sys.exit(1 if bad else 0)
EOF
echo "== frozen binaries, packages and rehearsal files"
check "fence release 61413110" '[ "$(sha256sum "$work/indexd-replica-rollout/release/indexd-v0.6.0-fence.1-linux-amd64" | cut -d" " -f1)" = 61413110dc4426e43b030b418bfeb314b0dc0ea9c09f82dc48523ec862335901 ]'
check "C2 R2 release e6e812fd" '[ "$(sha256sum "$work/indexd-c2-implementation/package/release/indexd-v0.6.0-fence.2-c2-linux-amd64" | cut -d" " -f1)" = e6e812fd625de0cd7c5956c5c5bffc5f3d1822784d65125cdc704ba793ec2955 ]'
check "C2 package manifest verifies" '(cd "$work/indexd-c2-implementation/package" && sha256sum -c --quiet PACKAGE.sha256)'
check "rollout package manifest verifies" '(cd "$work/indexd-replica-rollout" && sha256sum -c --quiet PACKAGE.sha256)'
check "G5 rehearsaltool ec8dc6d2" '[ "$(sha256sum "$work/indexd-prod-rehearsal/bin/rehearsaltool" | cut -d" " -f1)" = ec8dc6d293a8ce28ed1734fbc30f02ea86f99c4aba265afc682fca6c72e771d3 ]'
check "rehearsal files match FROZEN-final.sha256" '(cd "$here" && sha256sum -c --quiet FROZEN-final.sha256)'
echo "== isolation and capacity"
check "PostgreSQL image (production digest) present locally" 'docker image inspect postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 >/dev/null 2>&1'
check "unprivileged user+network namespace available" 'unshare --user --map-root-user --net true'
check "no leftover c2prh-* containers or volume" '[ -z "$(docker ps -aq --filter name=c2prh-)" ] && ! docker volume inspect c2prh-pgdata >/dev/null 2>&1'
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
need=$((16384 + 768 + 256 + 256))
check "MemAvailable ${avail} MiB >= ${need} MiB (16 GiB floor + 768 queue + 256 PostgreSQL container + 256 host variation)" '[ "$avail" -ge "$need" ]'
free_g=$(df -BG --output=avail "$here" | tail -1 | tr -dc 0-9)
check "disk free ${free_g} GiB >= 10 GiB (consensus.db copies in the controller backups)" '[ "$free_g" -ge 10 ]'
echo
if [ $fail -eq 0 ]; then
  live=$(python3 -c 'import json,sys,pathlib; print(pathlib.Path(json.load(open(sys.argv[1]))["file"]).name)' "$dir/live-dump-receipt.json")
  echo "PREFLIGHT OK. Root may run:  RH_INPUT_DIR=$dir RH_LIVE_DUMP=$live $here/run.sh <run-id>"
else
  echo "PREFLIGHT FAILED: fix the items above first."
fi
exit $fail
