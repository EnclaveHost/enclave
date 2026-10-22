#!/bin/bash
# Go negative controls for B4 (queue 1024): each mutant of udpforward.go in a scratch copy of network/wg must FAIL the named test.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); S="$H/mut-go"; rm -rf "$S"; mkdir -p "$S"
export GOFLAGS=-mod=readonly GOPROXY=off CGO_ENABLED=0 GOMAXPROCS=2
rc=0
echo "== baseline (unmutated tree)"; (cd "$H/tree/network/wg" && go vet . && go test -count=1 -run 'UDPIngress' -v . 2>&1 | grep -E '^(--- |ok|FAIL)') || { echo "BASELINE FAILED"; exit 2; }
run(){ local name=$1 test=$2 py=$3
  rm -rf "$S/wg"; cp -r "$H/tree/network/wg" "$S/wg"
  python3 -c "$py" "$S/wg/udpforward.go" || { echo "NOT APPLIED $name"; rc=1; return; }
  if (cd "$S/wg" && go test -count=1 -run "^$test\$" . >"$S/out.txt" 2>&1); then echo "SURVIVED $name"; rc=1; else echo "KILLED   $name ($(grep -m1 -E 'udpforward_test.go:[0-9]+' "$S/out.txt" | head -c 160))"; fi; }
run "refuse new flows when full (the old behaviour)" TestUDPIngressFloodOfSendersCannotLockOutAQuery '
import sys;p=sys.argv[1];s=open(p).read();o="\t\t\tif len(r.flows) >= maxFlows {\n\t\t\t\tr.evictOldest()\n\t\t\t}\n"
assert s.count(o)==1;open(p,"w").write(s.replace(o,"\t\t\tif len(r.flows) >= maxFlows {\n\t\t\t\tr.mu.Unlock()\n\t\t\t\tcontinue\n\t\t\t}\n"))'
run "flow kept open after its answers" TestUDPIngressFlowEndsWithItsAnswer '
import sys;p=sys.argv[1];s=open(p).read();o="defer func() { r.mu.Lock(); r.drop(fl); r.mu.Unlock() }()"
assert s.count(o)==1;open(p,"w").write(s.replace(o,"defer func() {}()"))'
run "long answers not truncated" TestUDPIngressTruncatesLongAnswers '
import sys;p=sys.argv[1];s=open(p).read();o="if out := truncate(a, limit); size >= 12 && out != nil {"
assert s.count(o)==1;open(p,"w").write(s.replace(o,"if out := a; size >= 12 && out != nil {"))'
run "N1: flow ends at its first answer" TestUDPIngressTwoQueriesInFlightFromOneSender '
import sys;p=sys.argv[1];s=open(p).read();o="done := fl.answered >= fl.pending"
assert s.count(o)==1;open(p,"w").write(s.replace(o,"done := true"))'
run "P4: client payload size ignored (always the max)" TestUDPIngressHonoursTheClientPayloadSize '
import sys;p=sys.argv[1];s=open(p).read();o="func queryLimit(q []byte, max int) int {\n"
assert s.count(o)==1;open(p,"w").write(s.replace(o,o+"\treturn max\n"))'
run "no idle expiry of unanswered flows" TestUDPIngressFlowEndsWithItsAnswer '
import sys;p=sys.argv[1];s=open(p).read();o="if now-fl.last.Load() > int64(idle) {"
assert s.count(o)==1;open(p,"w").write(s.replace(o,"if false && now-fl.last.Load() > int64(idle) {"))'
rm -rf "$S"; echo "GO-MUT-RC=$rc"; exit $rc
