/* PID 1 of an M2 app domain (isolation/DESIGN.md section 10): M1's domain, now serving.
 *
 * The domain holds exactly one app and exposes exactly one port. This init:
 *   1. loads the vsock transport (the domain has no NIC: vsock to the host is its only channel) and,
 *      under SEV-SNP, the report interface;
 *   2. brings up loopback and starts /front, which mints the domain's TLS key in guest memory, terminates TLS on
 *      vsock port 443, serves the attestation document binding that key, and proxies everything else to the app;
 *   3. waits for the front's ONE message on the pipe it gave it (fd 3): "N" (no config) or "C" + the app's config.
 *      For a guest that serves a deployment, the front sends it only after the attested release has delivered the
 *      owner's config and secrets and the egress forwarders are up (front/provision.go); an empty pipe means the
 *      front died first, and the domain powers off rather than start an app without the config it should have;
 *   4. starts the app natively under `wasmtime serve` on 127.0.0.1:8080 (the runtime JIT-compiles it inside this
 *      guest, as in M1), with ENCLAVE_CONFIG when there is one. The app's stdin, stdout and stderr are /dev/null:
 *      this process's own are the serial console, a file the HOST reads, so anything the app or its runtime prints
 *      (a request it logs, its config, a panic, a trap) would otherwise reach the host. This tier has no owner-only
 *      log channel, so the app's output is discarded, not kept (Codex, 2026-09-25). Only init's and the front's own
 *      "DOM ..." lines reach the console;
 *   5. if either exits, powers the domain off: a domain that cannot serve should not linger.
 * The host ends a serving domain by stopping its VMM (lease end). */
#define _GNU_SOURCE
#include <cpuid.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("DOM insmod %s: %s\n", p, strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r != 0 && errno != EEXIST) printf("DOM insmod %s failed: %s\n", p, strerror(errno));
    close(fd);
}

/* the kernel gives lo 127.0.0.1/8 itself once it is up */
static void lo_up(void) {
    struct ifreq ifr = {0};
    strcpy(ifr.ifr_name, "lo");
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0 || ioctl(s, SIOCGIFFLAGS, &ifr) < 0) { printf("DOM ERROR lo: %s\n", strerror(errno)); return; }
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) printf("DOM ERROR lo up: %s\n", strerror(errno));
    close(s);
}

/* extra: one more environment entry or NULL; fd3: a descriptor the child gets as fd 3, or -1; quiet: the child's
 * stdin, stdout and stderr are /dev/null (tenant code: nothing it prints reaches the host's serial file). A quiet
 * child keeps a close-on-exec copy of the console only to report its OWN exec failure, and one that cannot open
 * /dev/null exits 126 rather than run with the console. */
static pid_t spawn(char *const argv[], char *extra, int fd3, int quiet) {
    pid_t pid = fork();
    if (pid == 0) {
        if (fd3 == 3) fcntl(3, F_SETFD, 0);                      /* already fd 3: only drop CLOEXEC */
        else if (fd3 >= 0 && dup2(fd3, 3) < 0) _exit(127);       /* dup2 leaves the new fd 3 without CLOEXEC */
        int con = 1;
        if (quiet) {
            con = fcntl(1, F_DUPFD_CLOEXEC, 10);
            int nul = open("/dev/null", O_RDWR);
            if (nul < 0 || dup2(nul, 0) < 0 || dup2(nul, 1) < 0 || dup2(nul, 2) < 0) _exit(126);
            if (nul > 2) close(nul);
        }
        char *envp[] = {"HOME=/tmp", "PATH=/rt", extra, NULL};
        execve(argv[0], argv, envp);
        if (con >= 0) dprintf(con, "DOM ERROR exec %s: %s\n", argv[0], strerror(errno));
        _exit(127);
    }
    return pid;
}

