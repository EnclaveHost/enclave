# activation-capture.sh -- SOURCED by cpu/app-activation-run.sh and cpu/preflight-activation-capture.sh (LAB): the one
# implementation of an installed-client call with its per-call capture, so the preflight exercises exactly the code the
# device run executes. The caller provides OUT, CLI, STATE, INSTALL and log().
#   cl <label> <command...>   runs `node $CLI <command...> --state $STATE --install-dir $INSTALL` (under `timeout` when
#                             CL_TIMEOUT is set), keeps its output, stderr
#                             and exit code, then appends ONE row to $OUT/exchanges.jsonl: the evidence exchanges this call
#                             made (the relay carrier numbers them in arrival order) and the committed state right after it
#                             (gen, serial, policy key and successor, release key, active record). Returns the call's code.
# A capture failure is FATAL: capture_fail logs it and exits the calling shell with 3, so a run can never go on with a
# missing, null or malformed snapshot -- no later command can swallow it. (Run 2's defect: the state was piped into a
# heredoc python, whose stdin the heredoc itself is, so every snapshot was recorded as null and the run went on.) The state
# therefore reaches python through a FILE, and the python refuses anything but a complete state.
capture_fail() { log "CAPTURE FAILED after $1: $2 -- stopping (exit 3); the results so far are kept as they are"; exit 3; }
capture_row() {   # capture_row <label> <rc> <e0> <t0>
  local label="$1" rc="$2" e0="$3" t0="$4" sf row
  sf=$(mktemp) || capture_fail "$label" "mktemp failed"
  if ! node "$CLI" state --state "$STATE" > "$sf" 2>/dev/null; then rm -f "$sf"; capture_fail "$label" "\`pvm-client state\` exited non-zero"; fi
  if ! row=$(python3 - "$OUT/evidence" "$e0" "$label" "$rc" "$t0" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$sf" <<'PY'
import json, os, re, sys
d, e0, label, rc, t0, t1, sf = sys.argv[1:8]
ev = sorted(f for f in os.listdir(d) if re.fullmatch(r"evidence-\d{3}\.json", f)) if os.path.isdir(d) else []
st = json.load(open(sf))                       # malformed or empty: raises
s, g = st["state"], st["gen"]                  # missing: raises
hexfp = lambda x: isinstance(x, str) and re.fullmatch(r"[0-9a-f]{64}", x) is not None
assert isinstance(g, int) and g >= 1, f"gen {g!r}"
assert isinstance(s.get("serial"), int) and hexfp(s.get("policyFp")) and hexfp(s.get("releaseFp")), "incomplete state"
assert s.get("nextPolicyFp") is None or hexfp(s.get("nextPolicyFp")), "nextPolicyFp"
a = s.get("active")
assert a is None or (hexfp(a.get("sha256")) and isinstance(a.get("version"), str)), "active"
print(json.dumps({"label": label, "rc": int(rc), "utcStart": t0, "utcEnd": t1, "exchanges": [int(f[9:12]) for f in ev[int(e0):]],
                  "after": {"gen": g, "serial": s["serial"], "policyFp": s["policyFp"], "nextPolicyFp": s.get("nextPolicyFp"),
                            "releaseFp": s["releaseFp"], "active": a and {"version": a["version"], "sha256": a["sha256"]}}}))
PY
  ); then rm -f "$sf"; capture_fail "$label" "the committed state could not be read as a complete snapshot"; fi
  rm -f "$sf"
  printf '%s\n' "$row" >> "$OUT/exchanges.jsonl" || capture_fail "$label" "exchanges.jsonl could not be written"
}
cl() {
  local label="$1"; shift; local e0 t0 rc
  e0=$(ls "$OUT/evidence" 2>/dev/null | grep -c '^evidence-[0-9]*\.json$' || true); t0=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  # CL_TIMEOUT (seconds, optional): a call that does not end in time is killed -- exit 124 (or 137 after the grace), which
  # the caller classifies as a timeout, never as a pass
  ${CL_TIMEOUT:+timeout --kill-after=5 "$CL_TIMEOUT"} node "$CLI" "$@" --state "$STATE" --install-dir "$INSTALL" > "$OUT/$label.jsonl" 2> "$OUT/$label.err"; rc=$?; echo $rc > "$OUT/$label.rc"
  capture_row "$label" "$rc" "$e0" "$t0"
  python3 - "$OUT/$label.jsonl" "$label" "$rc" <<'PY' | tee -a "$OUT/run.log" || log "(the summary of $label could not be printed; its .jsonl is kept)"
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.startswith("{")]
last = lines[-1] if lines else {}
r = last.get("result") or last.get("update") or last.get("activate") or last
keep = ["complete", "status", "tokens", "firstTokenMs", "ms", "step", "refused", "policySerial", "clientVersion", "ok", "already", "version", "sha256", "gen", "found", "reasons", "error"]
print(json.dumps({"label": sys.argv[2], "rc": int(sys.argv[3]), **{k: r.get(k) for k in keep if k in r}})[:400])
PY
  return $rc
}
