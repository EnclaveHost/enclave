#!/bin/bash
# v3 (Claude 1615; NOT run by Claude) = v2 (1607) with ONLY the supervisor's test manifest/log changed: cold-scan-v3 (the v2 test fixture
# failed on ESRCH; the supervisor is byte-identical, d57de0b0...) and logs/root-cold-scan-v3-tests. v2 and v1 are kept as evidence.
# v2 (Claude 1607) of run-read-only-cold-scan.sh (1595, kept unchanged as evidence). READ-ONLY root writer-check of the
# frozen nvme-cold-relocation-stage/r10. Changes vs v1 (logs/claude-cold-handoff-v2-1607.md):
#   - sudo authenticates FIRST in the foreground on the terminal (sudo -v, nothing redirected or logged), then the reviewed command runs
#     with sudo -n (never prompts) and only its stdout/stderr are redirected;
#   - the root scan runs under a pinned, privately staged ROOT SUPERVISOR inside the same 1 GiB scope: it stops its own child process
#     group on MemAvailable < 16 GiB, after 3600 s, or when this script's lane heartbeat stops (queue placeholder lost);
#   - the gate is clean only if root rc = 0 AND the lane was held throughout (plus every v1 condition);
#   - result validation fixed (r10 nsCopies is an int; any malformed shape is "no valid result", never a traceback);
#   - no pkill: only this script's own background processes are ever signalled.
# The USER runs this in a terminal, as uid 1000, and types their own sudo password (once, read by sudo itself):
#   bash /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/run-read-only-cold-scan-v3.sh
# It runs NOTHING privileged unless every preflight holds:
#   - the r10 stage SUMS is exactly 2342e677... and every file matches it;
#   - root's 61-test run (logs/root-cold-r10-tests-1582.*) finished rc 0 with 22 + 39 tests, OK, nothing skipped or failed;
#   - the production config is exactly the reviewed logs/cold-subtree-production-1530.json bytes;
#   - the cold-scan-v3 SHA256SUMS and the supervisor are their pinned hashes, and root's supervisor tests passed against them.
# Privileged part: ONLY the root body below (the r10 README literal + one staged, pinned supervisor file). Root stages the four
# pinned files into a new private /run/nvme-cold-wc10.* dir (removed by its own trap), runs the read-only scan under the supervisor in
# a 1 GiB system scope and writes JSON to stdout. Root writes no journal and no user file; the redirects are opened by THIS (owner) shell.
# NOT done here: record-writer-check, cut-over, rollback, reclaim, delete, app or watcher stop, USB, any journal write.
# Memory: the shared queue's main 1024 MiB lane is HELD by an unprivileged placeholder while sudo runs in the foreground
# (the queue runs its child in a new session without a terminal, so a sudo password prompt cannot run inside it).
# The 16 GiB floor is not weakened: queue admission needs 16384+1024+256 MiB; the supervisor and root-writer-check.sh refuse below
# 17408 MiB at start, and the supervisor stops the scan whenever MemAvailable < 16384 MiB while it runs.
# Exit: 0 valid r10 result AND the manual gate is clean; 3 valid result but NOT clean (kept); 4 no valid result (kept);
#       9 refused before any sudo. A 0 is never "cut-over approved": a scan is stale for cut-over after 120 s and is not recorded.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin LC_ALL=C
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/nvme-cold-relocation-stage/r10
STAGE_SUMS=2342e677be1e000df07928238b74fe9e0688cd69ffa6bab0c79d0250ac094991
CONFIG=$P/logs/cold-subtree-production-1530.json
CONFIG_SHA=bae6021bcf7d2d8ecbd702d62e5881d787f378c2a08b2c5f16b4e9e7ce95879f
T=$P/logs/root-cold-r10-tests-1582
OUTD=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025
SUBTREE_SHA=90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3
RELOCATE_SHA=2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0
JOB_SHA=7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635
HOLD_MAX_SEC=7200
V=$OUTD/cold-scan-v3
V_SUMS=6a4fda7edab4be6c52c2177a6ef1852ce65ebbceea689c3c43efcb6fe42e8aac
SUP_SHA=d57de0b0c6098342c0ff4fbbc5de4b81fd342c1110a10a740186df04825c7774
TT=$P/logs/root-cold-scan-v3-tests
refuse() { echo "REFUSED (nothing privileged was run): $*" >&2; exit 9; }

