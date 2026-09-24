/* planeinit: PID 1 of an M4b plane domain - a domain that ADMITS its artifacts to the measured SVSM and then
 * serves, so the attestation it hands a client is bound by authority outside this guest.
 *
 * It is dominit plus admission, and the order is the whole point:
 *
 *   1. mount, load vsock, bring up loopback - the domain has no NIC, vsock is its only channel
 *   2. load appidmod and ADMIT this plane's two artifacts: the app bundle and the runtime SET - every file in
 *      /rt, the interpreter and shared libraries included (rtset.h). The SVSM compares each against the digest
 *      compiled into its own measured image and REFUSES a mismatch.
 *   3. only then start the runtime, and check from its /proc maps that every executable file it mapped is an
 *      admitted member and every admitted ELF was mapped. Then the front, with -appid pointing at the plane's
 *      sysfs directory. The front registers its freshly minted TLS key with the SVSM and afterwards sends only a
 *      nonce; the SVSM computes report_data itself from that key, the nonce and its own compiled-in tables.
 *   4. if admission or the maps check fails, POWER OFF instead of serving.
 *
 * Step 4 is the fail-closed property and it is why this is a separate init rather than a flag on dominit. A
 * domain that served after a refused admission would answer /attest with no hardware report and a T0 document,
 * which is a WEAKER claim silently substituted for a stronger one - exactly the shape a client cannot detect
 * unless it pins the tier. Refusing to serve makes the failure loud at the only place that can see it.
 *
 * What this init does NOT do: it never computes or supplies a binding, and it never writes report_data. Those
 * belong to the SVSM, and the reason is that this guest's image is OUTSIDE the launch measurement on the IGVM
 * path - so anything this code asserted about the app's identity would be asserted by unmeasured code.
 */
#define _GNU_SOURCE
#include <cpuid.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysinfo.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define EV_PREFIX "PLANE"
#include "plane.h"

/* Where the boundary self-test is left for the front to relay. A tuple the VERIFIER can judge, not prose. */
#define BOUNDARY_PATH "/tmp/boundary"

/* the artifact kinds the SVSM's tables name, in the order this image admits them */
/* The number of VMPCKs the kernel will hand out: get_vmpck switches on 0..3. */
#define VMPL_MAX_KEYS 4

#define KIND_BUNDLE  "0"
#define KIND_RUNTIME "1"

static void lo_up(void) {
    struct ifreq ifr = {0};
    strcpy(ifr.ifr_name, "lo");
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0 || ioctl(s, SIOCGIFFLAGS, &ifr) < 0) { say("lo", strerror(errno)); return; }
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) say("lo_up", strerror(errno));
    close(s);
}

static pid_t spawn(char *const argv[]) {
    pid_t pid = fork();
    if (pid == 0) {
        char *envp[] = {"HOME=/tmp", "PATH=/rt", NULL};
        execve(argv[0], argv, envp);
        _exit(127);
    }
    return pid;
}

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* The runtime set this plane admitted: what the maps check compares the running runtime against. */
static struct rtset runtime_set;

/* Ask the SVSM to admit the staged slot. Any failure is fatal to the domain. */
static int admit_staged(const char *kind, const char *key) {
    char msg[256];
    /* `admit` takes the KIND, not a flag. admit_store parses it with kstrtouint and refuses anything outside
     * the table, so writing "1" here admitted the RUNTIME slot while the bundle was selected - which came back
     * as EINVAL from the module with no SVSM call made at all, and `result` showing the previous success. */
    int e = puts_("admit", kind);
    if (e != 0) {
        /* The SVSM's own refusal code is in `result`; print it, because "admission failed" without the code
         * cannot be told from a harness that never staged anything. */
        snprintf(msg, sizeof msg, "REFUSED: %s", strerror(-e));
        say(key, msg);
        show("refusal", "result");
        return -1;
    }
    say(key, "admitted");
    return 0;
}

