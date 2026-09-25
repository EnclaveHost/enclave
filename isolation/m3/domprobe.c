/* domprobe: the adversary, from inside a domain (isolation/m3/PLAN.md section 7).
 *
 * The monitor can start this as a domain's workload instead of the runtime and the front. It stands in
 * for the case the whole project exists to survive: a tenant whose RUNTIME HAS BEEN COMPROMISED, so
 * native code is running with that domain's uid, in that domain's namespaces, with whatever the domain
 * can reach. It is not a tenant's code — the host chooses only BETWEEN measured binaries in a measured
 * image, it cannot supply one — and it does nothing but try things and print what happened.
 *
 * What it must NOT be able to do, and each line is evidence for one check:
 *   - read another domain's app, or anything of another domain's
 *   - see or signal another domain's processes
 *   - reach the report interface directly (no /sys), or make the monitor name another domain's app
 *   - reach another domain's port over vsock, going around the monitor's relay
 *   - reach the host, or another domain's service, over the network
 * It SHOULD be able to get a report for ITS OWN domain: that is the domain's own evidence, and the app
 * hash in it comes from the monitor, so a compromised domain can only ever name itself.
 *
 * Every line is printed as `PROBE<id> <what>=<result>` for the harness. This binary never exits on its
 * own: a domain that ended immediately would be reclaimed before the harness could read anything, so it
 * sleeps once its report is printed, and the harness ends it with stop or destroy.
 *
 * usage: domprobe <id> (started by domexec inside the domain)
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define AF_VSOCK_ 40
struct sockaddr_vm_ {
    unsigned short svm_family;
    unsigned short svm_reserved1;
    unsigned int svm_port;
    unsigned int svm_cid;
    unsigned char svm_flags;
    unsigned char svm_zero[3];
};

static const char *id = "?";
static void say(const char *what, const char *result) { printf("PROBE%s %s=%s\n", id, what, result); }

/* can this domain open a path that is not its own? */
static void try_read(const char *what, const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        say(what, strerror(errno));
        return;
    }
    char buf[16];
    ssize_t n = read(fd, buf, sizeof buf);
    close(fd);
    printf("PROBE%s %s=READABLE (%zd bytes)\n", id, what, n);
}

/* can this domain OPEN a device node? OPEN ONLY, closed at once: nothing is read, written, ioctl'd or sent. For a TPM
 * this is a negative control that the domain cannot reach the device at all (enclave-d1's request); it must never
 * become a command, an NV read or a capture in any other form. The expected answer is ENOENT: the domain is chrooted
 * with no /dev (main.go, domexec.c), which is the SOURCE claim this measures. */
static void try_open(const char *what, const char *path) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY);
    if (fd < 0) { say(what, strerror(errno)); return; }
    close(fd);
    say(what, "OPENED");
}

/* ask the monitor for a report and print the app hash it came back with: a compromised domain must only
 * ever be able to name ITSELF */
static void try_report(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { say("report", "no socket"); return; }
    struct sockaddr_un sa = {0};
    sa.sun_family = AF_UNIX;
    strncpy(sa.sun_path, "/run/monitor.sock", sizeof sa.sun_path - 1);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) { say("report", strerror(errno)); close(fd); return; }
    /* a request that also TRIES to name another app, to show the monitor ignores it */
    static const char req[] = "{\"bind\":\"2222222222222222222222222222222222222222222222222222222222222222\","
                              "\"app\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\","
                              "\"appSha256\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"id\":1}\n";
    struct timeval tv = {10, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    static char buf[65536];
    ssize_t n = write(fd, req, sizeof req - 1) > 0 ? read(fd, buf, sizeof buf - 1) : -1;
    close(fd);
    if (n <= 0) { say("report", "no-answer"); return; }
    buf[n] = 0;
    say("report", strstr(buf, "\"report\"") ? "granted-for-this-domain" : "refused");
    /* the harness decodes the report itself; print it so it can check whose app is named */
    char *p = strstr(buf, "\"report\":\"");
    if (p) {
        p += 10;
        char *e = strchr(p, '"');
        if (e) { *e = 0; printf("PROBE%s report_b64=%s\n", id, p); }
    }
}

/* A connect that actually respects a deadline. SO_SNDTIMEO does NOT bound a blocking connect(), so a
 * refused vsock port left this probe sitting in the kernel for minutes and every later probe went
 * unreported — which reads as a missing result, and a missing result must never be mistaken for a pass. */
