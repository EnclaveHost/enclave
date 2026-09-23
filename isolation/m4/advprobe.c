/* M4a adversary: a COMPROMISED app, modelled as native code with root in its OWN SNP guest, trying to
 * reach the app in another SNP guest.
 *
 * This is the honest adversary for the guest-per-app shape. In M3a the adversary was a domain's uid inside a
 * shared guest, and the monitor and guest kernel were what it pushed against. Here the app owns its whole
 * guest, so the only thing between it and another app is the SEV-SNP guest boundary itself: a different ASID
 * and a different memory-encryption key.
 *
 * It reports what it CAN do as well as what it cannot. In particular it CAN obtain a report naming another
 * app, because there is no monitor in this shape and it owns its own configfs. That is not a hole - it is why
 * the measurement, not a monitor, is the app-naming authority here - and the harness judges that report and
 * expects a verifier to reject it. A probe that hid its successes would be useless.
 *
 * Every line is `ADV <what>=<result>`. Silence is never a result: a probe that cannot run says so.
 *
 * target file /adv.target, written into the image at build time:
 *     "<cid> <port> <other_app_id_hex> <bind_hex>"
 *
 * bind_hex is sha256(the victim's transport key SPKI || a fresh nonce), handed to us by the harness. Using it
 * rather than filler makes the minted report WELL FORMED in every respect a verifier checks except one: it
 * binds the victim's key, names the victim's app, chains to AMD's root and meets the TCB floor. The only thing
 * that gives it away is the measurement. That is the strongest form of this attack, and the weakest form of
 * the defence, which is the pairing worth testing.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define AF_VSOCK_ 40
struct sockaddr_vm_ {
    unsigned short svm_family, svm_reserved1;
    unsigned int svm_port, svm_cid;
    unsigned char svm_zero[4];
};

static void say(const char *what, const char *result) { printf("ADV %s=%s\n", what, result); fflush(stdout); }

/* A connect that respects a deadline: SO_SNDTIMEO does not bound a blocking connect(), and a refused vsock
 * port once left the M3a probe stuck for minutes so every later result went missing. */
static void timed_connect(const char *what, struct sockaddr *sa, socklen_t len, int family, int ms) {
    int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) { say(what, "no socket"); return; }
    int rc = connect(fd, sa, len);
    if (rc == 0) { say(what, "CONNECTED"); close(fd); return; }
    if (errno != EINPROGRESS) { say(what, strerror(errno)); close(fd); return; }
    struct pollfd p = {.fd = fd, .events = POLLOUT};
    rc = poll(&p, 1, ms);
    if (rc == 0) { say(what, "timeout"); close(fd); return; }
    int err = 0; socklen_t el = sizeof err;
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el);
    say(what, err == 0 ? "CONNECTED" : strerror(err));
    close(fd);
}

static void try_vsock(const char *what, unsigned cid, unsigned port) {
    struct sockaddr_vm_ sa = {0};
    sa.svm_family = AF_VSOCK_;
    sa.svm_cid = cid;
    sa.svm_port = port;
    timed_connect(what, (struct sockaddr *)&sa, sizeof sa, AF_VSOCK_, 2000);
}

/* Is there ANY interface from here to another guest's memory? Separate SNP guests do not share memory, so
 * the honest test is to look for every mechanism that could and report that none of them leads anywhere. */
static void probe_memory(void) {
    int reachable = 0;

    int fd = open("/dev/mem", O_RDONLY);
    if (fd < 0) { say("mem_devmem", strerror(errno)); }
    else {
        /* even where /dev/mem opens, a guest sees only its OWN guest-physical space */
        unsigned char b[64];
        off_t probe_at = 0x100000; /* 1 MiB: our own low memory, not anyone else's */
        ssize_t n = pread(fd, b, sizeof b, probe_at);
        say("mem_devmem", n > 0 ? "own-gpa-only" : strerror(errno));
        close(fd);
    }

    /* /proc/iomem lists only this guest's own map; another guest's RAM has no entry here at all */
    fd = open("/proc/iomem", O_RDONLY);
    if (fd < 0) say("mem_iomem", strerror(errno));
    else {
        char buf[4096] = {0};
        ssize_t n = read(fd, buf, sizeof buf - 1);
        close(fd);
        say("mem_iomem", n > 0 ? "own-map-only" : "empty");
    }

    /* a shared-memory or ivshmem style window would be the only in-guest path to another guest's pages */
    const char *shared[] = {"/dev/shm/enclave", "/sys/bus/pci/devices/0000:00:04.0/resource2",
                            "/dev/ivshmem", "/dev/uio0", NULL};
    for (int i = 0; shared[i]; i++) {
        if (access(shared[i], R_OK) == 0) { reachable = 1; say("mem_shared_window", shared[i]); }
    }
    if (!reachable) say("mem_shared_window", "none");

    say("mem_other_guest", reachable ? "REACHABLE" : "unreachable");
}

