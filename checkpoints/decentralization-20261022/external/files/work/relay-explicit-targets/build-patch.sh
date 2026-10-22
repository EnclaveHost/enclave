#!/usr/bin/env bash
# relay-targets.patch                      CURRENT main -> src/ (this candidate; 5 files)
# relay-targets.after-storage.deploy.patch storage's relay/deploy.sh (main + its 01 hunk) -> src-after-storage/relay/deploy.sh
# Both checked with git apply --check and byte-compared on scratch copies; main and the frozen inputs are only read.
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P); P=$W/storage-front-binding/patches
S=$(mktemp -d "$C/scratch.XXXXXX"); trap 'rm -rf -- "$S"' EXIT
mapfile -t OWN < <(cd "$C/src" && find . -type f | sed 's|^\./||' | sort)
for f in "${OWN[@]}"; do [ -f "$C/base/$f" ] && { cmp -s "$C/base/$f" "$E/$f" || { echo "main drifted since the base copy: $f"; exit 1; }; }; done
diffpatch() {  # OLD NEW REL >> out
  git diff --no-index --no-color --full-index "$1" "$2" | sed -e "s|^diff --git a/.* b/.*|diff --git a/$3 b/$3|" -e "s|^--- a/.*|--- a/$3|" -e "s|^+++ b/.*|+++ b/$3|" || true
}
: > "$C/relay-targets.patch"
for f in "${OWN[@]}"; do old="$E/$f"; [ -f "$old" ] || old=/dev/null; cmp -s "$old" "$C/src/$f" || diffpatch "$old" "$C/src/$f" "$f" >> "$C/relay-targets.patch"; done
mkdir -p "$S/main"; for f in "${OWN[@]}"; do [ -f "$E/$f" ] && { mkdir -p "$S/main/$(dirname "$f")"; cp "$E/$f" "$S/main/$f"; }; done
git -C "$S/main" init -q; git -C "$S/main" apply --check "$C/relay-targets.patch"; git -C "$S/main" apply "$C/relay-targets.patch"
for f in "${OWN[@]}"; do cmp -s "$S/main/$f" "$C/src/$f" || { echo "MISMATCH $f"; exit 1; }; done
# storage's deploy.sh: their 01 patch's deploy.sh hunk on main's deploy.sh
mkdir -p "$S/storage/relay"; cp "$E/relay/deploy.sh" "$S/storage/relay/"; git -C "$S/storage" init -q
git -C "$S/storage" apply --include=relay/deploy.sh "$P/01-relay-writer-authority.patch"
want=$(grep ' relay/deploy.sh$' "$P/INVENTORY.txt" | awk '{print $3}'); got=$(sha256sum < "$S/storage/relay/deploy.sh" | cut -c1-64)
[ "$got" = "$want" ] || { echo "storage deploy.sh $got != inventory $want"; exit 1; }
diffpatch "$S/storage/relay/deploy.sh" "$C/src-after-storage/relay/deploy.sh" relay/deploy.sh > "$C/relay-targets.after-storage.deploy.patch"
cp -a "$S/storage" "$S/storage2"; git -C "$S/storage2" apply "$C/relay-targets.after-storage.deploy.patch"
cmp -s "$S/storage2/relay/deploy.sh" "$C/src-after-storage/relay/deploy.sh" || { echo "after-storage MISMATCH"; exit 1; }
{ echo "relay-explicit-targets patches ($(date -Iseconds)); main work/enclave HEAD $(git -C "$E" rev-parse HEAD)"
  echo "relay-targets.patch                      $(sha256sum < "$C/relay-targets.patch" | cut -c1-64)  base = CURRENT main; git apply --check ok; result == src/"
  echo "relay-targets.after-storage.deploy.patch $(sha256sum < "$C/relay-targets.after-storage.deploy.patch" | cut -c1-64)  base = storage deploy.sh $want (main + storage 01 hunk); result == src-after-storage/"
  echo "files: path | CURRENT main sha256 | candidate sha256"
  for f in "${OWN[@]}"; do echo "  $f"; echo "      main $( [ -f "$E/$f" ] && sha256sum < "$E/$f" | cut -c1-64 || echo '(new)')"; echo "      new  $(sha256sum < "$C/src/$f" | cut -c1-64)"; done
  echo "  relay/deploy.sh (after storage)"; echo "      base $want"; echo "      new  $(sha256sum < "$C/src-after-storage/relay/deploy.sh" | cut -c1-64)"
} > "$C/MANIFEST.txt"
cat "$C/MANIFEST.txt"
