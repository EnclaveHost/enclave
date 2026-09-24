/* admitinit: PID 1 for the M4b admission guest.
 *
 * It boots at VMPL2 under COCONUT-SVSM (the m3b IGVM path), loads appidmod, and walks the admission sequence
 * in one pass, printing `ADMIT <key>=<value>` for the harness to score. Silence is never a result: every step
 * prints, including the ones expected to fail.
 *
 * The ORDER is the test. Before anything is admitted the SVSM must refuse to NAME this plane and refuse to
 * fetch a report for it. After the bundle alone it must still refuse, because the runtime image is part of what
 * the identity covers. Only with both may it speak. Then an admitted page must not be re-validatable, while a
 * page of the same buffer that was never admitted must be - otherwise "refused" would only mean "the probe
 * does not work".
 *
 * /admit.mode selects what to stage for kind 0:
 *   good      the bundle this image carries, whose sha256 is the AppID the SVSM expects for this plane
 *   tampered  the same bundle with one byte flipped, which must be REFUSED, must leave the plane unnamed, and
 *             must leave the staging pages UNFROZEN - which the poke then demonstrates
 *
 * There is no poke in the good path: a write to a frozen page does not fault, it livelocks the vCPU (KVM's
 * RMP-fault handler traces and returns for a 4 KiB entry), which would be a hang rather than evidence.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define SYS "/sys/kernel/appid/"
#define CHUNK 4096            /* kernfs caps one sysfs write at PAGE_SIZE; more is silently truncated */

/* Results go to /dev/ttyS1 when it exists, and to the console either way.
 *
 * The console is shared with the SVSM's own output and has no flow control, so concurrent writers drop bytes:
 * a first run on hardware lost five consecutive result lines and mangled a sixth into an SVSM request-loop
 * message. A harness cannot score a channel that loses evidence, so the scoreable copy gets its own port. */
static int evfd = -1;

static void say(const char *k, const char *v) {
    char line[9000];
    int n = snprintf(line, sizeof line, "ADMIT %s=%s\n", k, v);
    if (n < 0) return;
    if (n > (int)sizeof line - 1) n = sizeof line - 1;
    if (evfd >= 0) {
        ssize_t off = 0;
        while (off < n) {
            ssize_t w = write(evfd, line + off, n - off);
            if (w <= 0) break;
            off += w;
        }
        fsync(evfd);
    }
    fputs(line, stdout);
    fflush(stdout);
}

/* Load a module with arguments and report the outcome in the caller's own words.
 *
 * The first version printed "LOADED - this guest holds a message key" for WHICHEVER module loaded, including
 * tsm_report - which is the generic report core and loads with no key at all. That put a false sentence into a
 * committed evidence file, which is worse than a bug in code: a reviewer reading the evidence would have drawn
 * the opposite conclusion. Each step now says only what its own result means. */
static void insmod_args(const char *p, const char *args, const char *key,
                        const char *on_load, const char *on_fail_prefix) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    char msg[256];
    if (fd < 0) { say(key, "absent from the image"); return; }
    long r = syscall(SYS_finit_module, fd, args, 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r == 0) say(key, on_load);
    else { snprintf(msg, sizeof msg, "%s%s", on_fail_prefix, strerror(errno)); say(key, msg); }
    close(fd);
}

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { say("insmod", strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 0);
    say("insmod", r == 0 ? "ok" : strerror(errno));
    close(fd);
}

/* A SHORT write is a failure: kernfs returns the truncated length with errno untouched, so a caller checking
 * only "did write() fail" would stage every first 4 KiB of each chunk and blame the digest later. */
static int put(const char *name, const void *buf, size_t n) {
    char path[128];
    snprintf(path, sizeof path, SYS "%s", name);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -errno;
    ssize_t w = write(fd, buf, n);
    int e = w == (ssize_t)n ? 0 : (w < 0 ? -errno : -EIO);
    close(fd);
    return e;
}

static int puts_(const char *name, const char *s) { return put(name, s, strlen(s)); }

static void show_path(const char *key, const char *path) {
    char buf[512] = {0};
    int fd = open(path, O_RDONLY | O_DIRECTORY);
    if (fd >= 0) { close(fd); say(key, "present"); return; }
    say(key, strerror(errno));
    (void)buf;
}

