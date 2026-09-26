#!/bin/sh
# dominit's hardening (enclave-87's ruling on enclave-b4's finding at 298924ae: the app's runtime ran as ROOT beside the
# root front), checked outside a guest:
#   1. sysctl_hold, for each kernel setting the domain starts only with: Yama's ptrace_scope at least 2, user namespaces
#      at most 0, io_uring_disabled at least 2 - held or refused: absent, unparsable, a write refused, a write that
#      "succeeds" and changes nothing, a read-back gone or garbage; a value already on the right side is never written;
#   2. unpriv_port: a run-mode port below ip_unprivileged_port_start lowers it to exactly that port, read back; a port at
#      or above it changes nothing;
#   3. the app's privilege drop, FOR REAL: spawn(..., drop) in an unprivileged user namespace (--map-auto), where
#      setgroups, setresgid/setresuid, the bounding set and capset act as they do for the guest's PID 1. The harness
#      first gives itself a supplementary group and inheritable capabilities, so that skipping either step shows. A probe
#      exec'd as the app reports from its OWN /proc/self/status (uid, gid, groups, no_new_privs, the five capability
#      sets) and what it could open: a root-only file (the console's stand-in), init's and the front's /proc entries;
#   3b. app_reaches REFUSING (enclave-bf): the harness aims each of its checks at something the dropped uid CAN open -
#      a world-writable file, a world-read-writable file, a world-writable "tsm" directory, a same-uid dumpable "front" -
#      and the child must exit 125 with "could still open <that>";
#   3c. the app runtime's seccomp filter (app-seccomp.h), from INSIDE (app-seccomp-probe.c): spawned as the app it is
#      filtered, every refusal as specified (EPERM / ENOSYS / killed by SIGSYS) and every allowance working; spawned as
#      the front it is NOT filtered;
#   4. main, from the source: the three settings held before the front, the front not dropped or filtered, the app
#      dropped and filtered;
#   5. mutants, one at a time: each must make these checks FAIL.
# PID 1 itself cannot run here, so dominit.c is compiled with its main renamed (as test-dominit-handoff.sh does).
#
# usage: test-dominit-hardening.sh   (needs gcc; part 3 needs unshare --map-auto and a subuid range, else SKIPPED)
set -e
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
chmod 0755 "$d"                                  # the dropped probe must reach its own binary and report directory

cat > "$d/h.c" <<'EOF'
#define main dominit_main
#include "dominit.c"
#undef main
#include <signal.h>

static int fails;
static void verdict(int ok, const char *name, const char *line) {
    printf("%s %s: %s\n", ok ? "ok  " : "FAIL", name, line);
    if (!ok) fails++;
}
static void setf(const char *p, const char *s) {
    FILE *f = fopen(p, "w");
    if (!f) { perror(p); exit(2); }
    fputs(s, f);
    fclose(f);
}
static int writes;
static int wr_count(const char *p, const char *s) { writes++; return write_sysctl(p, s); }
static int wr_noop(const char *p, const char *s) { (void)p; (void)s; writes++; return 0; }
static int wr_fail(const char *p, const char *s) { (void)p; (void)s; writes++; errno = EACCES; return -1; }
static int wr_remove(const char *p, const char *s) { (void)s; writes++; return unlink(p); }
static int wr_garbage(const char *p, const char *s) { (void)s; writes++; setf(p, "x\n"); return 0; }

