#!/bin/bash
# Builds the SDK C2 candidate's test binary (it holds the #[ignore] real_c2_* driver cases) from the HASHED SNAPSHOT
# $SNAP (default sdk-snapshot-c2; SNAPSHOT.sha256; the SDK worker's tree is never built in place or edited), native target, offline,
# own target dir, no debug info, one job. Inside ONE shared-queue allocation (768 MiB = real interop):
#   python3 work/claude-test-queue.py --mib 768 --log logs/sdkbuild.guard.log -- tools/build-sdk-driver.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
snap=${SNAP:-sdk-snapshot-c2} out=${OUT:-sdk-c2-driver}
cd "$here/$snap"
(cd sia-s3 && sha256sum -c --quiet ../SNAPSHOT.sha256)
echo "snapshot verified"
cd sia-s3
export CARGO_TARGET_DIR="$here/sdk-target" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
taskset -c 0-1 cargo test --offline --target x86_64-unknown-linux-gnu --no-run --message-format=json 2>"$here/logs/sdkbuild.stderr" \
  | python3 -c '
import json, sys
exe = None
for l in sys.stdin:
    try:
        m = json.loads(l)
    except ValueError:
        continue
    if m.get("reason") == "compiler-artifact" and m.get("executable") and m["target"]["name"] == "sia-s3" and m["profile"]["test"]:
        exe = m["executable"]
print(exe or "")
' > "$here/logs/sdkbuild.exe"
exe=$(cat "$here/logs/sdkbuild.exe")
[ -n "$exe" ] || { grep -E "^error" -A6 "$here/logs/sdkbuild.stderr" | head -60; exit 1; }
mkdir -p "$here/bin"
cp "$exe" "$here/bin/$out"
sha256sum "$here/bin/$out"
"$here/bin/$out" --list --ignored 2>/dev/null | grep -E "real_c2_|real_fence_|real_indexd" | head -40