static void show(const char *key, const char *name) {
    char path[128], buf[8192] = {0};
    snprintf(path, sizeof path, SYS "%s", name);
    int fd = open(path, O_RDONLY);
    if (fd < 0) { say(key, strerror(errno)); return; }
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 0) { say(key, strerror(errno)); return; }
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' ')) buf[--n] = 0;
    say(key, buf[0] ? buf : "(empty)");
}

/* stage a file into the active slot in PAGE_SIZE chunks, failing on the first short or refused write */
static int stage(const char *path, int flip_byte) {
    static char buf[CHUNK];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -errno;
    size_t total = 0;
    ssize_t n;
    int flipped = 0;
    while ((n = read(fd, buf, sizeof buf)) > 0) {
        if (flip_byte && !flipped) { buf[0] ^= 0xff; flipped = 1; }
        int e = put("artifact", buf, n);
        if (e != 0) { close(fd); return e; }
        total += n;
    }
    if (n < 0) { close(fd); return -errno; }
    close(fd);
    return total > 0 ? 0 : -EIO;
}

static void stop(void) {
    say("done", "ok");
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}

/* the stand-in transport key, built once and reused when reclaim forgets it */
static char keyhex[256 * 2 + 2];

int main(void) {
    mkdir("/proc", 0555); mkdir("/sys", 0555);
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    setvbuf(stdout, NULL, _IOLBF, 0);
    mkdir("/dev", 0755);
    mknod("/dev/ttyS1", S_IFCHR | 0600, makedev(4, 65));
    evfd = open("/dev/ttyS1", O_WRONLY | O_CLOEXEC);

    char mode[32] = "good";
    FILE *f = fopen("/admit.mode", "r");
    if (f) { if (fscanf(f, "%31s", mode) != 1) strcpy(mode, "good"); fclose(f); }
    say("mode", mode);
    int tampered = strcmp(mode, "tampered") == 0;

    /* 0. KEY ABSENCE, before anything else, because everything else depends on it.
     *
     * A guest that holds a VMPCK can ask the PSP for a signed report over its own GHCB, with report_data of
     * its choosing and any VMPL from its own level downwards, without involving the SVSM at all - which
     * bypasses every gate the SVSM puts in front of a report. The SVSM therefore hands this guest a secrets
     * page with all four VMPCKs cleared, and the observable consequence is that Linux's sev-guest driver
     * finds no usable key and REFUSES TO PROBE.
     *
     * So this must FAIL. If it succeeds, this guest can mint its own reports, admission proves nothing, and
     * the run should be read as a failure however well the rest of it goes. It is also the key-absence test
     * that the forgeable vmpl0=refused tuple could never perform (isolation/DESIGN.md section 12). */
    /* the report core holds no key and is expected to load; it is the plumbing, not the authority */
    insmod_args("/tsm_report.ko.zst", "", "tsm_report_core",
                "loaded (the generic report core holds no key; this says nothing about VMPCKs)",
                "did not load: ");
    /* vmpck_id=0 EXPLICITLY. This is the DESIGN.md replacement for the forgeable vmpl0=refused tuple: a guest
     * that can load sev-guest with vmpck_id=0 demonstrably holds VMPCK0 and is therefore NOT beneath a VMPL0
     * monitor. An unparameterised load would default to this guest's own level and test the wrong key. */
    insmod_args("/sev-guest.ko.zst", "vmpck_id=0", "sev_guest_vmpck0",
                "LOADED - this guest HOLDS VMPCK0, so it is not confined beneath a VMPL0 monitor",
                "refused, no VMPCK0: ");
    /* and its own level's key, which is what it would use by default */
    insmod_args("/sev-guest.ko.zst", "vmpck_id=2", "sev_guest_vmpck2",
                "LOADED - this guest holds VMPCK2, so it can mint its own reports",
                "refused, no VMPCK2: ");
    show_path("tsm_report_dir", "/sys/kernel/config/tsm");

    /* the module splits both staging buffers to 4 KiB RMP entries at load time and checks a canary; a failure
     * here is a staging problem and must not be read as a digest problem later */
    insmod("/appidmod.ko");
    show("slot0", "slot");

    /* 1. nothing admitted: the SVSM must not name this plane and must not fetch a report for it */
    show("status_before", "status");
    show("whoami_before", "whoami");
    say("report_before", puts_("report", "1") == 0 ? "GRANTED" : "refused");
    show("report_before_result", "result");

    /* 2. the bundle */
    int e = puts_("slot", "0");
    say("select_bundle_slot", e == 0 ? "ok" : strerror(-e));
    e = stage("/app.bundle", tampered);
    say("stage_bundle", e == 0 ? "ok" : strerror(-e));
    show("bundle_staged", "artifact");
    e = puts_("admit", "0");
    say("admit_bundle", e == 0 ? "ok" : strerror(-e));
    show("admit_bundle_result", "result");
    show("status_after_bundle", "status");
    /* the bundle alone must not be enough: the runtime image is part of what the identity covers */
    show("whoami_after_bundle", "whoami");

    if (tampered) {
        /* the point is what did NOT happen: a refused admission must have frozen nothing, so this write must
         * SUCCEED. It is done here, before any successful admission, so the pages under it were never frozen. */
        say("poke", "writing to the region a REFUSED admission must not have frozen");
        e = puts_("poke", "0 255");
        say("poke_result", e == 0 ? "WROTE" : strerror(-e));
        show("status_final", "status");
        show("whoami_final", "whoami");
        say("report_final", puts_("report", "1") == 0 ? "GRANTED" : "refused");
        stop();
    }

    /* 3. the runtime image, in its own slot: the bundle's pages are frozen now, and staging into them would
     * livelock rather than fail */
    e = puts_("slot", "1");
    say("select_runtime_slot", e == 0 ? "ok" : strerror(-e));
    e = stage("/rt/wasmtime", 0);
    say("stage_runtime", e == 0 ? "ok" : strerror(-e));
    show("runtime_staged", "artifact");
    e = puts_("admit", "1");
    say("admit_runtime", e == 0 ? "ok" : strerror(-e));
    show("admit_runtime_result", "result");
    show("status_after_runtime", "status");

    /* 4. now, and only now, the SVSM may speak for this plane */
    show("whoami", "whoami");

    /* 4a. Register this plane's transport key. A stand-in for a real domain TLS key: what matters is that the
     * SVSM binds THE KEY THIS PLANE REGISTERED, which a verifier checks by recomputing Bind2 over the same
     * bytes. The report cannot carry any other key afterwards, and a second registration must be refused. */
    for (int i = 0; i < 91; i++) snprintf(keyhex + i * 2, 3, "%02x", (i * 11 + 5) & 0xff);
    e = puts_("key", keyhex);
    say("register_key", e == 0 ? "ok" : strerror(-e));
    show("register_key_result", "result");
    show("key_registered", "key");
    e = puts_("key", keyhex);
    say("register_key_again", e == 0 ? "GRANTED" : "refused");
    show("register_key_again_result", "result");

    /* 4b. the verifier's nonce. The SVSM computes the binding over the registered key, this nonce and the
     * RuntimeID compiled into its measured image; the caller no longer supplies the binding at all. */
    e = puts_("bind", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90");
    say("nonce_set", e == 0 ? "ok" : strerror(-e));
    e = puts_("report", "1");
    say("report", e == 0 ? "GRANTED" : strerror(-e));
    show("report_result", "result");          /* before anything else overwrites the SVSM's own code */
    show("report_hex", "report");

    /* 5. admitting a kind twice must be refused: a second region vouched for would let this plane choose */
    e = puts_("admit", "0");
    say("admit_bundle_again", e == 0 ? "GRANTED" : "refused");
    show("admit_again_result", "result");

    /* 6. an admitted page must not be re-validatable. PVALIDATE(invalid) through the SVSM, which answers -
     * unlike writing to a frozen page, which livelocks. */
    say("thaw", "asking the SVSM to invalidate page 0 of the admitted runtime");
    e = puts_("thaw", "0 0");
    say("thaw_admitted", e == 0 ? "GRANTED (the artifact can be thawed)" : "refused");
    show("thaw_admitted_result", "result");

    /* CONTROL: a page of the SAME buffer beyond what was admitted must be invalidatable, or "refused" above
     * would only mean the probe does not work. Index -1 is the first page past what was staged, so this does
     * not assume how large the runtime image is - a larger one would otherwise make the control hit an
     * ADMITTED page, get refused, and read as "the probe does not reach PVALIDATE". */
    e = puts_("thaw", "-1 0");
    say("thaw_unadmitted", e == 0 ? "allowed (the probe reaches PVALIDATE)" : "refused");
    show("thaw_unadmitted_result", "result");
    e = puts_("thaw", "-1 1");
    say("thaw_unadmitted_revalidate", e == 0 ? "ok" : strerror(-e));

    /* CONTROL: a 2 MiB entry covering an admitted page must also be refused - and the request is masked to a
     * 2 MiB boundary in the module, because otherwise the alignment check refuses it before the hook runs and
     * the "refused" would be vacuous. Score rax_out: 0x80000006 is the hook, 0x80000005 means it never ran. */
    e = puts_("thaw", "0 0 2m");
    say("thaw_admitted_2m", e == 0 ? "GRANTED (a huge entry thawed it)" : "refused");
    show("thaw_admitted_2m_result", "result");

    say("poke", "skipped while the artifacts are admitted: a write to a frozen page livelocks the vCPU");

    /* 7. RECLAIM. contract.Lifecycle promises exactly one reclamation however a domain ends; this is the half a
     * plane performs at its own request. Everything after it checks that the SVSM really let go. */
    e = puts_("reclaim", "1");
    say("reclaim", e == 0 ? "ok" : strerror(-e));
    show("reclaim_result", "result");
    show("status_after_reclaim", "status");        /* admitted=0x00 and key=0 */
    show("whoami_after_reclaim", "whoami");       /* must be refused: the plane is unnamed again */
    say("report_after_reclaim", puts_("report", "1") == 0 ? "GRANTED" : "refused");
    show("report_after_reclaim_result", "result");

    /* the pages must be BACK and BLANK: writable again, and carrying nothing of the old artifact */
    e = puts_("slot", "1");
    say("select_runtime_slot_again", e == 0 ? "ok" : strerror(-e));
    show("peek_runtime_after_reclaim", "peek");   /* all zeros */
    say("poke_after_reclaim", "writing to a page the SVSM unfroze");
    e = puts_("poke", "0 255");
    say("poke_after_reclaim_result", e == 0 ? "WROTE" : strerror(-e));

    /* and the frames must have left the PVALIDATE hook's list, not merely be consulted less often */
    e = puts_("thaw", "0 0");
    say("thaw_after_reclaim", e == 0 ? "allowed (the frame left the hook's list)" : "refused");
    show("thaw_after_reclaim_result", "result");
    e = puts_("thaw", "0 1");
    say("thaw_after_reclaim_revalidate", e == 0 ? "ok" : strerror(-e));

    /* 8. a second RECLAIM must be a CODED no-op, not a silent success */
    e = puts_("reclaim", "1");
    say("reclaim_again", e == 0 ? "GRANTED" : "refused");
    show("reclaim_again_result", "result");

    /* 9. the full cycle: re-stage, re-admit, re-register, and the SVSM names the plane again. The module reset
     * its own staged lengths when the reclaim succeeded - without that, staging would append at a stale offset
     * over pages the SVSM had zeroed underneath it. */
    e = puts_("slot", "0");
    say("re_select_bundle", e == 0 ? "ok" : strerror(-e));
    e = stage("/app.bundle", 0);
    say("re_stage_bundle", e == 0 ? "ok" : strerror(-e));
    show("re_staged_bundle", "artifact");
    e = puts_("admit", "0");
    say("re_admit_bundle", e == 0 ? "ok" : strerror(-e));
    show("re_admit_bundle_result", "result");
    e = puts_("slot", "1");
    say("re_select_runtime", e == 0 ? "ok" : strerror(-e));
    e = stage("/rt/wasmtime", 0);
    say("re_stage_runtime", e == 0 ? "ok" : strerror(-e));
    e = puts_("admit", "1");
    say("re_admit_runtime", e == 0 ? "ok" : strerror(-e));
    show("re_admit_runtime_result", "result");
    show("status_after_re_admit", "status");
    show("whoami_after_re_admit", "whoami");      /* named again */
    /* the key was forgotten with the naming, so a report needs it registered again */
    e = puts_("key", keyhex);
    say("re_register_key", e == 0 ? "ok" : strerror(-e));
    show("key_registered_again", "key");
    e = puts_("report", "1");
    say("report_after_re_admit", e == 0 ? "GRANTED" : strerror(-e));
    show("report_after_re_admit_result", "result");
    /* The BYTES, not just the success code. Without them the post-cycle report's binding over the RE-registered
     * key, its level and its app ID are known only from the SVSM saying it worked - which is an inference about
     * the mechanism rather than evidence of it, and the first report is checked from its bytes. With the same key
     * and nonce this report_data should equal the first report's exactly, which is itself worth seeing. */
    show("report_after_re_admit_hex", "report");

    stop();
}
