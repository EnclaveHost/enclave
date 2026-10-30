#!/bin/bash
# Mutation check (queue 256), a1-a2-integration. PREPARED; root runs it (foreground) after run-tests.sh passed.
#  1. Inputs: SHA256SUMS must verify (the baseline and every mutant run on exactly these bytes; the sha of SHA256SUMS is logged).
#  2. Preflight (no test runs): exactly the 33 EXPECTED names, unique; every anchor matches its pristine file exactly once and
#     differs from its replacement; every Python mutant names >= 1 test.
#  3. Baseline ONCE, unmutated copy: test_a2a4 through mutrun.py all-pass (every test passes; count == 40 in a2-bytecode-integration, 0 errors/skips),
#     test_receipt_writer + test_pinned_manifest (rc 0, bare "OK"), node a1-gate suite clean per taplog.py. Every mapped test id
#     must be among the baseline's passing tests.
#  4. 25 Python mutants: run ONLY the mapped test(s) exercising that guard (mutrun.py kill): killed only if every mapped test ran
#     once and FAILED through assertions, with zero errors (fixture/import), skips, xfail or timeouts.
#  5. 8 JS mutants (a1gate/a1-gate.mjs copy): the full node suite (8 tests), killed only per taplog.py (same test count, every
#     failure ERR_ASSERTION). The Python suite is not used for JS mutants (it pins the module bytes: a trivial "kill").
# Every log is kept under a NEW logs/mutants/<UTC stamp>-<pid>/ (refuses to reuse). Exit 0 only if all 33 are killed.
set -u; H=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; rc=0
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}"
ip link set lo up 2>/dev/null || true
mkdir -p "$H/logs/mutants"; L=$H/logs/mutants/$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir "$L" || { echo "REFUSED: cannot create a new log dir $L"; exit 1; }
(cd "$H" && sha256sum -c SHA256SUMS && sha256sum SHA256SUMS) > "$L/inputs.check" 2>&1 || { echo "INPUTS DIFFER from SHA256SUMS (see $L/inputs.check)"; echo "MUTANTS rc=1"; exit 1; }
EXPECTED="merkle-from-n no-empty-read-check no-open-gaps no-a1-age no-journal-guard no-blake3-list-check no-checkpoints-flag no-final-profile-check no-exact-selection db-before-units no-v2-enforcement no-orphan-reap no-post-exit-size \
  no-recheck-sha no-initial-pin no-run-record no-trusted-owner follow-symlink no-release-binding accept-advanced-fresh no-run-window \
  no-l1-consistency no-gate-pin exit-bool-accepted no-same-run-dir \
  js-no-recheckof-sha js-accept-latest js-no-fresh js-no-codehash-compare js-loose-read-labels js-latest-n-as-n js-no-recheck-verdict js-no-initial-reads"
