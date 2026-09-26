#!/bin/sh
# The NucBox domain's runtime seccomp filter (m2/app-seccomp.h, applied by domexec.c's spawn), checked for real: domexec,
# built static, runs as PID 1 of new pid/mount/net namespaces in an UNPRIVILEGED user namespace (--map-auto, so its
# setgroups/setgid/setuid really happen), chrooted into a root holding only plat/, run/, tmp/ and proc/ (no /dev: an m3
# domain's shape), with the null device on fd 3 as the monitor hands it, and /run the front's (uid 1001, 0700). m2/app-seccomp-probe.c stands in for BOTH
# workloads: as /plat/rt/ld-linux-x86-64.so.2 (the runtime) it must be filtered, with every refusal as specified and
# every allowance working; as /plat/front it must NOT be filtered. Both modes: serve ("app") and run ("run", port 8080).
# Then mutants, one at a time, each of which must FAIL: the AF_VSOCK rule gone, the filter on the front, the runtime
# unfiltered (serve and run), and no no_new_privs (the filter cannot install; the runtime must not run).
#
# usage: test-domexec-seccomp.sh   (needs gcc, and unshare --map-auto with a subuid range; else SKIPPED)
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
  echo "domexec seccomp: SKIPPED, no unshare --map-auto here"; exit 0
fi
gcc -static -pthread -O2 -o "$d/probe" "$m2/app-seccomp-probe.c" 2>/dev/null

# one full check against a domexec.c and an app-seccomp.h; -> 0 only if both modes pass
run_all() {  # <domexec.c> <app-seccomp.h>
  reclaim; rm -rf "$d/b" && mkdir -p "$d/b/m3" "$d/b/m2" "$d/root/plat/rt" "$d/root/run" "$d/root/tmp" "$d/root/proc" "$d/root/probe-out"
  chmod 0755 "$d/root" "$d/root/plat" "$d/root/plat/rt"; chmod 1777 "$d/root/probe-out"
  cp "$1" "$d/b/m3/domexec.c" && cp "$2" "$d/b/m2/app-seccomp.h" && cp "$(dirname "$0")/../m2/sha256-min.h" "$d/b/m2/"
  gcc -static -O2 -o "$d/root/plat/domexec" "$d/b/m3/domexec.c" 2>/dev/null || { echo "FAIL domexec did not build"; return 1; }
  cp "$d/probe" "$d/root/plat/rt/ld-linux-x86-64.so.2"; cp "$d/probe" "$d/root/plat/front"
  chmod 0755 "$d/root/plat/domexec" "$d/root/plat/rt/ld-linux-x86-64.so.2" "$d/root/plat/front"
  rc=0
  for mode in "app 64" "run 64 8080"; do
    rm -f "$d/root/probe-out/"*.seccomp
    # /run as the monitor leaves it (monitor.start): the FRONT's uid, 0700
    timeout 60 unshare --map-root-user --map-auto -mpfn -- sh -c "chown 1001:1001 '$d/root/run' && chmod 0700 '$d/root/run' && exec chroot '$d/root' /plat/domexec 7 1000:1001 $mode 3<>/dev/null" > "$d/console.txt" 2>&1 || true
    for role in runtime front; do
      f="$d/root/probe-out/$role.seccomp"
      if [ -s "$f" ] && ! grep -q '^BAD' "$f" && grep -qE '^done ok=[0-9]+ bad=0$' "$f"; then
        echo "ok   ${mode%% *} mode, seen from inside the $role: $(tail -1 "$f")"
      else
        echo "FAIL ${mode%% *} mode, seen from inside the $role: $( [ -s "$f" ] && grep -E '^BAD|^done' "$f" | tr '\n' ' ' || echo "no report; console: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-200)")"; rc=1
      fi
    done
  done
  return $rc
}

set +e
run_all "$here/domexec.c" "$m2/app-seccomp.h"; g=$?
[ $g = 0 ] && echo "domexec seccomp: PASS" || echo "domexec seccomp: FAIL"

mut() {  # <label> <sed expression> [header]
  if [ "${3:-}" = header ]; then orig="$m2/app-seccomp.h"; else orig="$here/domexec.c"; fi
  sed "$2" "$orig" > "$d/mutant"
  if cmp -s "$d/mutant" "$orig"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if [ "${3:-}" = header ]; then run_all "$here/domexec.c" "$d/mutant" > "$d/mutant.log" 2>&1; else run_all "$d/mutant" "$m2/app-seccomp.h" > "$d/mutant.log" 2>&1; fi
  if [ $? = 0 ]; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-200)"
}
k=0
mut "filter: no AF_VSOCK rule" '/APP_ARG0_EQ(APP_NR_socket, APP_AF_VSOCK, APP_EPERM),/d' header || k=1
mut "filter: pidfd_getfd allowed" '/APP_RULE(APP_NR_pidfd_getfd, APP_EPERM),/d' header || k=1
mut "the filter applied to the front" 's/front_pid = spawn(front, front_uid, 0, 0);/front_pid = spawn(front, front_uid, 0, 1);/' || k=1
mut "the runtime unfiltered (serve)" 's/rt_pid = spawn(rt, uid, 1, 1);/rt_pid = spawn(rt, uid, 1, 0);/' || k=1
mut "the runtime unfiltered (run)" 's/rt_pid = spawn(run, uid, 1, 1);/rt_pid = spawn(run, uid, 1, 0);/' || k=1
mut "no no_new_privs (the filter cannot install)" 's/if (filter \&\& (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || app_seccomp_install() != 0)) {/if (filter \&\& app_seccomp_install() != 0) {/' || k=1
[ $k = 0 ] && echo "domexec seccomp mutants: all killed" || echo "domexec seccomp mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
