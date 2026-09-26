#!/bin/sh
# The NucBox domain's RUNTIME vs FRONT model (enclave-87's ruling on enclave-bf's finding), checked for real: domexec,
# built static, runs as PID 1 in an unprivileged user namespace (--map-auto), chrooted into an m3-shaped root, with /run
# as the monitor now leaves it (monitor.start: the FRONT's uid, 0700) and a stand-in for the report socket bind-mounted
# there (/run/monitor.sock, 0666, as the monitor makes it). m3/frontuid-probe.c stands in for both workloads:
#   the front (uid 1001) creates /run/front.sock and reaches the report socket;
#   the runtime (uid 1000) can NOT list /run, reach the report socket, remove or replace the front's socket, signal the
#   front, or open its /proc entries.
# Controls: domexec REFUSES a shared uid (1000:1000); and with /run given to the runtime's uid (the v42 layout) the
# runtime's refusals FAIL, so the probe does see the old condition. Mutants of domexec.c, each of which must fail: the
# front spawned as the runtime's uid, and the shared-uid refusal removed.
#
# usage: test-domexec-frontuid.sh   (needs gcc, python3, and unshare --map-auto with a subuid range; else SKIPPED)
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$(cd "$here/../m2" && pwd)
d=$(mktemp -d)
trap 'reclaim; rm -rf "$d"' EXIT
# /run ends up owned by the mapped front uid (0700), which the outer user cannot remove: a fresh user namespace with the
# same --map-auto mapping gives it back to root first
reclaim() { [ -d "$d/root/run" ] && unshare --map-root-user --map-auto sh -c "chown -R 0:0 '$d/root/run'; chmod -R u+rwx '$d/root/run'" 2>/dev/null; rm -rf "$d/root"; }
chmod 0755 "$d"
if ! command -v unshare >/dev/null 2>&1 || ! unshare --map-root-user --map-auto -U true 2>/dev/null; then
  echo "domexec front uid: SKIPPED, no unshare --map-auto here"; exit 0
fi
gcc -static -O2 -o "$d/probe" "$here/frontuid-probe.c" 2>/dev/null