static void timed_connect(const char *what, struct sockaddr *sa, socklen_t len, int family, int ms) {
    int fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) { say(what, strerror(errno)); return; }
    if (connect(fd, sa, len) == 0) { say(what, "CONNECTED"); close(fd); return; }
    if (errno != EINPROGRESS) { say(what, strerror(errno)); close(fd); return; }
    struct pollfd pfd = {.fd = fd, .events = POLLOUT};
    int rc = poll(&pfd, 1, ms);
    if (rc == 0) { say(what, "timed out (no answer)"); close(fd); return; }
    if (rc < 0) { say(what, strerror(errno)); close(fd); return; }
    int err = 0;
    socklen_t elen = sizeof err;
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen);
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

static void try_tcp(const char *what, const char *ip, int port) {
    struct sockaddr_in sa = {0};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    sa.sin_addr.s_addr = inet_addr(ip);
    timed_connect(what, (struct sockaddr *)&sa, sizeof sa, AF_INET, 2000);
}

/* Can a compromised domain exhaust the guest's memory, or does its own cgroup contain it? Allocate and
 * TOUCH memory in 1 MiB steps well past the domain's cap. Containment means this process is killed, so
 * the last line printed is how far it got. An IDLE domain never reaches its cap, which is why this has to
 * be deliberate rather than inferred from a small limit. */
static void try_eat_memory(int cap_mib) {
    int target = cap_mib > 0 ? cap_mib * 4 : 1024;
    printf("PROBE%s eating memory: cap %d MiB, will try %d MiB\n", id, cap_mib, target);
    fflush(stdout);
    for (int i = 1; i <= target; i++) {
        char *p = malloc(1 << 20);
        if (!p) { printf("PROBE%s memory_refused_at=%d MiB\n", id, i); fflush(stdout); return; }
        memset(p, (char)i, 1 << 20);
        if (i % 16 == 0) { printf("PROBE%s memory_touched=%d MiB\n", id, i); fflush(stdout); }
    }
    printf("PROBE%s memory_UNCONTAINED=%d MiB touched without being stopped\n", id, target);
    fflush(stdout);
}

int main(int argc, char **argv) {
    if (argc > 1) id = argv[1];
    printf("PROBE%s uid=%d euid=%d\n", id, getuid(), geteuid());

    /* 1. another domain's files, by every route a chroot might leak */
    try_read("other_app_absolute", "/domains/1/app.wasm");
    try_read("other_app_relative", "../1/app.wasm");
    try_read("other_app_escape", "/../../../domains/1/app.wasm");
    try_read("other_front_socket", "/domains/1/run/front.sock");
    try_read("own_app", "/app.wasm");

    /* 2. the report interface, directly */
    try_read("configfs_tsm", "/sys/kernel/config/tsm/report");
    try_read("sysfs", "/sys/class");
    int fd = open("/sys/kernel/config/tsm/report/probe", O_WRONLY | O_CREAT, 0644);
    say("create_tsm_entry", fd < 0 ? strerror(errno) : "CREATED");
    if (fd >= 0) close(fd);
    /* the VBS/vTPM side of the report interface: the TPM character devices, open only (see try_open) */
    try_open("dev_tpm0", "/dev/tpm0");
    try_open("dev_tpmrm0", "/dev/tpmrm0");

    /* 3. other processes */
    int visible = 0;
    DIR *d = opendir("/proc");
    if (d) {
        struct dirent *e;
        while ((e = readdir(d))) if (e->d_name[0] >= '1' && e->d_name[0] <= '9') visible++;
        closedir(d);
    }
    char n[32];
    snprintf(n, sizeof n, "%d", visible);
    say("visible_pids", n);
    int reached = 0;
    for (int pid = 2; pid < 400; pid++) if (kill(pid, 0) == 0) reached++;
    snprintf(n, sizeof n, "%d", reached);
    say("signalable_pids", n);   /* its own few, never the monitor's or another domain's */

    /* 4. its own report, which it is entitled to, and whose app half is the monitor's to write. FIRST,
     *    because it is the security-critical one and must not be lost behind a slow network probe. */
    try_report();

    /* 5. another domain's port, and the host, over vsock: the monitor relays the host to a domain, and
     *    nothing inside the guest should be able to take that path itself */
    try_vsock("vsock_local_domain1", 1, 40001);
    try_vsock("vsock_local_domain2", 1, 40002);
    try_vsock("vsock_own_control", 1, 9000);
    try_vsock("vsock_host_control", 2, 9000);

    /* 6. the network: its own loopback is all it has */
    try_tcp("own_loopback_8080", "127.0.0.1", 8080);
    try_tcp("host_gateway", "10.0.2.2", 80);

    printf("PROBE%s done\n", id);
    fflush(stdout);

    /* 7. LAST, because being contained ends this domain: try to exhaust memory past its own share */
    if (argc > 2) try_eat_memory(atoi(argv[2]));
    for (;;) pause();   /* if it survived, the harness ends the domain with stop or destroy */
}
