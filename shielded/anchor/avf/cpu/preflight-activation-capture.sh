#!/usr/bin/env bash
# preflight-activation-capture.sh <report> -- host preflight of the device run's per-call capture (cpu/activation-capture.sh,
# the SAME file the run sources), before anything touches the phone. Each case runs `cl` in its own shell, the way the run
# does, followed by a marker command; the report says whether the shell went on (the marker ran) and with what exit code.
#   valid state                         -> exit 0, the marker runs, one row whose snapshot equals `pvm-client state`
#   the called command fails (rc 2)     -> its code is RELAYED (2) and the run goes on: a call result, not a capture failure
#   malformed state output              -> exit 3, the marker never runs, no row
#   missing state (no client installed) -> exit 3 (`pvm-client state` exits non-zero), no row
#   an incomplete state / a null gen    -> exit 3, no row
#   exchanges.jsonl cannot be written   -> exit 3
# Exit 0 only if every case behaves so. Uses the built client (client/dist/pvm-client.mjs) and a fake one that answers only
# `state` with the given bytes (everything else goes to the real client).
set -uo pipefail
REPORT="$1"; H="$(cd "$(dirname "$0")/.." && pwd)"; LIB="${PREFLIGHT_LIB:-$H/cpu/activation-capture.sh}"   # PREFLIGHT_LIB: only for a negative control
REAL="$H/client/dist/pvm-client.mjs"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
: > "$REPORT"; fails=0
say() { echo "$*" | tee -a "$REPORT"; }
cat > "$W/fake.mjs" <<EOF
// answers \`state\` with FAKE_STATE (exit FAKE_STATE_RC); every other command is the real client's
if (process.argv[2] === "state" && process.env.FAKE_STATE !== undefined) { process.stdout.write(process.env.FAKE_STATE); process.exit(Number(process.env.FAKE_STATE_RC || 0)); }
await import(${JSON_REAL:-"\"file://$REAL\""});
EOF
node "$REAL" install --state "$W/state.d" --policy-key-fp "$(printf 'a%.0s' $(seq 64))" --serial-floor 3 --release-key-fp "$(printf 'b%.0s' $(seq 64))" > /dev/null || { say "FAIL setup: install"; exit 1; }
REALSTATE=$(node "$REAL" state --state "$W/state.d")
# case <name> <want-exit> <want-marker yes|no> <want-rows> <cli> <state dir> <command...> ; env FAKE_STATE/FAKE_STATE_RC pass through
case_() {
  local name="$1" want="$2" wantm="$3" wantrows="$4" cli="$5" st="$6"; shift 6
  local out="$W/out-$name"; mkdir -p "$out/evidence"
  local o; o=$(OUT="$out" CLI="$cli" STATE="$st" INSTALL="$W" LIB="$LIB" bash -c 'log() { echo "LOG $*"; }; source "$LIB"; cl "$0" "$@"; echo "MARKER rc=$?"' "$name" "$@" 2>&1); local code=$?
  local rows=0; [ -f "$out/exchanges.jsonl" ] && rows=$(grep -c . "$out/exchanges.jsonl")
  local marker=no; grep -q '^MARKER' <<<"$o" && marker=yes
  local ok=yes; [ "$code" = "$want" ] && [ "$marker" = "$wantm" ] && [ "$rows" = "$wantrows" ] || ok=no
  if [ "$name" = valid ] && [ "$ok" = yes ]; then   # the row's snapshot is the real state, field for field
    python3 - "$out/exchanges.jsonl" "$REALSTATE" <<'PY' || ok=no
import json, sys
row = json.loads(open(sys.argv[1]).read().splitlines()[0]); st = json.loads(sys.argv[2]); s = st["state"]
a = row["after"]
assert a == {"gen": st["gen"], "serial": s["serial"], "policyFp": s["policyFp"], "nextPolicyFp": s.get("nextPolicyFp"), "releaseFp": s["releaseFp"], "active": None}, a
PY
  fi
  [ "$ok" = yes ] || fails=$((fails + 1))
  say "$([ "$ok" = yes ] && echo 'ok  ' || echo 'FAIL') $name: exit $code (want $want), marker ran: $marker (want $wantm), rows: $rows (want $wantrows)$(grep -m1 '^LOG CAPTURE FAILED' <<<"$o" | sed 's/^LOG / -- /')"
}
case_ valid 0 yes 1 "$REAL" "$W/state.d" version
case_ command-fails 0 yes 1 "$REAL" "$W/state.d" run --policy "$W/no-such-policy.json" --relay http://127.0.0.1:9 --app "$(printf 'c%.0s' $(seq 64))"
grep -q 'MARKER rc=1\|MARKER rc=2' <<<"$(OUT="$W/out-command-fails" CLI="$REAL" STATE="$W/state.d" INSTALL="$W" LIB="$LIB" bash -c 'log() { :; }; source "$LIB"; cl again run --policy /nonexistent --relay http://127.0.0.1:9 --app x; echo "MARKER rc=$?"' 2>&1)" \
  && say "ok   command-fails: the call's own non-zero code is relayed to the caller" || { say "FAIL command-fails: the call's code was not relayed"; fails=$((fails + 1)); }
FAKE_STATE='{not json' case_ malformed 3 no 0 "$W/fake.mjs" "$W/state.d" version
case_ missing 3 no 0 "$REAL" "$W/no-state-here.d" version
FAKE_STATE='{"state":{},"gen":1}' case_ incomplete 3 no 0 "$W/fake.mjs" "$W/state.d" version
FAKE_STATE="$(python3 -c 'import json,sys; st=json.loads(sys.argv[1]); st["gen"]=None; print(json.dumps(st))' "$REALSTATE")" case_ null-gen 3 no 0 "$W/fake.mjs" "$W/state.d" version
FAKE_STATE="$REALSTATE" FAKE_STATE_RC=2 case_ state-exits-nonzero 3 no 0 "$W/fake.mjs" "$W/state.d" version
mkdir -p "$W/out-unwritable/exchanges.jsonl"   # a directory where the row must be appended
case_ unwritable 3 no 0 "$REAL" "$W/state.d" version
[ "$fails" = 0 ] && say "PASS the capture preflight: a capture failure stops the shell with exit 3, nothing after it runs" || say "FAIL ($fails) the capture preflight"
exit $([ "$fails" = 0 ] && echo 0 || echo 1)