RAN=""
copy() { rm -rf "$T"/*; cp -r "$H/a2a4.py" "$H/selection.py" "$H/write_download_receipt.py" "$H/test" "$H/a1gate" "$T/"; }
nodesuite() { (cd "$T" && timeout 120 node --test --test-reporter=tap test/a1-gate.test.mjs </dev/null) > "$1" 2>&1; echo $? > "$1.rc"; }
okpy() { # <log> <rc>: rc 0 and the final unittest status line is a bare OK (no skips/xfail)
  [ "$2" = 0 ] && [ "$(grep -E '^(OK|FAILED)' "$1" | tail -n 1)" = OK ] && ! grep -qE '^(OK|FAILED) \(' "$1"; }
abort() { echo "$1"; echo "MUTANTS rc=1"; exit 1; }
# ---- preflight: names, anchors, mapping (parses the mut/jsmut lines of THIS script; runs no test) ----
python3 - "$H/$(basename "$0")" "$H" "$EXPECTED" > "$L/preflight.json" 2>&1 <<'PY' || abort "PREFLIGHT FAILED (see $L/preflight.json)"
import json, re, shlex, sys
script, h, expected = sys.argv[1], sys.argv[2], sys.argv[3].split()
text = open(script).read().replace('\\\n', ' ')
rows = [shlex.split(l) for l in text.splitlines() if re.match(r'^(mut|jsmut) ', l)]
src = {'mut': open(f'{h}/a2a4.py').read(), 'jsmut': open(f'{h}/a1gate/a1-gate.mjs').read()}
names = [r[1] for r in rows]
bad = [r[1] for r in rows if src[r[0]].count(r[2]) != 1 or r[2] == r[3]]
bad += [r[1] for r in rows if r[0] == 'mut' and len(r) < 5] + [r[1] for r in rows if r[0] == 'jsmut' and len(r) != 4]
ok = not bad and len(names) == 33 == len(set(names)) and sorted(names) == sorted(expected) and len(set(expected)) == 33
print(json.dumps({'ok': ok, 'bad': bad, 'count': len(names), 'mapping': {r[1]: r[4:] for r in rows if r[0] == 'mut'}}, indent=1))
sys.exit(0 if ok else 1)
PY
# ---- baseline ONCE ----
copy
(cd "$T" && timeout 1800 python3 -u "$H/mutrun.py" "$T" all-pass "$L/baseline-py.verdict.json" </dev/null) > "$L/baseline-py.log" 2>&1 \
  || abort "PYTHON BASELINE NOT CLEAN (see $L/baseline-py.log)"
python3 - "$L/baseline-py.verdict.json" "$L/preflight.json" <<'PY' || abort "BASELINE COUNT/MAPPING MISMATCH (expected 40 passing tests incl. every mapped id)"
import json, sys
v, m = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
ids = {i for t in m['mapping'].values() for i in t}
sys.exit(0 if v['verdict'] == 'baseline-clean' and v['testsRun'] == 40 and ids <= set(v['ran']) else 1)
PY
for s in test_receipt_writer test_pinned_manifest; do
  (cd "$T" && timeout 600 python3 -u "test/$s.py" </dev/null) > "$L/baseline-$s.log" 2>&1; r=$?
  okpy "$L/baseline-$s.log" $r || abort "BASELINE $s NOT CLEAN (rc=$r, see $L/baseline-$s.log)"
done
nodesuite "$L/baseline-node.tap"
python3 "$H/taplog.py" baseline "$L/baseline-node.tap" "$(cat "$L/baseline-node.tap.rc")" > "$L/baseline-node.verdict.json" \
  || abort "NODE BASELINE NOT CLEAN (see $L/baseline-node.tap)"
NT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tests"])' "$L/baseline-node.verdict.json")
[ "$NT" = 8 ] || abort "NODE BASELINE ran $NT tests, expected 8"
echo "baseline OK (python 40 + 2 + 1, node $NT)"
apply() { # <file> <from> <to>
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read(); assert s.count(a)==1 and a!=b; open(p,'w').write(s.replace(a,b))
PY
}
mut() { # <name> <from> <to> <test id>...: mutate the COPY of a2a4.py, run ONLY the mapped tests
  local n=$1 a=$2 b=$3; shift 3; RAN="$RAN $n"; copy
  apply "$T/a2a4.py" "$a" "$b" || { echo "MUTANT $n anchor not found"; rc=1; return; }
  (cd "$T" && timeout 900 python3 -u "$H/mutrun.py" "$T" kill "$L/$n.verdict.json" "$@" </dev/null) > "$L/$n.log" 2>&1; local r=$?
  if [ $r = 0 ] && python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["verdict"] != "killed")' "$L/$n.verdict.json"; then echo "mutant $n killed ($#)"
  else echo "MUTANT $n NOT killed (rc=$r; see $L/$n.verdict.json)"; rc=1; fi; }
jsmut() { # <name> <from> <to>: mutate the COPY of a1gate/a1-gate.mjs, run the full node suite only
  RAN="$RAN $1"; copy
  apply "$T/a1gate/a1-gate.mjs" "$2" "$3" || { echo "MUTANT $1 anchor not found"; rc=1; return; }
  nodesuite "$L/$1.tap"
  if python3 "$H/taplog.py" killed "$L/$1.tap" "$(cat "$L/$1.tap.rc")" "$NT" > "$L/$1.verdict.json"; then echo "mutant $1 killed"; else echo "MUTANT $1 $(cat "$L/$1.verdict.json")"; rc=1; fi; }
mut merkle-from-n "'--from', '0', '--to', str(c['N'])" "'--from', str(c['N']), '--to', str(c['N'])" \
  Gates.test_plan_ok_lists_chunked_unwind_to_exactly_n_and_full_merkle_from_zero
mut no-empty-read-check "        if not p.stdout.strip():" "        if False:" \
  Steps.test_a2_authenticates_the_real_header_and_refuses_forgery_or_missing
mut no-open-gaps "OPEN_GAPS = ['bytecodes-content-unverified']" "OPEN_GAPS = []" \
  Steps.test_bytecode_step_binds_this_db_and_release_still_refuses_while_the_gap_is_open
mut no-a1-age "    if age < 0 or age > c['a1MaxAgeSec']:" "    if False:" \
  Gates.test_stale_or_foreign_a1_is_refused FreshInitialTrust.test_the_real_live_initial_receipt_passes_only_while_fresh
mut no-journal-guard "    if j and (j[-1]['state'] != 'finished' or j[-1].get('rc') != 0):" "    if False:" \
  Gates.test_an_interrupted_mutation_blocks_every_later_step
mut no-blake3-list-check "        if not files or not all(" "        if False and not all(" \
  Gates.test_download_receipt_binds_manifest_unit_marker_and_datadir
mut no-checkpoints-flag "'--commit', '--checkpoints', '--skip-unwind'" "'--commit', '--skip-unwind'" \
  Steps.test_a4_full_rebuild_matches_and_a_mismatch_refuses
mut no-final-profile-check "    if not SEL.PROFILES[r['profile']]['final']:" "    if False:" \
  Gates.test_selection_is_exactly_the_pinned_manifest_and_final_profile
mut no-exact-selection "    if got != want:" "    if False:" \
  Gates.test_selection_is_exactly_the_pinned_manifest_and_final_profile
mut db-before-units "    g = {'stopped': gate_stopped(c)}" "    g = {}" \
  Gates.test_units_and_openers_are_checked_before_any_db_access
mut no-v2-enforcement "    if not g['storageV2']:" "    if False:" \
  Gates.test_units_and_openers_are_checked_before_any_db_access
mut no-orphan-reap "    stray = group_members(pg, exclude=(pg,))" "    stray = []" \
  Gates.test_post_exit_size_orphans_and_mutation_stdout
mut no-post-exit-size "        if not why and (out_p.stat().st_size > cap or err_p.stat().st_size > STDERR_CAP):" "        if False:" \
  Gates.test_post_exit_size_orphans_and_mutation_stdout
mut no-recheck-sha "    if hashlib.sha256(ev).hexdigest() != c['a1RecheckSha256']:" "    if False:" \
  Recheck.test_initial_receipt_pin_and_file_trust
mut no-initial-pin "        if c['a1InitialSha256'] != A1_INITIAL_SHA256:" "        if False:" \
  Recheck.test_initial_receipt_pin_and_file_trust
mut no-run-record "        gate_recheck_run(c, s)" "        pass" \
  Recheck.test_run_record_provenance
mut no-trusted-owner "        if not stat.S_ISREG(st.st_mode) or st.st_uid != TRUSTED_UID or st.st_mode & 0o022:" "        if False:" \
  FreshInitialTrust.test_a1_file_trust Recheck.test_initial_receipt_pin_and_file_trust
mut follow-symlink "os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC" "os.O_RDONLY | os.O_CLOEXEC" \
  FreshInitialTrust.test_a1_file_trust Recheck.test_initial_receipt_pin_and_file_trust
mut no-release-binding "    bind_a1(w, a1)  " "    pass  #" \
  Recheck.test_full_flow_binds_release_to_the_a2_receipt
mut accept-advanced-fresh "    if s['mode'] == 'fresh-initial' and int(s['N']) > c['N']:" "    if False:" \
  Gates.test_an_advanced_anchor_refuses_release_with_the_documented_code Recheck.test_the_original_game_passes_after_the_latest_anchor_advanced_and_n_never_moves
mut no-run-window "    if not _utc(r.get('startedAt'), 'run startedAt') <= _utc(s['at'], 'recheck at') <= _utc(r.get('finishedAt'), 'run finishedAt'):" "    if False:" \
  Recheck.test_run_record_provenance
mut no-l1-consistency "    if not l1['ageSec'] <= at.timestamp() - l1['timestamp'] <= l1['ageSec'] + A1_RUN_WINDOW_SEC:" "    if False:" \
  FreshInitialTrust.test_l1_timing_is_bounded_and_consistent Recheck.test_freshness_planned_anchor_and_mainnet_pins
mut no-gate-pin "            if hashlib.sha256(b).hexdigest() != want:" "            if False:" \
  FreshInitialTrust.test_gate_and_recheck_pins_match_the_files
mut exit-bool-accepted "type(r.get('recheckExit')) is not int or " "" \
  Recheck.test_run_record_provenance
mut no-same-run-dir " or os.path.realpath(ev.parent) != os.path.realpath(rp.parent)" "" \
  Recheck.test_run_record_provenance
jsmut js-no-recheckof-sha "if (ro.sha256 !== init.sha256 || " "if ("
jsmut js-accept-latest "if (la.accepted !== false) fail(" "if (false) fail("
jsmut js-no-fresh "if (r.l1.number <= init.l1.number || r.l1.hash === init.l1.hash) fail(" "if (false) fail("
jsmut js-no-codehash-compare "if (p.codeHash !== String(was.codeHash).toLowerCase() || " "if ("
jsmut js-loose-read-labels "if (r.reads[k] !== v) fail(" "if (false) fail("
jsmut js-latest-n-as-n "r.N !== init.N.toString() || r.outputRoot" "false || r.outputRoot"
jsmut js-no-recheck-verdict "r.verdict !== RECHECK_VERDICT)" "false)"
jsmut js-no-initial-reads 'if (e.reads[k] !== "helios-call") fail(' 'if (false) fail('
[ "$(echo $RAN | tr ' ' '\n' | sort -u | tr '\n' ' ')" = "$(echo $EXPECTED | tr ' ' '\n' | sort -u | tr '\n' ' ')" ] && [ "$(echo $RAN | wc -w)" = 33 ] \
  || { echo "MUTANT SET differs from EXPECTED"; rc=1; }
echo "logs: $L"; echo "MUTANTS rc=$rc"; exit $rc
