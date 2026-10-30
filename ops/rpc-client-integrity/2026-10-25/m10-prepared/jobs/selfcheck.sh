#!/bin/bash
# queue 256, no compiler: the M10 patch applies to a FRESH archive + M7; default reset/sync functions are byte-unchanged; flag has no env.
set -euo pipefail; . "$(dirname "$0")/env.sh"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$T"; cd "$T"
git apply --check "$M/inputs/base-l1-verify.patch"; git apply "$M/inputs/base-l1-verify.patch"; git apply --check "$M/m10-bootstrap-anchor.patch"
echo "## git apply --stat (M10):"; git apply --stat "$M/m10-bootstrap-anchor.patch" | tail -1; echo "## new files:"; git apply --summary "$M/m10-bootstrap-anchor.patch"
git apply "$M/m10-bootstrap-anchor.patch"; echo "applies: OK"
for f in crates/consensus/engine/src/sync/anchor.rs crates/consensus/engine/src/test_utils/anchor_blocks.rs crates/consensus/service/src/service/anchor_safedb.rs; do [ -f "$f" ] || { echo "MISSING $f"; exit 1; }; done; echo "new files present: 3"
cmp -s crates/consensus/service/src/actors/derivation/actor.rs "$M/clean/crates/consensus/service/src/actors/derivation/actor.rs" && echo "derivation actor unchanged (its own first-reset SafeDB wipe kept)"
python3 - "$T" "$M/clean" <<'PY'
import sys, re
t, c = sys.argv[1], sys.argv[2]
def fn(path, name):
    s = open(path).read(); i = s.index(name); j = s.index("\n    }\n", i); return s[i:j]
for f, names in [("crates/consensus/engine/src/task_queue/core.rs", ["pub async fn reset_with_checkpoint_reader", "pub async fn reset(\n"]),
                 ("crates/consensus/engine/src/sync/mod.rs", ["pub async fn find_starting_forkchoice_with_checkpoint_reader"])]:
    for n in names:
        a, b = fn(f"{t}/{f}", n), fn(f"{c}/{f}", n)
        assert a == b, f"default path changed: {n}"; print("default unchanged:", n.split("(")[0].strip())
s = open(f"{t}/crates/consensus/cli/src/node.rs").read()
for m in re.finditer(r'#\[arg\(long = "bootstrap\.anchor"[^\]]*\]', s): assert "env" not in m.group(0), m.group(0)
print("flag occurrences:", len(re.findall(r'long = "bootstrap\.anchor"', s)), "(no env)")
PY