# one domexec run; <run-owner> is who /run belongs to (1001: the monitor now; 1000: the v42 layout); <uids> domexec's arg
run_one() {  # <domexec binary> <run-owner> <uids>
  reclaim; mkdir -p "$d/root/plat/rt" "$d/root/run" "$d/root/tmp" "$d/root/proc" "$d/root/probe-out"
  chmod 0755 "$d/root" "$d/root/plat" "$d/root/plat/rt"; chmod 1777 "$d/root/probe-out"
  cp "$1" "$d/root/plat/domexec"; cp "$d/probe" "$d/root/plat/rt/ld-linux-x86-64.so.2"; cp "$d/probe" "$d/root/plat/front"
  chmod 0755 "$d/root/plat/domexec" "$d/root/plat/rt/ld-linux-x86-64.so.2" "$d/root/plat/front"
  timeout 60 unshare --map-root-user --map-auto -mpfn -- sh -c "
    python3 -c \"import socket,os,time; s=socket.socket(socket.AF_UNIX); s.bind('$d/root/run/monitor.sock'); os.chmod('$d/root/run/monitor.sock',0o666); s.listen(8); time.sleep(15)\" &
    for i in \$(seq 1 50); do [ -S '$d/root/run/monitor.sock' ] && break; sleep 0.1; done
    chown $2:$2 '$d/root/run' && chmod 0700 '$d/root/run' && exec chroot '$d/root' /plat/domexec 7 $3 app 64 3<>/dev/null" > "$d/console.txt" 2>&1 || true
}
report_ok() {  # <role> -> 0 if its report is clean
  f="$d/root/probe-out/$1.frontuid"
  [ -s "$f" ] && ! grep -q '^BAD' "$f" && grep -qE '^done ok=[0-9]+ bad=0$' "$f"
}
# the full check against a domexec.c; -> 0 only if every part holds
run_all() {  # <domexec.c>
  mkdir -p "$d/b/m3" "$d/b/m2" && cp "$1" "$d/b/m3/domexec.c" && cp "$m2/app-seccomp.h" "$d/b/m2/"
  gcc -static -O2 -o "$d/domexec" "$d/b/m3/domexec.c" 2>/dev/null || { echo "FAIL domexec did not build"; return 1; }
  rc=0
  run_one "$d/domexec" 1001 1000:1001
  for role in runtime front; do
    if report_ok $role; then echo "ok   the $role, from inside: $(tr '\n' ' ' < "$d/root/probe-out/$role.frontuid" | cut -c1-230)"
    else echo "FAIL the $role, from inside: $( [ -s "$d/root/probe-out/$role.frontuid" ] && grep -E '^BAD|^done|^uid' "$d/root/probe-out/$role.frontuid" | tr '\n' ' ' || echo "no report; console: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-200)")"; rc=1; fi
  done
  grep -q '^uid=1000$' "$d/root/probe-out/runtime.frontuid" 2>/dev/null && grep -q '^uid=1001$' "$d/root/probe-out/front.frontuid" 2>/dev/null \
    && echo "ok   the runtime runs as 1000 and the front as 1001" || { echo "FAIL the uids: runtime $(grep '^uid' "$d/root/probe-out/runtime.frontuid" 2>/dev/null), front $(grep '^uid' "$d/root/probe-out/front.frontuid" 2>/dev/null)"; rc=1; }
  # control: a shared uid is refused before anything starts
  run_one "$d/domexec" 1001 1000:1000
  if grep -q "must not share a uid" "$d/console.txt" && [ ! -s "$d/root/probe-out/runtime.frontuid" ]; then echo "ok   a shared uid (1000:1000) is refused: $(grep -m1 'must not share' "$d/console.txt")"
  else echo "FAIL a shared uid was not refused: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-200)"; rc=1; fi
  # control: malformed uids are refused exactly (enclave-5d): trailing junk, a sign, a missing half, no colon, root
  for bad in 1000:1001x -1:1001 1000: :1001 1000 0:1001 1000:4294967295; do
    run_one "$d/domexec" 1001 "$bad"
    if grep -q "the uids must be <runtime-uid>:<front-uid>" "$d/console.txt" && [ ! -s "$d/root/probe-out/runtime.frontuid" ]; then echo "ok   malformed uids \"$bad\" refused"
    else echo "FAIL malformed uids \"$bad\" not refused: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-160)"; rc=1; fi
  done
  # control: with /run the RUNTIME's (the v42 layout) the runtime's refusals must fail - the probe sees the old condition
  run_one "$d/domexec" 1000 1000:1001
  if [ -s "$d/root/probe-out/runtime.frontuid" ] && ! report_ok runtime; then echo "ok   with /run the runtime's (v42), the probe catches it: $(grep -c '^BAD' "$d/root/probe-out/runtime.frontuid") refusals fail"
  else echo "FAIL with /run the runtime's, the probe did not notice"; rc=1; fi
  return $rc
}

set +e
run_all "$here/domexec.c"; g=$?
[ $g = 0 ] && echo "domexec front uid: PASS" || echo "domexec front uid: FAIL"
mut() {  # <label> <sed expression>
  sed "$2" "$here/domexec.c" > "$d/mutant.c"
  if cmp -s "$d/mutant.c" "$here/domexec.c"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if run_all "$d/mutant.c" > "$d/mutant.log" 2>&1; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-200)"
}
k=0
mut "the front spawned as the runtime's uid" 's/front_pid = spawn(front, front_uid, 0, 0);/front_pid = spawn(front, uid, 0, 0);/' || k=1
mut "the shared-uid refusal removed" '/if (front_uid == uid) { printf/d' || k=1
mut "lenient uid parsing (atoi)" 's/uid_t uid = colon ? parse_uid(argv\[2\], colon) : 0, front_uid = colon ? parse_uid(colon + 1, colon + 1 + strlen(colon + 1)) : 0;/uid_t uid = (uid_t)atoi(argv[2]), front_uid = colon ? (uid_t)atoi(colon + 1) : 0;/' || k=1
[ $k = 0 ] && echo "domexec front uid mutants: all killed" || echo "domexec front uid mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