/* Admit one file: pick its slot, stage its bytes, ask the SVSM. */
static int admit(const char *kind, const char *path, const char *key) {
    char msg[256];
    if (puts_("slot", kind) != 0) { say(key, "slot select failed"); return -1; }
    int e = stage(path, 0);
    if (e != 0) {
        snprintf(msg, sizeof msg, "staging %s failed: %s", path, strerror(-e));
        say(key, msg);
        return -1;
    }
    return admit_staged(kind, key);
}

/* Admit the runtime SET of `dir` - every file the runtime is executed from, not only its ELF. */
static int admit_runtime_set(const char *dir, const char *key) {
    char err[1024], msg[1100];
    if (puts_("slot", KIND_RUNTIME) != 0) { say(key, "slot select failed"); return -1; }
    if (stage_runtime_set(&runtime_set, dir, err, sizeof err) != 0) {
        snprintf(msg, sizeof msg, "staging the runtime set failed: %s", err);
        say(key, msg);
        return -1;
    }
    say_runtime_set("runtime_member", &runtime_set);
    return admit_staged(KIND_RUNTIME, key);
}

/* Dump the kernel-log lines that explain a module's refusal.
 *
 * WHY THIS IS NECESSARY AND NOT A NICETY. finit_module gives ENODEV for sev-guest whatever the cause, because
 * sev-guest registers with module_platform_driver_probe (sev-guest.c:711) and __platform_driver_probe returns
 * -ENODEV whenever nothing ends up bound. At least three different things produce it: the one this test wants,
 * snp_msg_init finding no key ("Empty VMPCK%d communication key", arch/x86/coco/sev/core.c:1569, probe returns
 * -EINVAL so the device stays unbound); no sev-guest platform device existing at all; and the probe's own
 * cc_platform_has check. So "No such device" is CONSISTENT with the SVSM withholding the keys and does not
 * establish it - and this guest decides snp=1 from CPUID, which is the hardware's word, not the kernel's.
 *
 * The reason is in the ring buffer either way: pr_err is KERN_ERR, which loglevel=3 keeps off the console but
 * never out of /dev/kmsg. So read it, and let the probe say why it failed instead of being interpreted.
 * Raised by the independent reviewer (enclave-59, 2026-09-24) against exactly this inference.
 */
static void kmsg_reason(const char *key, const char *needle) {
    int fd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { say(key, "no /dev/kmsg, so the refusal cannot state its own reason"); return; }
    char rec[1024], last[1024];
    int found = 0;
    ssize_t n;
    /* one read() is one record; EAGAIN means the buffer is drained.
     *
     * Keep the LAST match, not the first. /dev/kmsg is reopened for each probe and reads from the oldest
     * record, so reporting the first match gave the SECOND probe the FIRST probe's line - the vmpck_id=2 run
     * was labelled "Empty VMPCK0", which is a wrong attribution in an evidence line and exactly the kind of
     * thing that reads as corroboration. The most recent matching record is the one this probe produced. */
    while ((n = read(fd, rec, sizeof rec - 1)) > 0) {
        rec[n] = 0;
        char *msg = strchr(rec, ';');
        if (!msg) continue;
        msg++;
        char *nl = strchr(msg, '\n');
        if (nl) *nl = 0;
        if (strstr(msg, needle)) {
            snprintf(last, sizeof last, "%s", msg);
            found = 1;
        }
    }
    close(fd);
    if (found) say(key, last);
    else say(key, "the kernel log carries no line naming it, so the refusal is unexplained");
}

/* Can this plane mint its own reports? It must NOT be able to, and the way to show that is to TRY.
 *
 * The image carries tsm_report and sev-guest deliberately. Leaving them out would make the absence of a report
 * interface a property of the packaging, which a verifier cannot check; carrying them and having them REFUSE for
 * want of a key is evidence. A guest that can load sev-guest with vmpck_id=0 demonstrably holds VMPCK0 and is
 * therefore not confined beneath a VMPL0 monitor, whatever level its reports name - so if either load succeeds
 * this domain must not serve.
 *
 * Returns 0 when both refused, which is the only acceptable outcome.
 */
