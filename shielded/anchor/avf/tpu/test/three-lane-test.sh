#!/usr/bin/env bash
# three-lane-test.sh -- the merge report must refuse to invent a comparison.
#
# Same failure classes that produced wrong numbers in the two single-lane paths, now checked at the
# point where three lanes meet: guessing which artifact is which row, scoring only the rows present,
# and silently comparing two runs that did not ask the same questions.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
R="$HERE/host/three-lane-report.py"
[ -f "$R" ] || { echo "FAIL: no host/three-lane-report.py under $HERE"; exit 1; }
pass=0; fail=0
has() { if grep -qF "$2" <<<"$1"; then printf '  ok   %s\n' "$3"; pass=$((pass+1));
        else printf '  FAIL %s (missing %q)\n' "$3" "$2"; fail=$((fail+1)); fi; }
hasnt() { if grep -qF "$2" <<<"$1"; then printf '  FAIL %s (found %q, should not be there)\n' "$3" "$2"; fail=$((fail+1));
          else printf '  ok   %s\n' "$3"; pass=$((pass+1)); fi; }
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s\n       want %s got %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
P="$W/prompts.txt"
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' >  "$P"
printf 'What is the capital of France? Reply with only the city name.\texact=Paris\n' >> "$P"

# builders -------------------------------------------------------------------------------------
vmlog() {  # vmlog <dir> <id> <key> <arm> <status> <answer>
  printf 'status=%s\nLOCAL turn 1 A: %s\nLOCAL done\n' "$5" "$6" > "$1/$2.$3.$4.log"; }
mk_masked() {                       # mk_masked <dir> <expect_rows>
  mkdir -p "$1"; { printf '# expect_rows\t%s\n' "$2"; printf '# id\tkey\ttpu\tcpu\tprompt\texpect\n'; } > "$1/MANIFEST.tsv"; }