/* The front's one message on the pipe: "N" (no config), or "C" + the app's config, at most the standard runtime's
 * ENCLAVE_CONFIG ceiling (64 KiB), then EOF. On "C" *env is a malloc'd "ENCLAVE_CONFIG=<config>" and *len the config's
 * length; on "N" *env stays NULL. Anything else - an empty pipe (the front died first), one byte over the ceiling, a
 * NUL, another tag - returns why, and the caller does not start the app. The read buffer is wiped either way. */
#define CFG_MAX 65536
static const char *read_front_msg(int fd, char **env, size_t *len) {
    static char msg[1 + CFG_MAX + 1];
    static const char pre[] = "ENCLAVE_CONFIG=";
    size_t n = 0;
    const char *why = NULL;
    for (;;) {
        ssize_t r = read(fd, msg + n, sizeof msg - n);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) break;
        n += (size_t)r;
        if (n == sizeof msg) break;
    }
    *env = NULL;
    *len = 0;
    if (n == 0) why = "ended before it handed over the app's config";
    else if (n == 1 && msg[0] == 'N') why = NULL;
    else if (msg[0] != 'C' || n < 2) why = "sent no valid config message";
    else if (n == sizeof msg) why = "sent a config over the 64 KiB ENCLAVE_CONFIG ceiling";
    else if (memchr(msg + 1, 0, n - 1)) why = "sent a config with a NUL byte";
    else {
        *len = n - 1;
        *env = malloc(sizeof pre + *len);
        if (!*env) why = "sent a config there was no memory for";
        else {
            memcpy(*env, pre, sizeof pre - 1);
            memcpy(*env + sizeof pre - 1, msg + 1, *len);
            (*env)[sizeof pre - 1 + *len] = 0;
        }
    }
    explicit_bzero(msg, n);
    return why;
}

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
    mount("configfs", "/sys/kernel/config", "configfs", 0, 0);
    double boot_ms = now_ms();   /* monotonic since guest boot: how long the kernel took to reach us */

    unsigned a, b, c, d;
    __cpuid(0x8000001f, a, b, c, d);
    int snp = (a >> 4) & 1;      /* SNP active for THIS guest (the CPUID table under SNP is the PSP's) */
    struct sysinfo si;
    sysinfo(&si);
    printf("\nDOM snp=%d vcpus=%ld memMiB=%lu boot_ms=%.0f\n", snp, sysconf(_SC_NPROCESSORS_ONLN),
           (unsigned long)(si.totalram * si.mem_unit >> 20), boot_ms);

    insmod("/vsock.ko.zst");
    insmod("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod("/vmw_vsock_virtio_transport.ko.zst");
    if (snp) {
        insmod("/tsm_report.ko.zst");
        insmod("/sev-guest.ko.zst");
    }
    lo_up();

    /* -C cache=n: the runtime compiles the verified component INSIDE this domain every time, and keeps no
     * compiled artifact anywhere. wasmtime's module cache is ON by default (it writes under
     * $HOME/.cache/wasmtime), and a compiled cache is only admissible under the portable-runtime contract
     * if it is keyed by bundle hash + runtime identity AND authenticated (isolation/contract/RUNTIME.md
     * rule 5, contract.CacheKey). We hold no such cache, so the domain states cache: "none" in its runtime
     * identity - and this flag is what makes that statement true by construction rather than by the
     * accident of HOME being unset in the guest. */
    char *serve[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "serve", "-S", "cli",
                     "-C", "cache=n", "--addr", "127.0.0.1:8080", "/app.wasm", NULL};
    /* HOW the app runs is the bundle's own word, not the host's: /app.run exists only when the bundle's measured
     * manifest states world wasi:cli, and holds the port it serves HTTP on (assemble-app-image.sh writes it from
     * the bundle, so it is inside the launch measurement). Such an app is a command that binds that port itself
     * through wasi:sockets, as the platform's run mode does (wasm/wasm_manager.py): -S tcp/udp/inherit-network,
     * ENCLAVE_PORTS=http:N=N (logical = actual here: this domain holds one app), and a private scratch /data.
     * inherit-network reaches nothing but this domain's own loopback: the domain has no NIC, and its only channel,
     * vsock, is not an IP socket. Its config arrives as ENCLAVE_CONFIG like a served app's; its egress is the same
     * as a served app's, the front's per-origin forwarders on loopback (front/provision.go). No other ports. */
    int port = 0;
    FILE *rf = fopen("/app.run", "r");
    if (rf) {
        if (fscanf(rf, "%d", &port) != 1 || port < 1 || port > 49999) port = -1;
        fclose(rf);
    }
    if (port < 0) {
        printf("DOM ERROR /app.run does not name a port in 1-49999\n");
        fflush(stdout);
        reboot(RB_POWER_OFF);
    }
    char upstream[32], ports_env[64];
    snprintf(upstream, sizeof upstream, "127.0.0.1:%d", port ? port : 8080);
    snprintf(ports_env, sizeof ports_env, "ENCLAVE_PORTS=http:%d=%d", port, port);
    char *run[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "run", "-S", "cli",
                   "-S", "tcp", "-S", "udp", "-S", "inherit-network", "-S", "allow-ip-name-lookup",
                   "-C", "cache=n", "--dir", "/data::/data", "--env", ports_env, "/app.wasm", NULL};
    if (port) {
        mkdir("/data", 0700);
        mount("tmpfs", "/data", "tmpfs", 0, "size=64m,mode=0700");
        printf("DOM app mode run: a wasi:cli command serving HTTP on %d (ENCLAVE_PORTS http:%d=%d, /data 64 MiB scratch)\n",
               port, port, port);
    }
    /* The front first. It hands this process the app's config (or "none") on a pipe, and the app starts only then:
     * the release, the allowlist and the forwarders all happen before any tenant code runs. */
    int pfd[2];
    if (pipe2(pfd, O_CLOEXEC) < 0) {
        printf("DOM ERROR pipe: %s\n", strerror(errno));
        fflush(stdout);
        reboot(RB_POWER_OFF);
    }
    char *front[] = {"/front", "-port", "443", "-upstream", upstream, snp ? "-snp=true" : "-snp=false",
                     "-init-fd", "3", NULL};
    pid_t front_pid = spawn(front, NULL, pfd[1], 0);
    close(pfd[1]);
    char *cfg_env = NULL;
    size_t cfg_len = 0;
    const char *why = read_front_msg(pfd[0], &cfg_env, &cfg_len);
    close(pfd[0]);
    if (why) {
        printf("DOM ERROR the front %s: the app is not started\n", why);
        fflush(stdout);
        sync();
        reboot(RB_POWER_OFF);
    }
    if (cfg_env) printf("DOM app config: %zu bytes (ENCLAVE_CONFIG)\n", cfg_len);   /* its length, never its content */
    else printf("DOM app config: none\n");

    /* the runtime passes ENCLAVE_CONFIG to the guest program from its own environment (--env NAME, no value), so the
     * value is never an argument */
    char **base = port ? run : serve, *app[48];
    int k = 0;
    for (int i = 0; base[i]; i++) {
        if (cfg_env && strcmp(base[i], "/app.wasm") == 0) {
            app[k++] = "--env";
            app[k++] = "ENCLAVE_CONFIG";
        }
        app[k++] = base[i];
    }
    app[k] = NULL;
    pid_t app_pid = spawn(app, cfg_env, -1, 1);
    if (cfg_env) {
        explicit_bzero(cfg_env, sizeof "ENCLAVE_CONFIG=" + cfg_len);
        free(cfg_env);
    }
    printf("DOM started app=%d front=%d at_ms=%.0f\n", app_pid, front_pid, now_ms());

    for (;;) {                   /* PID 1 reaps everything; either server ending ends the domain */
        int st = 0;
        pid_t w = wait(&st);
        if (w < 0 && errno == ECHILD) break;
        if (w == app_pid || w == front_pid) {
            printf("DOM ERROR %s exited status=%d\n", w == app_pid ? "app" : "front",
                   WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
            break;
        }
    }
    printf("DOM end\n");
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    return 0;
}
