#!/bin/sh
# The adversary probe measures BOTH layers (domprobe.c, "TWO LAYERS"): the real domexec, built static, runs as PID 1 of new
# pid/mount/net namespaces in an UNPRIVILEGED user namespace (--map-auto), chrooted into a root holding only plat/, run/,
# tmp/ and proc/ (an m3 domain's shape, no /dev), in PROBE mode, with the null device on fd 3 as the monitor hands it.
# From its console lines:
#   - the base vsock reaches fail ON THEIR OWN: present, never CONNECTED, never EPERM (only the filter gives EPERM);
#   - `seccomp=2`: the probe installed the runtime's filter (m2/app-seccomp.h) on itself;
#   - the filtered vsock reaches fail WITH EPERM: the filter refusing, as it would for a compromised runtime.
# The base vsock errors here are whatever this host's vsock gives (its loopback transport answers "Connection reset by
# peer"); the relay and port confinement they stand for in a guest are the QEMU suite's (test-m3.sh check 10), which
# judges the same lines the same way.
# Then mutants, each of which must FAIL: the probe never filters itself; the filter without its AF_VSOCK rule; the probe
# filtering itself BEFORE the base checks (the base layer then measures nothing but the filter).
#
# usage: test-domprobe-layers.sh   (needs gcc, and unshare --map-auto with a subuid range; else SKIPPED)
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$(cd "$here/../m2" && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
chmod 0755 "$d"
if ! command -v unshare >/dev/null 2>&1 || ! unshare --map-root-user --map-auto -U true 2>/dev/null; then
  echo "domprobe layers: SKIPPED, no unshare --map-auto here"; exit 0
fi
K="vsock_local_domain1 vsock_local_domain2 vsock_own_control vsock_host_control"

run_all() {  # <domprobe.c> <app-seccomp.h> -> 0 only if both layers are as specified
  rm -rf "$d/b" "$d/root" && mkdir -p "$d/b/m3" "$d/b/m2" "$d/root/plat" "$d/root/run" "$d/root/tmp" "$d/root/proc"
  chmod 0755 "$d/root" "$d/root/plat"; chmod 1777 "$d/root/run"
  cp "$here/domexec.c" "$d/b/m3/domexec.c" && cp "$1" "$d/b/m3/domprobe.c" && cp "$2" "$d/b/m2/app-seccomp.h"
  gcc -static -O2 -o "$d/root/plat/domexec" "$d/b/m3/domexec.c" 2>/dev/null || { echo "FAIL domexec did not build"; return 1; }
  gcc -static -O2 -o "$d/root/plat/domprobe" "$d/b/m3/domprobe.c" 2>/dev/null || { echo "FAIL domprobe did not build"; return 1; }
  chmod 0755 "$d/root/plat/domexec" "$d/root/plat/domprobe"
  # the probe pauses after `done` (the harness ends a domain): the timeout ends it here; "0" MiB skips the memory step
  timeout 20 unshare --map-root-user --map-auto -mpfn -- sh -c "exec chroot '$d/root' /plat/domexec 7 1000 probe 0 3<>/dev/null" \
    > "$d/console.txt" 2>&1 || true
  c="$d/console.txt"; rc=0
  line() { sed -n "s/^PROBE[0-9]* $1=//p" "$c" | head -1; }
  grep -q "^PROBE7 done" "$c" || { echo "FAIL the probe never reported done: $(tr '\n' ' ' < "$c" | cut -c1-300)"; return 1; }
  for w in $K; do   # (not `k`: sh has no local variables, and k is the mutant tally below)
    b=$(line "$w"); f=$(line "filtered_$w")
    case "$b" in
      ""|*CONNECTED*|"Operation not permitted") echo "FAIL base $w=${b:-missing} (must fail on its own, not by EPERM)"; rc=1 ;;
      *) echo "ok   base $w=$b" ;;
    esac
    [ "$f" = "Operation not permitted" ] && echo "ok   filtered_$w=$f" || { echo "FAIL filtered_$w=${f:-missing} (want EPERM)"; rc=1; }
  done
  s=$(line seccomp)
  [ "$s" = 2 ] && echo "ok   seccomp=$s" || { echo "FAIL seccomp=${s:-missing} (want 2)"; rc=1; }
  return $rc
}

set +e
run_all "$here/domprobe.c" "$m2/app-seccomp.h"; g=$?
[ $g = 0 ] && echo "domprobe layers: PASS" || echo "domprobe layers: FAIL"

mut() {  # <label> <sed expression> [header]
  if [ "${3:-}" = header ]; then orig="$m2/app-seccomp.h"; else orig="$here/domprobe.c"; fi
  sed "$2" "$orig" > "$d/mutant"
  if cmp -s "$d/mutant" "$orig"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if [ "${3:-}" = header ]; then run_all "$here/domprobe.c" "$d/mutant" > "$d/mutant.log" 2>&1; else run_all "$d/mutant" "$m2/app-seccomp.h" > "$d/mutant.log" 2>&1; fi
  if [ $? = 0 ]; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-160)"
}
k=0
mut "the probe never filters itself" 's/else if (app_seccomp_install() != 0) say("seccomp", strerror(errno));/else if (0) say("seccomp", "");/' || k=1
mut "the filter without its AF_VSOCK rule" '/APP_ARG0_EQ(APP_NR_socket, APP_AF_VSOCK, APP_EPERM),/d' header || k=1
mut "the probe filtered before its base checks" 's/    if (argc > 1) id = argv\[1\];/    if (argc > 1) id = argv[1]; prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); app_seccomp_install();/' || k=1
[ $k = 0 ] && echo "domprobe layers mutants: all killed" || echo "domprobe layers mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