# ---- 0. who and where
[ "$(id -u)" = 1000 ] || refuse "run as the owner (uid 1000), not root and not via sudo"
[ -t 0 ] && [ -t 2 ] || refuse "run in an interactive terminal (your sudo password is read from it)"
[ -d "$OUTD" ] && [ ! -L "$OUTD" ] && [ "$(stat -c %u "$OUTD")" = 1000 ] || refuse "$OUTD is not your directory"

# ---- 1. the frozen stage and the reviewed config
[ "$(sha256sum < $S/SHA256SUMS | cut -c1-64)" = $STAGE_SUMS ] || refuse "r10 SHA256SUMS is not $STAGE_SUMS"
(cd $S && sha256sum -c --quiet SHA256SUMS) || refuse "r10 files differ from SHA256SUMS"
printf '%s  %s\n' $SUBTREE_SHA $S/subtree.py $RELOCATE_SHA $S/relocate.py $JOB_SHA $S/jobs/root-writer-check.sh | sha256sum -c --quiet - \
  || refuse "an r10 tool file is not its pinned sha256"
[ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] && [ "$(stat -c '%u %a' "$CONFIG")" = "1000 600" ] || refuse "config must be your own regular 0600 file"
[ "$(sha256sum < "$CONFIG" | cut -c1-64)" = $CONFIG_SHA ] || refuse "config is not the reviewed cold-subtree-production-1530.json ($CONFIG_SHA)"

# ---- 2. root's 61-test PASS (1582): rc 0, exact counts, OK, nothing skipped/failed, in the LAST queued attempt
[ -f $T.rc ] && [ "$(cat $T.rc)" = 0 ] || refuse "root's test run 1582 has not finished with rc 0 ($T.rc)"
[ -f $T.out ] || refuse "no 1582 log $T.out"
LAST=$(awk '/^\[queue\] START /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' $T.out)
for must in '^\[queue\] START ' '^Ran 22 tests' '^Ran 39 tests' '^## test_relocate PASS \(22\)$' '^## test_subtree PASS \(39\)$' '^## cold-r10 rc=0$' '^\[queue\] EXIT 0$'; do
  grep -Eq "$must" <<<"$LAST" || refuse "1582 log lacks: $must"