static void hold_case(const char *name, const char *dir, const char *sysname, int want, int at_least, const char *content,
                      int (*wr)(const char *, const char *), int want_ok, const char *want_prefix, int want_writes, int want_after) {
    char p[512], line[256];
    snprintf(p, sizeof p, "%s/sysctl", dir);
    unlink(p);
    if (content) setf(p, content);
    writes = 0;
    int ok = sysctl_hold(sysname, p, want, at_least, wr, line, sizeof line);
    int after = -1;
    if (want_after >= 0) read_sysctl_int(p, &after);
    int good = ok == want_ok && strncmp(line, want_prefix, strlen(want_prefix)) == 0
               && (want_writes < 0 || writes == want_writes) && (want_after < 0 || after == want_after);
    verdict(good, name, line);
}
static void port_case(const char *name, const char *dir, int port, const char *content,
                      int (*wr)(const char *, const char *), int want_ok, int want_after) {
    char p[512], line[160];
    snprintf(p, sizeof p, "%s/ip_unprivileged_port_start", dir);
    unlink(p);
    if (content) setf(p, content);
    writes = 0;
    int ok = unpriv_port(port, p, wr, line, sizeof line), after = -1;
    if (content) read_sysctl_int(p, &after);
    verdict(ok == want_ok && (want_after < 0 || after == want_after), name, line);
}

/* part 3: as (namespace) root, give this process something to drop, then spawn the probe dropped. `reach`, for 3b, aims
 * one of app_reaches' checks at `target`, which the dropped uid CAN open: "write" a file, "rw" a file, "tsm" a directory,
 * "proc" a same-uid dumpable process standing in for the front (target unused). */
static int drop_run(const char *probe, const char *out, const char *reach, const char *target, int flags) {
    gid_t g[] = {4242};
    if (setgroups(1, g) != 0) { perror("setgroups (harness)"); return 2; }
    struct { uint32_t version; int pid; } h = {0x20080522, 0};
    struct { uint32_t effective, permitted, inheritable; } c[2];
    if (syscall(SYS_capget, &h, c) != 0) { perror("capget (harness)"); return 2; }
    for (int i = 0; i < 2; i++) c[i].inheritable = c[i].permitted;          /* so a skipped capset shows */
    if (syscall(SYS_capset, &h, c) != 0) { perror("capset (harness)"); return 2; }
    front_pid_g = getpid();                                                 /* a root process: the front's stand-in */
    static const char *tab[2];
    pid_t same = -1;
    if (reach) {
        tab[0] = target; tab[1] = NULL;
        if (!strcmp(reach, "write")) reach_write = tab;
        else if (!strcmp(reach, "rw")) reach_rw = tab;
        else if (!strcmp(reach, "tsm")) reach_tsm = target;
        else if (!strcmp(reach, "proc")) {
            int ready[2];
            if (pipe(ready) != 0) return 2;
            same = fork();
            if (same == 0) {                  /* the app's uid, and dumpable again (a uid change clears it) */
                if (setgroups(0, NULL) || setresgid(APP_GID, APP_GID, APP_GID) || setresuid(APP_UID, APP_UID, APP_UID)
                    || prctl(PR_SET_DUMPABLE, 1, 0, 0, 0)) _exit(2);
                close(ready[0]); close(ready[1]);
                for (;;) pause();
            }
            close(ready[1]);
            char b; (void)!read(ready[0], &b, 1);                        /* EOF once the child dropped */
            close(ready[0]);
            front_pid_g = same;
        } else return 2;
    }
    char env[600];
    snprintf(env, sizeof env, "PROBE_OUT=%s", out);
    char *argv[] = {(char *)probe, NULL};
    fflush(stdout);
    pid_t pid = spawn(argv, env, -1, flags);
    int st = 0;
    waitpid(pid, &st, 0);
    if (same > 0) { kill(same, SIGKILL); waitpid(same, NULL, 0); }
    return WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
}

