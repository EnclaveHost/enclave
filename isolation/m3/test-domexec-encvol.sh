#!/bin/sh
# Encrypted volumes in a partition domain (m3/monitor/encvol.go stages them; the front reaches them by group): domexec,
# built static, runs as PID 1 in an unprivileged user namespace (--map-auto), chrooted into an m3-shaped SECRET domain
# root, with m3/encvol-probe.c standing in for both workloads. With the monitor's root-owned, read-only /enc.volumes:
# the front (1001) carries exactly the runtime's group (1000) and the runtime (1000) carries none and runs under umask
# 007. Without it: neither, as before. Refused: a marker in a non-secret domain, and a marker anyone may write.
# Mutants of domexec.c, each of which must fail: the front's group never given; given always; the umask dropped.
#
# usage: test-domexec-encvol.sh   (needs gcc and unshare --map-auto with a subuid range; else SKIPPED)
set -e
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d)
trap 'reclaim; rm -rf "$d"' EXIT
reclaim() { [ -d "$d/root" ] && unshare --map-root-user --map-auto sh -c "chown -R 0:0 '$d/root'; chmod -R u+rwx '$d/root'" 2>/dev/null; rm -rf "$d/root"; }
chmod 0755 "$d"
if ! command -v unshare >/dev/null 2>&1 || ! unshare --map-root-user --map-auto -U true 2>/dev/null; then
  echo "domexec encvol: SKIPPED, no unshare --map-auto here"; exit 0
fi
gcc -static -O2 -o "$d/probe" "$here/encvol-probe.c"

run_one() {  # <domexec binary> <marker: none|ok|writable> <secret: yes|no>
  reclaim; mkdir -p "$d/root/plat/rt" "$d/root/run" "$d/root/tmp" "$d/root/proc" "$d/root/probe-out" "$d/root/etc"
  chmod 0755 "$d/root" "$d/root/plat" "$d/root/plat/rt"; chmod 1777 "$d/root/probe-out"
  cp "$1" "$d/root/plat/domexec"
  for p in rt/ld-linux-x86-64.so.2 front secretrun; do cp "$d/probe" "$d/root/plat/$p"; chmod 0755 "$d/root/plat/$p"; done
  chmod 0755 "$d/root/plat/domexec"
  if [ "$3" = yes ]; then printf '0x%064d' 0 > "$d/root/secret.id"; chmod 0444 "$d/root/secret.id"; fi
  case "$2" in ok) printf 'docs\n' > "$d/root/enc.volumes"; chmod 0444 "$d/root/enc.volumes" ;;
               writable) printf 'docs\n' > "$d/root/enc.volumes"; chmod 0644 "$d/root/enc.volumes" ;; esac
  timeout 60 unshare --map-root-user --map-auto -mpfn -- sh -c "
    chown 1001:1001 '$d/root/run' && chmod 0700 '$d/root/run' && exec chroot '$d/root' /plat/domexec 7 1000:1001 app 64 3<>/dev/null" > "$d/console.txt" 2>&1 || true
}
field() { sed -n "s/^$2=//p" "$d/root/probe-out/$1.enc" 2>/dev/null; }
check() {  # <label> <cond...>
  label="$1"; shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label (front: $(tr '\n' ' ' < "$d/root/probe-out/front.enc" 2>/dev/null) runtime: $(tr '\n' ' ' < "$d/root/probe-out/runtime.enc" 2>/dev/null) console: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-200))"; return 1; fi
}
run_all() {  # <domexec.c>
  mkdir -p "$d/b/m3" "$d/b/m2" && cp "$1" "$d/b/m3/domexec.c" && cp "$here/../m2/app-seccomp.h" "$here/../m2/sha256-min.h" "$here/../m2/modelvol.h" "$d/b/m2/"
  gcc -static -O2 -o "$d/domexec" "$d/b/m3/domexec.c" 2>/dev/null || { echo "FAIL domexec did not build"; return 1; }
  rc=0
  run_one "$d/domexec" ok yes
  check "staged: the front (1001) carries the runtime's group 1000, and only it" [ "$(field front uid)" = 1001 -a "$(field front groups)" = 1000 ] || rc=1
  check "staged: the runtime carries no group and runs under umask 007" [ "$(field runtime uid)" = 1000 -a -z "$(field runtime groups)" -a "$(field runtime umask)" = 007 ] || rc=1
  run_one "$d/domexec" none yes
  check "not staged: the front carries no group, the runtime's umask is untouched" [ "$(field front uid)" = 1001 -a -z "$(field front groups)" -a -n "$(field runtime umask)" -a "$(field runtime umask)" != 007 ] || rc=1
  run_one "$d/domexec" none no
  check "a domain with no secret and no staging runs as before" [ "$(field front uid)" = 1001 -a -z "$(field front groups)" ] || rc=1
  run_one "$d/domexec" ok no
  check "staging in a non-secret domain is refused before anything runs" sh -c "grep -q 'encrypted volumes need a secret domain' '$d/console.txt' && [ ! -s '$d/root/probe-out/front.enc' ]" || rc=1
  run_one "$d/domexec" writable yes
  check "a writable staging marker is refused" sh -c "grep -q 'encrypted volume marker' '$d/console.txt' && [ ! -s '$d/root/probe-out/front.enc' ]" || rc=1
  return $rc
}
set +e
run_all "$here/domexec.c"; g=$?
[ $g = 0 ] && echo "domexec encvol: PASS" || echo "domexec encvol: FAIL"
mut() {  # <label> <sed expression>
  sed "$2" "$here/domexec.c" > "$d/mutant.c"
  if cmp -s "$d/mutant.c" "$here/domexec.c"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if run_all "$d/mutant.c" > "$d/mutant.log" 2>&1; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-160)"
}
k=0
mut "the front's group never given" 's/setgroups(1, \&app_gid) == 0/setgroups(0, NULL) == 0/' || k=1
mut "the group given to every workload" 's/enc_domain \&\& uid == front_uid_g ? setgroups/enc_domain ? setgroups/' || k=1
mut "the runtime's umask not set" 's/if (enc_domain \&\& filter) umask(007);/(void)0;/' || k=1
mut "the marker's mode not checked" 's/ || (enc_st.st_mode \& 0222)) die("encrypted volume marker");/) die("encrypted volume marker");/' || k=1
[ $k = 0 ] && echo "domexec encvol mutants: all killed" || echo "domexec encvol mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