done
! grep -Eiq 'FAIL|skipped|STOPPED|ERROR|changed' <<<"$LAST" || refuse "1582 log reports a failure, skip, stop or a changed stage"
RUN=$(ls -1d $S/runs/run-* 2>/dev/null | LC_ALL=C sort | tail -1 || true)
[ -n "$RUN" ] || refuse "no r10 test run directory under $S/runs"
for t in test_relocate:22 test_subtree:39; do n=${t%%:*}; want=${t#*:}
  grep -q "^Ran $want tests" $RUN/$n.txt && [ "$(tail -1 $RUN/$n.txt)" = OK ] && ! grep -qi skipped $RUN/$n.txt || refuse "$RUN/$n.txt is not $want tests OK without skips"
done

# ---- 2b. the pinned supervisor and root's PASS of its unprivileged tests, against exactly these bytes
[ -d "$V" ] && [ ! -L "$V" ] || refuse "$V is missing"
[ "$(sha256sum < $V/SHA256SUMS | cut -c1-64)" = $V_SUMS ] && (cd $V && sha256sum -c --quiet SHA256SUMS) || refuse "cold-scan-v3 files are not SHA256SUMS $V_SUMS"
printf '%s  %s\n' $SUP_SHA $V/root_scan_supervisor.py | sha256sum -c --quiet - || refuse "the supervisor is not its pinned sha256"
[ -f $TT.rc ] && [ "$(cat $TT.rc)" = 0 ] && [ -f $TT.out ] || refuse "root's supervisor tests ($TT) have not finished with rc 0"
LASTV=$(awk '/^\[queue\] START /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' $TT.out)
for must in '^\[queue\] START ' "^## verified SHA256SUMS $V_SUMS\$" '^Ran 8 tests' '^OK$' '^## cold-scan-v3-tests rc=0$' '^\[queue\] EXIT 0$'; do
  grep -Eq "$must" <<<"$LASTV" || refuse "supervisor test log lacks: $must"
done
! grep -Eq '^(FAIL|ERROR)|skipped|changed during' <<<"$LASTV" || refuse "supervisor test log reports a failure"

# ---- 3. the root body: the r10 README literal's staging + sha check, plus the pinned supervisor (reviewed in 1607)
BODY=$(cat <<'ROOTBODY'
set -euo pipefail; umask 077
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r10
V=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/cold-scan-v3
W=$(mktemp -d /run/nvme-cold-wc10.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"
for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none; done
timeout 20 dd if="$V/root_scan_supervisor.py" of="$W/root_scan_supervisor.py" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none
printf "%s  %s\n" 7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635 "$W/jobs/root-writer-check.sh" 90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3 "$W/subtree.py" 2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 "$W/relocate.py" d57de0b0c6098342c0ff4fbbc5de4b81fd342c1110a10a740186df04825c7774 "$W/root_scan_supervisor.py" | sha256sum -c --quiet -
/usr/bin/python3 -I -B "$W/root_scan_supervisor.py" "$W" "$1" "$2"
ROOTBODY
)
README_BLOCK=$(awk '/<!-- r10-root-wrapper -->/{f=1;next} f&&/^```bash$/{g=1;next} g&&/^```$/{exit} g' $S/README.md)
for line in 'W=$(mktemp -d /run/nvme-cold-wc10.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"' \
            'for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none; done'; do
  grep -qxF -- "$line" <<<"$README_BLOCK" && grep -qxF -- "$line" <<<"$BODY" || refuse "the root body no longer shares the frozen README staging line"
done

# ---- 4. private run dir (owner), kernel-held users metadata (UNPRIVILEGED: sysfs + /proc/swaps are world-readable)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -m 0700 "$OUTD/cold-scan-runs"; [ ! -L "$OUTD/cold-scan-runs" ] || refuse "cold-scan-runs is a symlink"
O=$OUTD/cold-scan-runs/run-v3-$STAMP-$$; mkdir -m 0700 "$O"
kernel_users() {   # G4 record: loop backing files and swap files, before and after the scan (no root, no new program)
  { echo "# $(date -u +%FT%TZ) losetup --list (unprivileged; sysfs backing_file)"; losetup --list --noheadings --raw --output NAME,BACK-FILE,RO,AUTOCLEAR 2>&1 || echo "losetup rc=$?"
    echo "# /proc/swaps"; cat /proc/swaps 2>&1 || true; } > "$O/kernel-users-$1.txt"
}
kernel_users before

# ---- 5. hold the shared queue's main 1024 MiB lane (unprivileged placeholder); a heartbeat proves it to the root supervisor
ADM=$O/lane.admitted; REL=$O/lane.hold; HB=$O/lane.heartbeat; : > "$REL"
HOLD=cold-scan-hold-$STAMP-$$
bash $P/jobs/q-exit-status.sh "$HOLD" 1024 bash -c 'echo "$$ $(date -u +%FT%TZ)" > "$1"; end=$((SECONDS + $3)); while [ -e "$2" ] && [ $SECONDS -lt $end ]; do sleep 1; done' \
  cold-scan-hold "$ADM" "$REL" "$HOLD_MAX_SEC" < /dev/null > /dev/null 2>&1 &
QPID=$!; WPID=
cleanup() { rm -f "$REL"; [ -z "$WPID" ] || kill "$WPID" 2>/dev/null || true; }   # only our own watcher; the placeholder ends on its own
trap cleanup EXIT
echo "waiting for the shared queue's 1024 MiB lane (log: $P/logs/$HOLD.out) ..." >&2
while [ ! -s "$ADM" ]; do
  kill -0 $QPID 2>/dev/null || { echo "REFUSED (nothing privileged was run): the queue did not admit the lane (rc $(cat $P/logs/$HOLD.rc 2>/dev/null))" >&2; exit 9; }
  sleep 2
done
INNER=$(awk 'NR==1{print $1}' "$ADM")
[[ "$INNER" =~ ^[1-9][0-9]*$ ]] && kill -0 "$INNER" 2>/dev/null || refuse "the lane placeholder is not running"
# the heartbeat is touched ONLY while the queue wrapper and its admitted placeholder both live and the hold is wanted
: > "$HB"
( while [ -e "$REL" ] && kill -0 $QPID 2>/dev/null && kill -0 "$INNER" 2>/dev/null; do touch "$HB"; sleep 1; done
  [ ! -e "$REL" ] || : > "$O/lane.lost" ) &
WPID=$!
echo "lane held. sudo now asks for your password on this terminal (read by sudo itself, never logged)." >&2
echo "The root command is ONLY the reviewed body: stage + verify four pinned files, run the read-only scan under its supervisor." >&2
/usr/bin/sudo -v || refuse "sudo authentication was not completed"
AV=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
[ "$AV" -ge $((16384 + 1024)) ] || { /usr/bin/sudo -k || true; refuse "MemAvailable ${AV} MiB < 16384 floor + 1024 scan cap (after admission)"; }
[ ! -e "$O/lane.lost" ] && kill -0 "$WPID" 2>/dev/null || { /usr/bin/sudo -k || true; refuse "the lane was lost before the scan"; }
cd /
date -u +%FT%TZ > "$O/sudo-start.txt"
set +e
/usr/bin/sudo -n systemd-run --scope --quiet -p MemoryMax=1G -p MemorySwapMax=0 -- bash -c "$BODY" nvme-cold-wc10 "$CONFIG" "$HB" \
  < /dev/null > "$O/scan.json.partial" 2> "$O/scan.stderr"
SRC=$?
set -e
date -u +%FT%TZ > "$O/sudo-end.txt"; echo $SRC > "$O/root-rc.txt"
if [ ! -e "$O/lane.lost" ] && kill -0 "$WPID" 2>/dev/null && kill -0 $QPID 2>/dev/null; then LANE=held-throughout; else LANE=LOST-before-scan-end; fi
/usr/bin/sudo -k || true                                   # drop the cached sudo credential (asks nothing)
rm -f "$REL"; wait "$WPID" 2>/dev/null || true; WPID=; wait $QPID 2>/dev/null || true; trap - EXIT
echo "$LANE (holder rc $(cat $P/logs/$HOLD.rc 2>/dev/null))" > "$O/lane.txt"
kernel_users after

# ---- 6. owner-side validation and summary (unprivileged; reads only this run dir; writes summary.json atomically)
set +e
python3 -I -B - "$O" "$SRC" "$LANE" "$CONFIG" $SUBTREE_SHA $RELOCATE_SHA $JOB_SHA <<'PY'
import json, os, sys
O, src, lane, cfgp, sub, rel, job = sys.argv[1], int(sys.argv[2]), sys.argv[3], *sys.argv[4:8]
KEYS = {"format", "t", "tEnd", "euid", "tools", "prefixes", "targets", "hits", "hitsTotal", "aliases", "destAliases", "nsCopies",
        "fsWatchers", "incomplete", "entries", "complete", "scan", "limitations"}
num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
cfg = json.load(open(cfgp)); out = {"rootRc": src, "lane": lane, "problems": []}; res = None
STOPPED = {70: "supervisor: MemAvailable below the 16 GiB floor", 71: "supervisor: timeout", 72: "supervisor: lane heartbeat lost", 73: "supervisor: signalled"}
if src in STOPPED: out["problems"].append(STOPPED[src])
try:
    p = os.path.join(O, "scan.json.partial"); size = os.lstat(p).st_size
    if size == 0 or size > 64 << 20: raise ValueError(f"result size {size}")
    res = json.load(open(p))
    if not isinstance(res, dict) or set(res) != KEYS: raise ValueError("not exactly the 18 r10 result keys")
    if res["format"] != "nvme-cold-subtree-writer-check/r10": raise ValueError(f"format {res['format']!r}")
    if res["euid"] != 0: raise ValueError("euid is not 0")
    if res["tools"] != {"subtree.py": sub, "relocate.py": rel, "jobs/root-writer-check.sh": job}: raise ValueError("tool shas are not the three pins")
    if not all(isinstance(res[k], list) for k in ("hits", "aliases", "destAliases", "fsWatchers", "incomplete", "targets", "prefixes")) \
       or not all(isinstance(x, dict) for k in ("hits", "aliases", "destAliases", "fsWatchers", "targets") for x in res[k]) \
       or not isinstance(res["complete"], bool) or not isinstance(res["hitsTotal"], int) or isinstance(res["hitsTotal"], bool) \
       or not isinstance(res["nsCopies"], int) or not num(res["t"]) or not num(res["tEnd"]) or not isinstance(res["scan"], dict):
        raise ValueError("malformed fields")
    if res["complete"] != (res["incomplete"] == []): raise ValueError("complete disagrees with incomplete")
    if res["hitsTotal"] < len(res["hits"]): raise ValueError("hitsTotal below the listed hits")
    if not res["tEnd"] >= res["t"]: raise ValueError("tEnd < t")
    want = {cfg["archive_root"] + "/" + r for r in cfg["subtrees"]}
    if not want <= set(res["prefixes"]): raise ValueError("prefixes do not name every configured source subtree")
except Exception as e:                                       # any shape problem is "no valid result", never a traceback
    out["problems"].append(f"no valid r10 result: {type(e).__name__}: {str(e)[:200]}"); res = None
if res is not None:
    walked = {t.get("subtree"): t for t in res["targets"] if t.get("class") == "source"}
    missing = [r for r in cfg["subtrees"] if not (walked.get(r, {}).get("state") == "dir" and walked[r].get("entries", 0) > 0)]
    out.update(valid=True, complete=res["complete"], hitsTotal=res["hitsTotal"], aliases=len(res["aliases"]), destAliases=len(res["destAliases"]),
               fsWatchers=len(res["fsWatchers"]), nsCopies=res["nsCopies"], incomplete=len(res["incomplete"]), incompleteFirst=res["incomplete"][:20],
               hitsFirst=res["hits"][:20], aliasesFirst=res["aliases"][:5], destAliasesFirst=res["destAliases"][:5], fsWatchersFirst=res["fsWatchers"][:5],
               sourceSubtreesNotWalked=missing, durationSec=round(res["tEnd"] - res["t"], 1), scanStats=res["scan"],
               targets=[[t.get("class"), t.get("subtree"), t.get("state"), t.get("entries")] for t in res["targets"]])
    out["manualGateClean"] = (src == 0 and lane == "held-throughout" and res["complete"] and res["hitsTotal"] == 0 and not res["hits"]
                              and not res["aliases"] and not res["destAliases"] and not res["fsWatchers"] and not missing)
    if src != 0: out["problems"].append(f"root rc {src}: not clean")
    if lane != "held-throughout": out["problems"].append(f"lane {lane}: not clean")
else:
    out.update(valid=False, manualGateClean=False)
out["note"] = ("READ-ONLY scan record. NOT recorded (no record-writer-check), NOT cut-over approval: cut-over needs root's review, "
               "a fresh (<=120 s) recorded scan and root 1588's stronger manual gate.")
tmp = os.path.join(O, "summary.json.tmp"); open(tmp, "w").write(json.dumps(out, indent=1) + "\n"); os.replace(tmp, os.path.join(O, "summary.json"))
print(json.dumps({k: out.get(k) for k in ("valid", "rootRc", "lane", "complete", "hitsTotal", "aliases", "destAliases", "fsWatchers", "incomplete",
                                          "sourceSubtreesNotWalked", "durationSec", "manualGateClean", "problems")}, indent=1))
sys.exit(0 if out["manualGateClean"] else 3 if out.get("valid") else 4)
PY
VRC=$?
set -e
if [ $VRC = 4 ]; then mv "$O/scan.json.partial" "$O/refused-scan.json"; else mv "$O/scan.json.partial" "$O/scan.json"; fi
echo "outputs (0600, private): $O   root rc=$SRC  lane=$LANE  exit=$VRC" >&2
[ $VRC = 0 ] && echo "manual gate CLEAN for this moment only; nothing was recorded or cut over. Hand $O to root." >&2
[ $VRC = 3 ] && echo "NOT clean (root rc, lane, incomplete, users, aliases, destAliases or watchers): kept for root's review. Nothing was changed." >&2
[ $VRC = 4 ] && echo "no valid r10 result: stderr kept in $O/scan.stderr for root's review. Nothing was changed." >&2
exit $VRC
