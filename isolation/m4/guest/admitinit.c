/* admitinit: PID 1 for the M4b admission guest.
 *
 * It boots at VMPL2 under COCONUT-SVSM (the m3b IGVM path), loads appidmod, and walks the whole admission
 * sequence in one pass, printing `ADMIT <key>=<value>` for the harness to score. Silence is never a result:
 * every step prints, including the ones expected to fail.
 *
 * The order is the test. Before anything is admitted the SVSM must refuse to NAME this plane and refuse to
 * fetch a report for it; after the bundle alone it must still refuse, because the runtime image is part of
 * what the identity covers; only with both must it speak. Then the artifact pages must be unwritable, which
 * is the hardware half and is attempted LAST because the fault may end the guest.
 *
 * /admit.mode selects what to stage for kind 0:
 *   good      the bundle this image carries, whose sha256 is the AppID the SVSM expects for this plane
 *   tampered  the same bundle with one byte changed, which must be REFUSED and must leave the plane unnamed
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
#include <unistd.h>

static void say(const char *k, const char *v) { printf("ADMIT %s=%s\n", k, v); fflush(stdout); }

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { say("insmod", strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 0);
    say("insmod", r == 0 ? "ok" : strerror(errno));
    close(fd);
}

/* write one sysfs file; returns 0 on success, -errno on failure, so a REFUSAL is a result and not a crash */
static int put(const char *path, const void *buf, size_t n) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -errno;
    ssize_t w = write(fd, buf, n);
    int e = w == (ssize_t)n ? 0 : -errno;
    close(fd);
    return e;
}

static int puts_(const char *path, const char *s) { return put(path, s, strlen(s)); }

static void show(const char *key, const char *path) {
    char buf[8192] = {0};
    int fd = open(path, O_RDONLY);
    if (fd < 0) { say(key, strerror(errno)); return; }
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 0) { say(key, strerror(errno)); return; }
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' ')) buf[--n] = 0;
    say(key, buf[0] ? buf : "(empty)");
}

/* stage a file into the module's buffer, in chunks, and report how much landed */
static int stage(const char *path, int flip_byte) {
    char buf[65536];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -errno;
    if (puts_("/sys/kernel/appid/reset", "1") != 0) { close(fd); return -EIO; }
    size_t total = 0;
    ssize_t n;
    int flipped = 0;
    while ((n = read(fd, buf, sizeof buf)) > 0) {
        if (flip_byte && !flipped) { buf[0] ^= 0xff; flipped = 1; }
        int e = put("/sys/kernel/appid/artifact", buf, n);
        if (e != 0) { close(fd); return e; }
        total += n;
    }
    close(fd);
    return total > 0 ? 0 : -EIO;
}

int main(void) {
    mkdir("/proc", 0555); mkdir("/sys", 0555);
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    setvbuf(stdout, NULL, _IOLBF, 0);

    char mode[32] = "good";
    FILE *f = fopen("/admit.mode", "r");
    if (f) { if (fscanf(f, "%31s", mode) != 1) strcpy(mode, "good"); fclose(f); }
    say("mode", mode);
    int tampered = strcmp(mode, "tampered") == 0;

    insmod("/appidmod.ko");

    /* 1. nothing admitted: the SVSM must not name this plane and must not fetch a report for it */
    show("status_before", "/sys/kernel/appid/status");
    show("whoami_before", "/sys/kernel/appid/whoami");
    say("report_before", puts_("/sys/kernel/appid/report", "1") == 0 ? "GRANTED" : "refused");

    /* 2. the bundle: staged from the bytes this image carries, hashed and frozen by the SVSM */
    int e = stage("/app.bundle", tampered);
    say("stage_bundle", e == 0 ? "ok" : strerror(-e));
    show("bundle_staged", "/sys/kernel/appid/artifact");
    e = puts_("/sys/kernel/appid/admit", "0");
    say("admit_bundle", e == 0 ? "ok" : strerror(-e));
    show("status_after_bundle", "/sys/kernel/appid/status");
    /* the bundle alone must not be enough: the runtime image is part of what the identity covers */
    show("whoami_after_bundle", "/sys/kernel/appid/whoami");

    /* 3. the runtime image, the bytes that will compile the component */
    e = stage("/rt/wasmtime", 0);
    say("stage_runtime", e == 0 ? "ok" : strerror(-e));
    show("runtime_staged", "/sys/kernel/appid/artifact");
    e = puts_("/sys/kernel/appid/admit", "1");
    say("admit_runtime", e == 0 ? "ok" : strerror(-e));
    show("status_after_runtime", "/sys/kernel/appid/status");

    /* 4. now, and only now, the SVSM may speak for this plane */
    show("whoami", "/sys/kernel/appid/whoami");
    /* a bind a verifier would choose; the app half is the SVSM's and is not ours to supply */
    say("bind", "put");
    e = puts_("/sys/kernel/appid/bind",
              "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90");
    say("bind_set", e == 0 ? "ok" : strerror(-e));
    e = puts_("/sys/kernel/appid/report", "1");
    say("report", e == 0 ? "GRANTED" : strerror(-e));
    show("report_hex", "/sys/kernel/appid/report");

    /* 5. admitting a kind twice must be refused: a second region vouched for would let this plane choose */
    e = puts_("/sys/kernel/appid/admit", "0");
    say("admit_bundle_again", e == 0 ? "GRANTED" : "refused");

    /* 6. the hardware half, LAST: the artifact's pages must no longer be writable by this plane. The write
     * is expected to fault, which may end the guest - so nothing the harness needs comes after it. */
    say("poke", "writing to the admitted artifact region now");
    e = puts_("/sys/kernel/appid/poke", "0 255");
    say("poke_result", e == 0 ? "WROTE" : strerror(-e));
    show("poke_readback", "/sys/kernel/appid/artifact");

    say("done", "ok");
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}
