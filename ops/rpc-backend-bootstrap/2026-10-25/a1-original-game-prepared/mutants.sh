#!/bin/sh
# STRICT mutant harness for a1-recheck.mjs. Run ONLY after root's unit run passed, in the FOREGROUND under the queue:
#   python3 -u ../../../claude-test-queue.py --mib 256 --log logs/mutants.guard -- unshare -rn sh mutants.sh > logs/mutants.out 2>&1; echo $? > logs/mutants.rc
# Keeps every log under logs/mutants/ (baseline.tap, <name>.tap/.rc/.verdict.json, summary.json). Exit 0 only if the
# baseline is clean AND all 10 named mutants are GENUINELY killed (taplog.py: same test count as baseline, ERR_ASSERTION
# testCodeFailure only, no syntax/import/timeout/cancel). Any anchor that does not match exactly once ABORTS (exit 2).
set -u
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}"
ip link set lo up 2>/dev/null || true
L=logs/mutants; [ ! -e "$L" ] || { echo "ABORT: $L exists (never overwrite evidence)"; exit 2; }; mkdir -p "$L"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
copy() { rm -rf "$T/s"; mkdir -p "$T/s"; cp -r a1-recheck.mjs a1-anchor.mjs a1-read.mjs vendor test "$T/s/"; }
runtests() { (cd "$T/s" && timeout 120 node --test --test-reporter=tap test/a1-recheck.test.mjs </dev/null) > "$1" 2>&1; echo $?; }
sha256sum a1-recheck.mjs test/a1-recheck.test.mjs taplog.py > "$L/inputs.sha256"
# --- mutant table: NAME<TAB>ANCHOR<TAB>REPLACEMENT (exactly 10, unique names) -------------------------------------
cat > "$L/table.tsv" <<'TSV'
initial-verdict	if (e.verdict !== INITIAL_VERDICT || "recheckOf" in e) fail	if (false) fail
initial-sha	sha !== lc(expectedSha256).replace(/^0x/, "")) fail	false) fail
freshness	if (number <= init.l1.number || at.blockHash === init.l1.hash) fail	if (false) fail
root-unchanged	if (lc(await h("gameRootClaim", G, "rootClaim()", "bytes32")) !== init.outputRoot) fail	if (false) fail
n-unchanged	if (await h("gameL2SequenceNumber", G, "l2SequenceNumber()", "uint") !== init.N) fail	if (false) fail
respected-type	if (respectedGameType !== init.respectedGameType) fail	if (false) fail
pin-codehash	if (v.codeHash !== lc(was.codeHash)) fail	if (false) fail
anchor-regressed	if (latest.l2SequenceNumber < init.N) fail	if (false) fail
use-latest-N	game: G, N: init.N.toString(), outputRoot: init.outputRoot,	game: G, N: latest.l2SequenceNumber.toString(), outputRoot: lc(latest.root),
binding	if (g !== init.game || BigInt(N) !== init.N || root !== init.outputRoot || cfg.asr !== init.asr)	if (false)
TSV
python3 - "$L/table.tsv" a1-recheck.mjs <<'PY' || { echo "ABORT: mutant table invalid"; exit 2; }
import sys
rows=[l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
src=open(sys.argv[2]).read()
assert len(rows)==10 and all(len(r)==3 for r in rows), "need exactly 10 rows of NAME/ANCHOR/REPLACEMENT"
assert len({r[0] for r in rows})==10, "mutant names not unique"
for n,a,b in rows:
    assert src.count(a)==1, f"{n}: anchor matches {src.count(a)} times"
    assert a!=b, f"{n}: replacement equals anchor"
print("table ok: 10 unique mutants, each anchor matches exactly once")
PY
# --- baseline ---------------------------------------------------------------------------------------------------------
copy; rc=$(runtests "$L/baseline.tap"); echo "$rc" > "$L/baseline.rc"
python3 taplog.py baseline "$L/baseline.tap" "$rc" > "$L/baseline.verdict.json" || { echo "ABORT: baseline not clean: $(cat "$L/baseline.verdict.json")"; exit 2; }
N=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['tests'])" "$L/baseline.verdict.json")
echo "baseline clean: $N tests"
# --- mutants ------------------------------------------------------------------------------------------------------------
fails=0
while IFS="$(printf '\t')" read -r name anchor repl; do
  [ -n "$name" ] || continue
  copy
  python3 - "$T/s/a1-recheck.mjs" "$anchor" "$repl" <<'PY' || { echo "ABORT: replacement failed for $name"; exit 2; }
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
if s.count(a)!=1: sys.exit(1)
open(p,'w').write(s.replace(a,b))
PY
  [ $? -eq 0 ] || exit 2
  rc=$(runtests "$L/$name.tap"); echo "$rc" > "$L/$name.rc"
  if python3 taplog.py killed "$L/$name.tap" "$rc" "$N" > "$L/$name.verdict.json"; then echo "killed $name"; else echo "NOT GENUINELY KILLED $name: $(cat "$L/$name.verdict.json")"; fails=$((fails+1)); fi
done < "$L/table.tsv"
python3 - "$L" "$N" "$fails" <<'PY'
import json,sys,os,glob
L,N,f=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
v={os.path.basename(p)[:-13]:json.load(open(p))["verdict"] for p in sorted(glob.glob(f"{L}/*.verdict.json")) if not p.endswith("baseline.verdict.json")}
json.dump({"baselineTests":N,"mutants":v,"killed":sum(x=="killed" for x in v.values()),"total":len(v),"notGenuinelyKilled":f},open(f"{L}/summary.json","w"),indent=1)
print(json.dumps({"killed":sum(x=="killed" for x in v.values()),"total":len(v)}))
PY
[ "$fails" -eq 0 ] && { echo "## mutants rc=0"; exit 0; } || { echo "## mutants rc=1"; exit 1; }