int main(int argc, char **argv) {
    const int app = SPAWN_QUIET | SPAWN_DROP | SPAWN_FILTER;
    if (argc == 4 && strcmp(argv[1], "drop") == 0) return drop_run(argv[2], argv[3], NULL, NULL, app);
    if (argc == 6 && strcmp(argv[1], "reach") == 0) return drop_run(argv[2], argv[3], argv[4], argv[5], app);
    if (argc == 4 && strcmp(argv[1], "front") == 0) return drop_run(argv[2], argv[3], NULL, NULL, 0);   /* as main spawns the front */
    const char *dir = argv[1];
    hold_case("yama absent", dir, "yama ptrace_scope", 2, 1, NULL, wr_count, 0, "yama ptrace_scope absent", 0, -1);
    hold_case("yama unparsable", dir, "yama ptrace_scope", 2, 1, "x\n", wr_count, 0, "yama ptrace_scope unparsable", 0, -1);
    hold_case("yama empty", dir, "yama ptrace_scope", 2, 1, "", wr_count, 0, "yama ptrace_scope unparsable", 0, -1);
    hold_case("yama trailing garbage", dir, "yama ptrace_scope", 2, 1, "2x\n", wr_count, 0, "yama ptrace_scope unparsable", 0, -1);
    hold_case("yama 0 raised to 2", dir, "yama ptrace_scope", 2, 1, "0\n", wr_count, 1, "yama ptrace_scope=0 -> 2", 1, 2);
    hold_case("yama 1 raised to 2", dir, "yama ptrace_scope", 2, 1, "1\n", wr_count, 1, "yama ptrace_scope=1 -> 2", 1, 2);
    hold_case("yama 2 kept, never written", dir, "yama ptrace_scope", 2, 1, "2\n", wr_count, 1, "yama ptrace_scope=2 (already >= 2)", 0, 2);
    hold_case("yama 3 kept, never lowered", dir, "yama ptrace_scope", 2, 1, "3\n", wr_count, 1, "yama ptrace_scope=3 (already >= 2)", 0, 3);
    hold_case("yama write 'succeeds' and changes nothing", dir, "yama ptrace_scope", 2, 1, "1\n", wr_noop, 0, "yama ptrace_scope=1 -> not the 2 asked", 1, -1);
    hold_case("yama write refused", dir, "yama ptrace_scope", 2, 1, "1\n", wr_fail, 0, "yama ptrace_scope=1, NOT set to 2", 1, -1);
    hold_case("yama read-back gone", dir, "yama ptrace_scope", 2, 1, "1\n", wr_remove, 0, "yama ptrace_scope=1 -> unreadable", 1, -1);
    hold_case("yama read-back garbage", dir, "yama ptrace_scope", 2, 1, "1\n", wr_garbage, 0, "yama ptrace_scope=1 -> not the 2 asked", 1, -1);
    hold_case("userns 511143 set to 0", dir, "user.max_user_namespaces", 0, 0, "511143\n", wr_count, 1, "user.max_user_namespaces=511143 -> 0", 1, 0);
    hold_case("userns 0 kept, never written", dir, "user.max_user_namespaces", 0, 0, "0\n", wr_count, 1, "user.max_user_namespaces=0 (already <= 0)", 0, 0);
    hold_case("userns write 'succeeds' and changes nothing", dir, "user.max_user_namespaces", 0, 0, "5\n", wr_noop, 0, "user.max_user_namespaces=5 -> not the 0 asked", 1, -1);
    hold_case("userns write refused", dir, "user.max_user_namespaces", 0, 0, "5\n", wr_fail, 0, "user.max_user_namespaces=5, NOT set to 0", 1, -1);
    hold_case("userns absent", dir, "user.max_user_namespaces", 0, 0, NULL, wr_count, 0, "user.max_user_namespaces absent", 0, -1);
    hold_case("io_uring 0 set to 2", dir, "kernel.io_uring_disabled", 2, 1, "0\n", wr_count, 1, "kernel.io_uring_disabled=0 -> 2", 1, 2);
    hold_case("io_uring 1 set to 2", dir, "kernel.io_uring_disabled", 2, 1, "1\n", wr_count, 1, "kernel.io_uring_disabled=1 -> 2", 1, 2);
    hold_case("io_uring 2 kept, never written", dir, "kernel.io_uring_disabled", 2, 1, "2\n", wr_count, 1, "kernel.io_uring_disabled=2 (already >= 2)", 0, 2);
    hold_case("io_uring write 'succeeds' and changes nothing", dir, "kernel.io_uring_disabled", 2, 1, "0\n", wr_noop, 0, "kernel.io_uring_disabled=0 -> not the 2 asked", 1, -1);
    hold_case("io_uring absent", dir, "kernel.io_uring_disabled", 2, 1, NULL, wr_count, 0, "kernel.io_uring_disabled absent", 0, -1);
    port_case("port 8080: unchanged", dir, 8080, "1024\n", wr_count, 1, 1024);
    port_case("port 1024: unchanged", dir, 1024, "1024\n", wr_count, 1, 1024);
    port_case("port 80: start lowered to exactly 80", dir, 80, "1024\n", wr_count, 1, 80);
    port_case("port 80: a write that changes nothing refuses", dir, 80, "1024\n", wr_noop, 0, 1024);
    port_case("port 80: a write refused refuses", dir, 80, "1024\n", wr_fail, 0, 1024);
    port_case("port 80: no sysctl refuses", dir, 80, NULL, wr_count, 0, -1);
    return fails ? 1 : 0;
}
EOF

