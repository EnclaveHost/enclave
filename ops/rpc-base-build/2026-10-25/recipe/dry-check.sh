#!/bin/bash
# Production-build DRY CHECK (no compile). Root/agent-runnable, OFFLINE, queue 512:
#   python3 work/claude-test-queue.py --mib 512 --log $P/logs/dry-check.guard -- unshare -rn bash $P/dry-check.sh
# Re-derives the patched source from the pinned base repository and patch and diffs it with build/src; resolves the `base`
# binary's full dependency graph --offline --locked against the PRIVATE build/cargo-home (no network: unshare -rn); reports
# build scripts that might need network, version-embedding (vergen) users, and the inputs' hashes. Writes only under $P.
set -uo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" GIT_OPTIONAL_LOCKS=0   # read-only git inside the user namespace
. "$(dirname "$0")/../jobs/env.sh"
ip link set lo up 2>/dev/null || true
P=$(cd "$(dirname "$0")" && pwd); T=$P/tmp-dry; rm -rf "$T"; mkdir -p "$T"; rc=0
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; rc=1; fi; }
S=$BUILD/src
echo "== inputs"
echo "[toolchain] $(rustc --version) | $(cargo --version)"
need "base repo HEAD == $BASE_REV" [ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ]
echo "[base] commit $BASE_REV tree $(git -C "$BASE_REPO" rev-parse "$BASE_REV^{tree}") committed $(git -C "$BASE_REPO" log -1 --format=%cI $BASE_REV) (epoch $(git -C "$BASE_REPO" log -1 --format=%ct $BASE_REV))"
need "patch sha256 e9dfb8c6..." [ "$(sha256sum < "$PATCH" | cut -c1-16)" = e9dfb8c6f950222f ]
need "provider chain_provider.rs == validated 201d9b8c..." [ "$(sha256sum < "$S/crates/consensus/providers/src/chain_provider.rs" | cut -c1-16)" = 201d9b8c16b080a4 ]
echo "[hash] Cargo.lock $(sha256sum < "$S/Cargo.lock" | cut -c1-64); l1.rs $(sha256sum < "$S/crates/consensus/cli/src/l1.rs" | cut -c1-64)"
echo "== source provenance: git archive $BASE_REV + git apply patch == build/src ?"
mkdir -p "$T/src"; git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$T/src"; (cd "$T/src" && git apply "$PATCH")
d=$(diff -rq "$T/src" "$S" 2>&1 | head -20); need "build/src is exactly pristine $BASE_REV + patch (no other file)" [ -z "$d" ]; [ -n "$d" ] && echo "$d"
echo "[hash] source tree manifest $( (cd "$S" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64)"
echo "== offline dependency resolution for package base (private CARGO_HOME $CARGO_HOME; network namespace: lo only)"
cd "$S"
cargo metadata --offline --locked --format-version 1 > "$T/metadata.json" 2> "$T/metadata.err"; m=$?
need "cargo metadata --offline --locked resolves the workspace" [ $m = 0 ]; [ $m = 0 ] || tail -5 "$T/metadata.err"
cargo tree --offline --locked -p base -e normal,build --prefix none --format '{p}' > "$T/tree.txt" 2> "$T/tree.err"; t=$?
need "cargo tree -p base --offline --locked (normal+build deps)" [ $t = 0 ]; [ $t = 0 ] || tail -5 "$T/tree.err"
echo "[deps] base graph: $(sort -u "$T/tree.txt" | wc -l) unique package lines"
for x in sp1-recursion-gnark-ffi openssl-src openssl-sys protobuf-src; do echo "[deps] $x in base graph: $(grep -c "^$x v" "$T/tree.txt")"; done
python3 - "$T/metadata.json" "$T/tree.txt" <<'PY'
import json,sys,re
m=json.load(open(sys.argv[1])); used={re.sub(r" \(.*","",l.strip()) for l in open(sys.argv[2]) if l.strip()}
pk={f"{p['name']} v{p['version']}":p for p in m["packages"]}
bs=[k for k in sorted(used) if k in pk and any("custom-build" in t["kind"] for t in pk[k]["targets"])]
print(f"[deps] packages with build scripts in base graph: {len(bs)}")
print("[deps] build-script packages:", ", ".join(x.split(" v")[0] for x in bs)[:1500])
ve=[k for k in sorted(used) if k in pk and any(d["name"].startswith("vergen") for d in pk[k]["dependencies"])]
print("[deps] packages depending on vergen*:", ", ".join(ve) or "none")
src=sorted({(pk[k].get("source") or "path").split("?")[0].split("#")[0] for k in used if k in pk})
print("[deps] sources:", "; ".join(s[:90] for s in src)[:900])
PY
echo "== dry check rc=$rc"; exit $rc