static int probe_no_vmpck(void) {
    int held = 0;
    insmod_args("/tsm_report.ko.zst", "", "tsm_report_core",
                "loaded (the generic report core holds no key; this says nothing about VMPCKs)",
                "did not load: ");
    /* vmpck_id EXPLICITLY, both the monitor's level and this plane's own: an unparameterised load would pick
     * this guest's level and test the wrong key. */
    if (access("/sev-guest.ko.zst", R_OK) != 0) {
        say("vmpck_probe", "IMPOSSIBLE: /sev-guest.ko.zst is not in the image, so key absence is unproven");
        return -1;
    }
    /* EVERY key the kernel will accept, not just this plane's and the monitor's. get_vmpck switches on 0..3
     * (arch/x86/coco/sev/core.c:1510) and vmpck_id is a plain module parameter, so a guest can ask for any of
     * them - and the SVSM's copy_with_no_vmpck clears 0..VMPL_MAX for exactly that reason. An earlier version of
     * this probe tried only 0 and 2, which evidenced half the space while the text claimed the plane holds no
     * VMPCK at all. */
    for (int id = 0; id < VMPL_MAX_KEYS; id++) {
        char arg[32], key[32], rkey[32];
        snprintf(arg, sizeof arg, "vmpck_id=%d", id);
        snprintf(key, sizeof key, "vmpck%d", id);
        snprintf(rkey, sizeof rkey, "vmpck%d_reason", id);
        int fd = open("/sev-guest.ko.zst", O_RDONLY | O_CLOEXEC);
        if (fd < 0) { say(key, strerror(errno)); held = 1; continue; }
        long r = syscall(SYS_finit_module, fd, arg, 4);
        close(fd);
        if (r == 0) {
            char msg[128];
            snprintf(msg, sizeof msg, "LOADED - this plane HOLDS VMPCK%d and can mint its own reports", id);
            say(key, msg);
            held = 1;
            continue;
        }
        say(key, strerror(errno));
        /* The errno alone cannot say WHY. Each probe must name ITS OWN key, or the refusal is unexplained. */
        kmsg_reason(rkey, "VMPCK");
    }
    return held ? -1 : 0;
}

/* The boundary self-test the front relays, in the k=v shape m2/judge.mjs checkBoundary judges.
 *
 * vmpl0=refused here means something stronger than it did on the M3 path, where the tuple came from
 * tsm-report's privlevel_floor and could be produced by a command-line parameter alone. Here it records that
 * sev-guest REFUSED TO LOAD for want of VMPCK0 - there is no key to configure around. */
static int write_boundary(int vmpl) {
    char buf[200];
    int n = snprintf(buf, sizeof buf, "tier=t1 vmpl=%d vmpl_floor=%d vmpl0=refused", vmpl, vmpl);
    int fd = open(BOUNDARY_PATH, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0 || n <= 0) { say("boundary", strerror(errno)); return -1; }
    int ok = write(fd, buf, n) == n;
    close(fd);
    say("boundary", ok ? buf : "write failed");
    return ok ? 0 : -1;
}

/* This plane's own VMPL, read from the module's status line rather than assumed: the SVSM serves only the
 * calling plane, so a tuple claiming a level this plane is not would be a false statement about confinement. */
static int read_vmpl(void) {
    char path[128], buf[512] = {0};
    snprintf(path, sizeof path, SYS "status");
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) return -1;
    char *p = strstr(buf, "vmpl=");
    if (!p) return -1;
    int v = atoi(p + 5);
    return (v >= 0 && v < 8) ? v : -1;
}