m_row() {                           # m_row <dir> <id> <key> <st_tpu> <st_cpu> <prompt> <expect>
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" "$6" "$7" >> "$1/MANIFEST.tsv"; }
mk_google() { mkdir -p "$1"; { printf '# expect_rows\t%s\n' "$2"; printf '# id\tkey\tnpu\tprompt\texpect\n'; } > "$1/MANIFEST.tsv"; }
g_row() { printf '%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" "$6" >> "$1/MANIFEST.tsv"; }
rpt() { python3 "$R" "$W/m" "$W/g" "$P" 2>&1; }

fresh() {
  rm -rf "$W/m" "$W/g"; mk_masked "$W/m" 2; mk_google "$W/g" 2
  m_row "$W/m" 01 k1 ok ok "What is 17 times 23? Reply with only the number." "numeric=391"
  m_row "$W/m" 02 k2 ok ok "What is the capital of France? Reply with only the city name." "exact=Paris"
  g_row "$W/g" 01 j1 ok "What is 17 times 23? Reply with only the number." "numeric=391"
  g_row "$W/g" 02 j2 ok "What is the capital of France? Reply with only the city name." "exact=Paris"
  vmlog "$W/m" 01 k1 tpu eos 391; vmlog "$W/m" 01 k1 cpu eos 391
  vmlog "$W/m" 02 k2 tpu eos Paris; vmlog "$W/m" 02 k2 cpu eos Paris
  printf '391\n' > "$W/g/01.j1.txt"; printf 'Paris\n' > "$W/g/02.j2.txt"
}

echo "== all three lanes correct =="
fresh; OUT=$(rpt)
has "$OUT" "masked TPU 2/2" "masked scored 2/2"
has "$OUT" "in-VM CPU 2/2"  "cpu scored 2/2"
has "$OUT" "Google NPU 2/2" "npu scored 2/2"

echo "== a wrong answer on ONE lane is not carried by the others =="
fresh; printf 'status=eos\nLOCAL turn 1 A: 0\nLOCAL done\n' > "$W/m/01.k1.tpu.log"; OUT=$(rpt)
has "$OUT" "masked TPU 1/2" "masked drops to 1/2"
has "$OUT" "in-VM CPU 2/2"  "cpu unaffected"
has "$OUT" "Google NPU 2/2" "npu unaffected"

echo "== a run cut short cannot shrink the denominator =="
fresh; grep -v '^02' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "out of 2 declared prompts" "denominator stays at the declared count"
has "$OUT" "masked TPU 1/2" "the row the run never reached is a failure"
# The two assertions above are satisfied by the DENOMINATOR alone (n comes from expect_rows), so they
# pass even if the missing row is dropped from the table. What the fill actually does is make the row
# VISIBLE with a reason, and that is what this checks.
has "$OUT" "the run did not reach it" "the missing row appears in the table, with a reason"

echo "== a malformed manifest row is a failure, not a skip =="
fresh; printf '02\tk2\tok\n' >> "$W/m/MANIFEST.tsv"
grep -vP '^02\tk2\tok\tok' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "masked TPU 1/2" "the malformed row scores as a failure"
has "$OUT" "malformed manifest row" "and is shown as malformed rather than dropped"

echo "== a row missing on ONE lane does not degrade the others =="
fresh; grep -v '^02' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "Google NPU 2/2" "google still scores its complete run"
has "$OUT" "masked TPU 1/2"  "  while the short masked run loses that row"
# the defect: the placeholder text of a missing row matched no spec, so the OTHER lane's good answer
# was scored against an empty contract and came back REVIEW
hasnt "$OUT" "Google NPU 1/2" "  and google is not dragged down with it"

echo "== the denominator comes from the DECLARED count, not from the rows present =="
fresh; grep -v '^02' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"
grep -v '^02' "$W/g/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/g/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "Google NPU 1/2" "a short google manifest still scores out of 2, not out of 1"

echo "== two runs that asked different things are refused =="
fresh; sed -i 's/What is the capital of France? Reply with only the city name./What is the capital of Japan? Reply with only the city name./' "$W/g/MANIFEST.tsv"
OUT=$(rpt); rc=$?
has "$OUT" "asks different things" "a prompt mismatch at the same id is refused"

echo "== runs that agree with EACH OTHER but not with the prompts file are refused =="
# The reported false PASS: both manifests ask "2 plus 2" under numeric=4, every reply is 391, and the
# prompts file's row 01 is "17 times 23" under numeric=391. Scoring by ordinal alone printed PASS on all
# three lanes beside a question the replies never answered.
fresh
sed -i 's/What is 17 times 23? Reply with only the number.\tnumeric=391/What is 2 plus 2? Reply with only the number.\tnumeric=4/' "$W/m/MANIFEST.tsv" "$W/g/MANIFEST.tsv"
OUT=$(rpt); rc=$?
ck  "a manifest asking a different question than the prompts file is refused" "$rc" 1
has "$OUT" "cannot be scored against a question it was not asked" "  and says why"
hasnt "$OUT" "PASS" "  and scores nothing"

echo "== the same question under a different contract is refused =="
fresh; sed -i 's/numeric=391/numeric=392/' "$W/m/MANIFEST.tsv"
OUT=$(rpt); rc=$?
ck  "a manifest produced under a different contract is refused" "$rc" 1
has "$OUT" "produced under the contract" "  and names both contracts"

echo "== a real row with a BLANK recorded contract is refused, not waved through =="
# The check read `if r["expect"] and r["expect"] != contract`, so an empty recorded contract skipped it
# and the row was scored against the prompts file's contract anyway: rc 0, PASS on every lane.
fresh; sed -i 's/\tnumeric=391$/\t/' "$W/m/MANIFEST.tsv" "$W/g/MANIFEST.tsv"
OUT=$(rpt); rc=$?
ck  "a blank recorded contract against a non-empty canonical one is refused" "$rc" 1
has "$OUT" "produced under the contract ''" "  and shows the empty contract it refused"
hasnt "$OUT" "PASS" "  and scores nothing"
# and a missing row (no manifest line at all) is still scored as a failure, not refused
fresh; grep -v '^02' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"; OUT=$(rpt); rc=$?
ck  "a MISSING row is still scored, not refused" "$rc" 0
has "$OUT" "masked TPU 1/2" "  as a failure against the canonical contract"

echo "== a declared count that differs from the prompts file is refused =="
fresh; sed -i 's/^# expect_rows\t2$/# expect_rows\t3/' "$W/m/MANIFEST.tsv" "$W/g/MANIFEST.tsv"
OUT=$(rpt); rc=$?
ck  "runs declaring 3 rows against a 2-prompt file are refused" "$rc" 1
has "$OUT" "were not produced from it" "  and says so"

echo "== row ids must bind to exactly one question =="
for bad in "1" "03" "xx"; do
  fresh; sed -i "s/^01\tk1\t/$bad\tk1\t/" "$W/m/MANIFEST.tsv"
  OUT=$(rpt); rc=$?
  ck "row id '$bad' is refused, not bound by position" "$rc" 1
  # a traceback also exits 1; a REFUSAL says what it refused. Without this the '03' and 'xx' cases
  # passed against a report with no id validation at all, because it crashed instead.
  has "$OUT" "cannot be bound to a question" "  refused by the id check, not by a crash"
  hasnt "$OUT" "Traceback" "  and without a traceback"
done
fresh; printf '02\tk2\tok\tok\tWhat is the capital of France? Reply with only the city name.\texact=Paris\n' >> "$W/m/MANIFEST.tsv"
OUT=$(rpt); rc=$?
ck  "a duplicate row id is refused" "$rc" 1
has "$OUT" "twice" "  and says which row"

echo "== mismatched declared counts are refused =="
fresh; sed -i 's/^# expect_rows\t2$/# expect_rows\t3/' "$W/g/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "different row counts" "different expect_rows is refused"

echo "== a directory with no manifest is refused =="
fresh; rm -f "$W/g/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "no MANIFEST.tsv" "a missing manifest is refused"
fresh; grep -v '^# expect_rows' "$W/m/MANIFEST.tsv" > "$W/t" && mv "$W/t" "$W/m/MANIFEST.tsv"; OUT=$(rpt)
has "$OUT" "declares no expect_rows" "a manifest with no declared count is refused"

echo "== a truncated masked reply is a failure, and the asymmetry is reported =="
fresh; printf 'status=budget\nLOCAL turn 1 A: 391\nLOCAL done\n' > "$W/m/01.k1.tpu.log"; OUT=$(rpt)
has "$OUT" "masked TPU 1/2" "a budget-capped reply is not a completed task"
has "$OUT" "Google NPU 2/2" "and Google's uncapped lane still scores it"
has "$OUT" "UNCAPPED" "the report states the cap asymmetry rather than hiding it"

echo
echo "three-lane-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