cat > "$d/probe.c" <<'EOF'
/* the app's stand-in: what it IS and what it can OPEN, from inside, to $PROBE_OUT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static const char *try(const char *p, int flags) {
    int fd = open(p, flags | O_CLOEXEC);
    if (fd >= 0) { close(fd); return "OPENED"; }
    return errno == EACCES || errno == EPERM ? "denied" : strerror(errno);
}
int main(void) {
    const char *out = getenv("PROBE_OUT");
    char rep[600], rootonly[600], line[512], p[64];
    snprintf(rep, sizeof rep, "%s/report", out);
    snprintf(rootonly, sizeof rootonly, "%s/rootonly", out);
    FILE *f = fopen(rep, "w"), *s = fopen("/proc/self/status", "r");
    if (!f || !s) return 3;
    while (fgets(line, sizeof line, s))
        if (!strncmp(line, "Uid:", 4) || !strncmp(line, "Gid:", 4) || !strncmp(line, "Groups:", 7) || !strncmp(line, "NoNewPrivs:", 11)
            || !strncmp(line, "Cap", 3)) fputs(line, f);
    fprintf(f, "rootonly-write: %s\n", try(rootonly, O_WRONLY));
    fprintf(f, "proc1-environ: %s\n", try("/proc/1/environ", O_RDONLY));
    snprintf(p, sizeof p, "/proc/%d/mem", (int)getppid());
    fprintf(f, "parent-mem: %s\n", try(p, O_RDONLY));
    snprintf(p, sizeof p, "/proc/%d/fd/1", (int)getppid());
    fprintf(f, "parent-fd1: %s\n", try(p, O_WRONLY));
    fclose(f);
    return 0;
}
EOF

# the drop's expected view, from the probe's report
check_report() {  # <report> <label>
  r=$1; bad=0
  for want in 'Uid:	1000	1000	1000	1000' 'Gid:	1000	1000	1000	1000' 'NoNewPrivs:	1' \
              'CapInh:	0000000000000000' 'CapPrm:	0000000000000000' 'CapEff:	0000000000000000' \
              'CapBnd:	0000000000000000' 'CapAmb:	0000000000000000' \
              'rootonly-write: denied' 'proc1-environ: denied' 'parent-mem: denied' 'parent-fd1: denied'; do
    if grep -qxF "$want" "$r"; then :; else echo "FAIL $2: want '$want'"; bad=1; fi
  done
  if grep -E '^Groups:' "$r" | grep -qE '[0-9]'; then echo "FAIL $2: supplementary groups remain: $(grep -E '^Groups:' "$r")"; bad=1; fi
  return $bad
}

# part 4: main, from the source
source_order() {  # <dominit.c>
  awk '
    /^int main\(/ { inmain = 1 }
    inmain && /\{"yama ptrace_scope", YAMA_PATH, YAMA_WANT, 1\}/ { ty = NR }
    inmain && /\{"user.max_user_namespaces", "\/proc\/sys\/user\/max_user_namespaces", 0, 0\}/ { tu = NR }
    inmain && /\{"kernel.io_uring_disabled", "\/proc\/sys\/kernel\/io_uring_disabled", 2, 1\}/ { ti = NR }
    inmain && /sysctl_hold\(holds\[i\]/ && !h { h = NR }
    inmain && h && !rb && /reboot\(RB_POWER_OFF\)/ { rb = NR }
    inmain && /spawn\(front,/ { f = NR; fdrop = ($0 ~ /pfd\[1\], 0\);/) }
    inmain && /spawn\(app,/ { a = NR; adrop = ($0 ~ /SPAWN_QUIET \| SPAWN_DROP \| SPAWN_FILTER\)/) }
    END {
      ok = ty && tu && ti && h && ty < h && tu < h && ti < h && h < f && rb && rb < f && f && a && fdrop && adrop
      printf("%s main: holds yama@%d userns@%d io_uring@%d, held at %d (refusal powers off at %d), before the front at %d (no flags: %d); the app at %d quiet+dropped+filtered: %d\n",
             ok ? "ok  " : "FAIL", ty, tu, ti, h, rb, f, fdrop, a, adrop)
      exit ok ? 0 : 1
    }' "$1"
}

have_userns=0
if command -v unshare >/dev/null 2>&1 && unshare --map-root-user --map-auto -U true 2>/dev/null; then have_userns=1; fi

# one full run of parts 1-4 against a given dominit.c; -> 0 only if every check passes
run_all() {  # <dominit.c> <app-seccomp.h> <cc...>
  src=$1; hdr=$2; shift 2
  rm -rf "$d/b" && mkdir -p "$d/b/t" "$d/b/o" && chmod 0755 "$d/b" && chmod 1777 "$d/b/o"
  cp "$src" "$d/b/dominit.c" && cp "$hdr" "$d/b/app-seccomp.h" && cp "$d/h.c" "$d/b/"
  "$@" -O2 -Wall -Wextra -Wno-unused-function -o "$d/b/h" "$d/b/h.c" || return 1
  "$@" -O2 -o "$d/b/probe" "$d/probe.c" || return 1
  gcc -static -pthread -O2 -o "$d/b/rt-probe" "$here/app-seccomp-probe.c" 2>/dev/null || return 1
  cp "$d/b/rt-probe" "$d/b/front-probe"
  chmod 0755 "$d/b/probe" "$d/b/rt-probe" "$d/b/front-probe"
  rc=0
  "$d/b/h" "$d/b/t" || rc=1
  source_order "$d/b/dominit.c" || rc=1
  if [ $have_userns = 1 ]; then
    : > "$d/b/o/rootonly"; chmod 0600 "$d/b/o/rootonly"
    if unshare --map-root-user --map-auto -mpf --mount-proc "$d/b/h" drop "$d/b/probe" "$d/b/o"; then
      if check_report "$d/b/o/report" "the app's drop"; then echo "ok   the app's drop, seen from inside: $(tr '\n' ' ' < "$d/b/o/report" | sed 's/\t/ /g')"; else rc=1; fi
    else
      echo "FAIL the app's drop: the dropped child did not run the probe (exit $?)"; rc=1
    fi
    # 3b: each check REFUSES something the dropped uid can open (exit 125, "could still open <it>")
    : > "$d/b/o/open-w"; chmod 0666 "$d/b/o/open-w"
    : > "$d/b/o/open-rw"; chmod 0666 "$d/b/o/open-rw"
    mkdir -p "$d/b/o/tsm"; chmod 0777 "$d/b/o/tsm"
    for c in "write $d/b/o/open-w $d/b/o/open-w" "rw $d/b/o/open-rw $d/b/o/open-rw" "tsm $d/b/o/tsm $d/b/o/tsm (a report entry)" "proc - /environ"; do
      mode=${c%% *}; rest=${c#* }; target=${rest%% *}; want=${rest#* }
      out=$(unshare --map-root-user --map-auto -mpf --mount-proc "$d/b/h" reach "$d/b/probe" "$d/b/o" "$mode" "$target" 2>&1); ec=$?
      if [ $ec = 125 ] && printf '%s' "$out" | grep -F "could still open " | grep -qF "$want"; then
        echo "ok   app_reaches refuses a reachable $mode target: $(printf '%s' "$out" | grep -m1 'could still open')"
      else
        echo "FAIL app_reaches did not refuse a reachable $mode target (exit $ec): $out"; rc=1
      fi
    done
    # 3c: the seccomp filter, from inside: as the app (every flag), and as the front (none)
    rm -f "$d/b/o/runtime.seccomp" "$d/b/o/front.seccomp"
    unshare --map-root-user --map-auto -mpf --mount-proc "$d/b/h" drop "$d/b/rt-probe" "$d/b/o" > /dev/null 2>&1
    unshare --map-root-user --map-auto -mpf --mount-proc "$d/b/h" front "$d/b/front-probe" "$d/b/o" > /dev/null 2>&1
    for role in runtime front; do
      f="$d/b/o/$role.seccomp"
      if [ -s "$f" ] && ! grep -q '^BAD' "$f" && grep -qE '^done ok=[0-9]+ bad=0$' "$f"; then
        echo "ok   seccomp, seen from inside the $role: $(tail -1 "$f")"
      else
        echo "FAIL seccomp, seen from inside the $role: $( [ -s "$f" ] && grep -E '^BAD|^done' "$f" | tr '\n' ' ' || echo 'no report (the child did not run)')"; rc=1
      fi
    done
  fi
  return $rc
}

MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
set +e
run_all "$here/dominit.c" "$here/app-seccomp.h" gcc; g=$?
[ $g = 0 ] && echo "dominit hardening (glibc): PASS" || echo "dominit hardening (glibc): FAIL"
if [ -r "$MUSL/lib/musl-gcc.specs" ]; then
  run_all "$here/dominit.c" "$here/app-seccomp.h" /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static; m=$?
  [ $m = 0 ] && echo "dominit hardening (musl, as the image links it): PASS" || echo "dominit hardening (musl): FAIL"
else
  m=0; echo "dominit hardening (musl): SKIPPED, no musl at $MUSL (sh isolation/m2/build-musl.sh)"
fi
[ $have_userns = 1 ] || echo "the app's drop (part 3): SKIPPED, no unshare --map-auto here: parts 1, 2 and 4 only"

# part 5: every mutant must FAIL the checks above (glibc build)
mut() {  # <label> <sed expression> [needs-userns] [header]: the edit goes to dominit.c, or with "header" to app-seccomp.h
  if [ "${3:-}" = userns ] && [ $have_userns = 0 ]; then echo "skip mutant $1 (needs part 3)"; return 0; fi
  if [ "${4:-}" = header ]; then orig="$here/app-seccomp.h"; else orig="$here/dominit.c"; fi
  sed "$2" "$orig" > "$d/mutant"
  if cmp -s "$d/mutant" "$orig"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if [ "${4:-}" = header ]; then set -- "$1" "$here/dominit.c" "$d/mutant"; else set -- "$1" "$d/mutant" "$here/app-seccomp.h"; fi
  if run_all "$2" "$3" gcc > "$d/mutant.log" 2>&1; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log")"
}
k=0
mut "hold: no read-back check" 's/if (r == -2 || (at_least ? now < want : now > want)) {/if (0) {/' || k=1
mut "hold: every value taken as already held" 's/if (at_least ? was >= want : was <= want) {/if (1) {/' || k=1
mut "hold: the at-most direction flipped" 's/if (at_least ? was >= want : was <= want) {/if (was >= want) {/' || k=1
mut "port: lowered to 0, not the port" 's/snprintf(v, sizeof v, "%d\\n", port);/snprintf(v, sizeof v, "0\\n");/' || k=1
mut "main: the app not dropped" 's/SPAWN_QUIET | SPAWN_DROP | SPAWN_FILTER)/SPAWN_QUIET | SPAWN_FILTER)/' || k=1
mut "main: the app not filtered" 's/SPAWN_QUIET | SPAWN_DROP | SPAWN_FILTER)/SPAWN_QUIET | SPAWN_DROP)/' || k=1
mut "main: the filter applied to the front" 's/spawn(front, NULL, pfd\[1\], 0);/spawn(front, NULL, pfd[1], SPAWN_FILTER);/' || k=1
mut "main: Yama not held" '/{"yama ptrace_scope", YAMA_PATH, YAMA_WANT, 1},/d' || k=1
mut "main: user namespaces not held" '/{"user.max_user_namespaces", "\/proc\/sys\/user\/max_user_namespaces", 0, 0},/d' || k=1
mut "main: io_uring not held" '/{"kernel.io_uring_disabled", "\/proc\/sys\/kernel\/io_uring_disabled", 2, 1},/d' || k=1
mut "drop: no setgroups" 's/if (setgroups(0, NULL) != 0) return "setgroups";//' userns || k=1
mut "drop: bounding set kept" 's/if (prctl(PR_CAPBSET_DROP, c, 0, 0, 0) != 0) { if (errno == EINVAL) break; return "PR_CAPBSET_DROP"; }/break;/' userns || k=1
mut "drop: no capset (inheritable kept)" 's/if (syscall(SYS_capset, \&h, caps) != 0) return "capset";//' userns || k=1
mut "drop: no no_new_privs" 's/if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return "PR_SET_NO_NEW_PRIVS";//' userns || k=1
mut "drop: the uid stays 0" 's/if (setresuid(APP_UID, APP_UID, APP_UID) != 0) return "setresuid";/if (setresuid(0, 0, 0) != 0) return "setresuid";/' userns || k=1
mut "reach: always nothing (enclave-bf's)" 's/^static const char \*app_reaches(void) {$/static const char *app_reaches(void) { if (1) return NULL;/' userns || k=1
mut "reach: the write table skipped" 's/for (int i = 0; reach_write\[i\]; i++) {/for (int i = 0; 0; i++) {/' userns || k=1
mut "reach: the rw table skipped" 's/for (int i = 0; reach_rw\[i\]; i++) {/for (int i = 0; 0; i++) {/' userns || k=1
mut "reach: the tsm entry skipped" 's/if (mkdir(p, 0700) == 0) {/if (0) {/' userns || k=1
mut "reach: /proc skipped" 's/if (who\[i\] <= 0) continue;/continue;/' userns || k=1
mut "spawn: the filter never installed" 's/if ((flags \& SPAWN_FILTER) \&\& app_seccomp_install() != 0) {/if (0) {/' userns || k=1
mut "filter: no AF_VSOCK rule" '/APP_ARG0_EQ(APP_NR_socket, APP_AF_VSOCK, APP_EPERM),/d' userns header || k=1
mut "filter: pidfd_getfd allowed" '/APP_RULE(APP_NR_pidfd_getfd, APP_EPERM),/d' userns header || k=1
mut "filter: clone3 allowed" '/APP_RULE(APP_NR_clone3, APP_ENOSYS),/d' userns header || k=1
mut "filter: the arch check disarmed" 's/APP_JUMP(APP_BPF_JEQ_K, APP_AUDIT_ARCH_X86_64, 1, 0),/APP_JUMP(APP_BPF_JEQ_K, APP_AUDIT_ARCH_X86_64, 1, 1),/' userns header || k=1
mut "filter: kexec_load only EPERM" 's/APP_RULE(APP_NR_kexec_load, APP_RET_KILL_PROCESS),/APP_RULE(APP_NR_kexec_load, APP_EPERM),/' userns header || k=1
[ $k = 0 ] && echo "dominit hardening mutants: all killed" || echo "dominit hardening mutants: FAIL"
[ $g = 0 ] && [ $m = 0 ] && [ $k = 0 ]