/* Mint a report whose report_data[32:64] names the OTHER app. There is no monitor here, so nothing stops
 * this: the point is that the report still carries OUR measurement, and a verifier pins that. */
static void mint_report_naming(const char *other_id_hex, const char *bind_hex) {
    if (mkdir("/sys/kernel/config", 0755) != 0 && errno != EEXIST) { /* configfs may already be mounted */ }
    system("mount -t configfs none /sys/kernel/config 2>/dev/null");
    if (mkdir("/sys/kernel/config/tsm/report/adv", 0755) != 0 && errno != EEXIST) {
        say("report_mint", strerror(errno));
        return;
    }
    unsigned char rd[64] = {0};
    /* the victim's key binding, so the report is well formed and not merely parseable */
    for (int i = 0; i < 32; i++) {
        unsigned v = 0;
        sscanf(bind_hex + 2 * i, "%2x", &v);
        rd[i] = (unsigned char)v;
    }
    /* the other app's id in the app half, byte for byte */
    for (int i = 0; i < 32; i++) {
        unsigned v = 0;
        sscanf(other_id_hex + 2 * i, "%2x", &v);
        rd[32 + i] = (unsigned char)v;
    }
    int fd = open("/sys/kernel/config/tsm/report/adv/inblob", O_WRONLY);
    if (fd < 0) { say("report_mint", strerror(errno)); return; }
    ssize_t w = write(fd, rd, sizeof rd);
    close(fd);
    if (w != (ssize_t)sizeof rd) { say("report_mint", "inblob write failed"); return; }
    fd = open("/sys/kernel/config/tsm/report/adv/outblob", O_RDONLY);
    if (fd < 0) { say("report_mint", strerror(errno)); return; }
    static unsigned char rep[8192];
    ssize_t n = read(fd, rep, sizeof rep);
    close(fd);
    if (n <= 0) { say("report_mint", "outblob read failed"); return; }
    say("report_mint", "GRANTED-naming-the-other-app");
    /* base64, so the harness can judge it with the real verifier */
    static const char *t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    printf("ADV report_b64=");
    for (ssize_t i = 0; i < n; i += 3) {
        unsigned v = rep[i] << 16 | (i + 1 < n ? rep[i + 1] << 8 : 0) | (i + 2 < n ? rep[i + 2] : 0);
        putchar(t[v >> 18 & 63]); putchar(t[v >> 12 & 63]);
        putchar(i + 1 < n ? t[v >> 6 & 63] : '=');
        putchar(i + 2 < n ? t[v & 63] : '=');
    }
    putchar('\n');
    fflush(stdout);
}

int main(void) {
    unsigned cid = 0, port = 0;
    char other[80] = {0}, bind[80] = {0};
    FILE *f = fopen("/adv.target", "r");
    if (!f || fscanf(f, "%u %u %79s %79s", &cid, &port, other, bind) != 4) {
        say("target", "missing /adv.target");
        say("done", "no-target");
        return 0;
    }
    fclose(f);
    printf("ADV target=cid%u:%u other_app=%.16s...\n", cid, port, other);
    fflush(stdout);

    probe_memory();
    try_vsock("vsock_target", cid, port);   /* the other app's serving port */
    try_vsock("vsock_host", 2, 443);        /* the host, CID 2 */
    try_vsock("vsock_target_ctl", cid, 9000);
    mint_report_naming(other, bind);
    say("done", "ok");
    return 0;
}
