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

/* can this domain reach a vsock port directly, going around the monitor's relay? */
static void try_vsock(const char *what, unsigned cid, unsigned port) {
    int fd = socket(AF_VSOCK_, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { say(what, strerror(errno)); return; }
    struct sockaddr_vm_ sa = {0};
    sa.svm_family = AF_VSOCK_;
    sa.svm_cid = cid;
    sa.svm_port = port;
    struct timeval tv = {5, 0};
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    int rc = connect(fd, (struct sockaddr *)&sa, sizeof sa);
    say(what, rc == 0 ? "CONNECTED" : strerror(errno));
    close(fd);
}

static void try_tcp(const char *what, const char *ip, int port) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { say(what, strerror(errno)); return; }
    struct sockaddr_in sa = {0};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    sa.sin_addr.s_addr = inet_addr(ip);
    struct timeval tv = {3, 0};
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    int rc = connect(fd, (struct sockaddr *)&sa, sizeof sa);
    say(what, rc == 0 ? "CONNECTED" : strerror(errno));
    close(fd);
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

    /* 4. another domain's port, and the host, over vsock: the monitor relays the host to a domain, and
     *    nothing inside the guest should be able to take that path itself */
    try_vsock("vsock_local_domain1", 1, 40001);
    try_vsock("vsock_local_domain2", 1, 40002);
    try_vsock("vsock_own_control", 1, 9000);
    try_vsock("vsock_host_control", 2, 9000);

    /* 5. the network: its own loopback is all it has */
    try_tcp("own_loopback_8080", "127.0.0.1", 8080);
    try_tcp("host_gateway", "10.0.2.2", 80);

    /* 6. its own report, which it is entitled to, and whose app half is the monitor's to write */
    try_report();

    printf("PROBE%s done\n", id);
    fflush(stdout);
    for (;;) pause();   /* the harness ends this domain with stop or destroy */
}