static void power_off(const char *why) {
    say("serving", "NO");
    say("reason", why);
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
    double boot_ms = now_ms();
    evfd = open("/dev/ttyS1", O_WRONLY | O_CLOEXEC);

    unsigned a, b, c, d;
    __cpuid(0x8000001f, a, b, c, d);
    int snp = (a >> 4) & 1;
    struct sysinfo si;
    sysinfo(&si);
    char line[256];
    snprintf(line, sizeof line, "snp=%d vcpus=%ld memMiB=%lu boot_ms=%.0f", snp,
             sysconf(_SC_NPROCESSORS_ONLN), (unsigned long)(si.totalram * si.mem_unit >> 20), boot_ms);
    say("boot", line);

    insmod_zst("/vsock.ko.zst");
    insmod_zst("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod_zst("/vmw_vsock_virtio_transport.ko.zst");
    lo_up();

    /* The plane module, and then the two admissions. No report interface is loaded at all: this plane holds no
     * VMPCK, so sev-guest could not serve a report even if it were present, and the SVSM is the only path. */
    insmod("/appidmod.ko");
    show("status_before", "status");
    if (admit(KIND_BUNDLE, "/app.bundle", "bundle") != 0) power_off("the SVSM refused this plane's app bundle");
    if (admit_runtime_set("/rt", "runtime") != 0) power_off("the SVSM refused this plane's runtime set");
    show("status_after", "status");
    show("whoami", "whoami");

    /* Confinement, demonstrated rather than asserted, and fatal if it does not hold. A plane that can mint its
     * own reports would serve documents whose VMPL field says 2 while nothing more privileged is above it. */
    if (probe_no_vmpck() != 0) power_off("this plane holds a VMPCK, so it is not confined beneath the SVSM");
    int vmpl = read_vmpl();
    if (vmpl <= 0) power_off("could not read this plane's VMPL, so no boundary self-test can be stated");
    if (write_boundary(vmpl) != 0) power_off("could not write the boundary self-test");

    char *app[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "serve", "-S", "cli",
                   "-C", "cache=n", "--addr", "127.0.0.1:8080", "/app.wasm", NULL};
    char *front[] = {"/front", "-port", "443", "-upstream", "127.0.0.1:8080",
                     "-appid", "/sys/kernel/appid", "-boundary", BOUNDARY_PATH, NULL};
    char *app_env[] = {"HOME=/tmp", "PATH=/rt", NULL};
    int se = 0;
    pid_t app_pid = rtset_spawn(app, app_env, &se);
    if (app_pid < 0) {
        say("runtime_maps", strerror(se));
        power_off("the runtime did not start");
    }
    /* The admitted set is what the SVSM hashed. Whether it is what RUNS is a separate question, answered from the
     * running process's own maps before anything is served: every executable file it mapped must be an admitted
     * member (the same file object, not merely the same path), and every admitted ELF must have been mapped, so
     * the check cannot pass by looking before the loader finished. This covers what the loader mapped at start;
     * a library opened later would not be seen here. */
    {
        char err[1024], outside[1024], msg[1400];
        int polls = 0;
        if (rtset_wait_coverage(&runtime_set, app_pid, 10000, outside, sizeof outside, err, sizeof err, &polls) != 1) {
            say("runtime_maps", err);
            kill(app_pid, SIGKILL);
            power_off("the running runtime maps code outside the admitted set, or never finished loading it");
        }
        snprintf(msg, sizeof msg, "ok elf_members_mapped=%d/%d polls=%d outside_data=%s",
                 rtset_elf_members(&runtime_set), rtset_elf_members(&runtime_set), polls,
                 outside[0] ? outside : "none");
        say("runtime_maps", msg);
    }
    pid_t front_pid = spawn(front);
    snprintf(line, sizeof line, "app=%d front=%d at_ms=%.0f", app_pid, front_pid, now_ms());
    say("started", line);

    for (;;) {
        int st = 0;
        pid_t w = wait(&st);
        if (w < 0 && errno == ECHILD) break;
        if (w == app_pid || w == front_pid) {
            snprintf(line, sizeof line, "%s exited status=%d", w == app_pid ? "app" : "front",
                     WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
            say("ERROR", line);
            break;
        }
    }
    power_off("a server exited");
    return 0;
}
