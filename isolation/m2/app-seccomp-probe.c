/* app-seccomp-probe.c - TEST ONLY (never in an image): stands in for the app runtime (or, as `front`, for the front) and
 * checks from INSIDE the process what app-seccomp.h allows and refuses. Used by m2/test-dominit-hardening.sh and
 * m3/test-domexec-seccomp.sh. Its role is its argv[0]: a name containing "front" is the front (it must be UNFILTERED:
 * Seccomp 0); anything else is the runtime (filtered: Seccomp 2, every refusal as specified, every allowance working).
 * Writes "ok ..." / "BAD ..." lines and a final "done ok=N bad=M" to $PROBE_OUT/<role>.seccomp (its stdout may be the
 * null device). Built with glibc -static -pthread.
 *
 * Each refusal is told apart from the kernel's own answer where the kernel would answer differently without the filter
 * (process_vm_readv on ITSELF succeeds; ptrace PEEKDATA on an untraced parent gives ESRCH; keyctl on its session
 * keyring succeeds; userfaultfd in user mode succeeds; bpf with an invalid command gives EINVAL): run unfiltered, 28
 * of the runtime's checks fail. The KILL rules run in forked children, which must die by SIGSYS. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/keyctl.h>
#include <linux/perf_event.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

static FILE *out;
static int n_ok, n_bad;
static void say(int good, const char *name, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void say(int good, const char *name, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(out, "%s %s: ", good ? "ok " : "BAD", name);
    vfprintf(out, fmt, ap);
    fputc('\n', out);
    va_end(ap);
    if (good) n_ok++; else n_bad++;
}
/* a raw syscall's result against the errno the filter should give */
static void refused(const char *name, long r, int want) {
    int e = errno;
    say(r == -1 && e == want, name, "r=%ld errno=%s (want %s)", r, r == -1 ? strerrorname_np(e) : "-", strerrorname_np(want));
}
/* a raw clone-like call that must be refused; if it is NOT, the child it made leaves at once */
static void refused_clone(const char *name, long r, int want) {
    int e = errno;
    if (r == 0) _exit(0);
    if (r > 0) waitpid((pid_t)r, NULL, 0);
    errno = e;
    refused(name, r, want);
}
/* run fn in a forked child: it must die by SIGSYS (the filter's KILL) */
static void killed(const char *name, void (*fn)(void)) {
    pid_t p = fork();
    if (p == 0) { fn(); _exit(0); }
    int st = 0;
    waitpid(p, &st, 0);
    say(WIFSIGNALED(st) && WTERMSIG(st) == SIGSYS, name, "%s %d",
        WIFSIGNALED(st) ? "signal" : "exit", WIFSIGNALED(st) ? WTERMSIG(st) : WEXITSTATUS(st));
}
static void k_kexec_load(void) { syscall(SYS_kexec_load, 0, 0, NULL, 0); }
static void k_kexec_file_load(void) { syscall(SYS_kexec_file_load, -1, -1, 0, "", 0); }
static void k_init_module(void) { syscall(SYS_init_module, NULL, 0, ""); }
static void k_finit_module(void) { syscall(SYS_finit_module, -1, "", 0); }
static void k_delete_module(void) { syscall(SYS_delete_module, "enclave-none", 0); }
static void k_i386(void) { long r; __asm__ volatile("int $0x80" : "=a"(r) : "a"(20) : "memory"); (void)r; }   /* i386 getpid */
static void k_x32(void) { syscall(39 | 0x40000000); }                                                          /* x32 getpid */

static void *thread_fn(void *a) { return a; }
static int status_field(const char *field) {
    FILE *s = fopen("/proc/self/status", "r");
    char line[256];
    int v = -1;
    size_t n = strlen(field);
    while (s && fgets(line, sizeof line, s)) if (!strncmp(line, field, n) && line[n] == ':') v = atoi(line + n + 1);
    if (s) fclose(s);
    return v;
}

int main(int argc, char **argv) {
    (void)argc;
    const int front = strstr(argv[0], "front") != NULL;
    const char *dir = getenv("PROBE_OUT");
    char path[600];
    snprintf(path, sizeof path, "%s/%s.seccomp", dir ? dir : "/run", front ? "front" : "runtime");   /* domexec passes no environment: /run */
    out = fopen(path, "w");
    if (!out) return 3;
    int mode = status_field("Seccomp");
    if (front) {
        say(mode == 0, "the front is NOT filtered", "Seccomp %d", mode);
        fprintf(out, "done ok=%d bad=%d\n", n_ok, n_bad);
        fclose(out);
        sleep(1);
        return 0;
    }
    say(mode == 2, "the runtime is filtered", "Seccomp %d", mode);
    say(prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1, "no_new_privs", "set");

    /* REFUSED with EPERM */
    refused("socket(AF_VSOCK)", syscall(SYS_socket, AF_VSOCK, SOCK_STREAM, 0), EPERM);
    int sv[2];
    refused("socketpair(AF_VSOCK)", syscall(SYS_socketpair, AF_VSOCK, SOCK_STREAM, 0, sv), EPERM);
    char params[120] = {0};
    refused("io_uring_setup", syscall(SYS_io_uring_setup, 1, params), EPERM);
    refused("io_uring_enter", syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0), EPERM);
    refused("io_uring_register", syscall(SYS_io_uring_register, -1, 0, NULL, 0), EPERM);
    refused("setns", syscall(SYS_setns, -1, 0), EPERM);
    refused_clone("clone(CLONE_NEWUSER)", syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0), EPERM);   /* before unshare: independent of it */
    refused("unshare(CLONE_NEWUSER)", syscall(SYS_unshare, CLONE_NEWUSER), EPERM);
    refused("unshare(CLONE_NEWNET)", syscall(SYS_unshare, CLONE_NEWNET), EPERM);
    refused("unshare(CLONE_NEWTIME)", syscall(SYS_unshare, 0x80), EPERM);
    struct { uint64_t flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls; } c3 = {0};
    c3.exit_signal = SIGCHLD;
    refused_clone("clone3 (any flags)", syscall(SYS_clone3, &c3, sizeof c3), ENOSYS);
    refused("ptrace(PEEKDATA, parent)", syscall(SYS_ptrace, PTRACE_PEEKDATA, getppid(), 0, 0), EPERM);
    char src[8] = "abcdefg", dst[8];
    struct iovec l = {dst, sizeof dst}, r = {src, sizeof src};
    refused("process_vm_readv (itself)", syscall(SYS_process_vm_readv, getpid(), &l, 1, &r, 1, 0), EPERM);
    refused("process_vm_writev (itself)", syscall(SYS_process_vm_writev, getpid(), &r, 1, &l, 1, 0), EPERM);
    refused("bpf", syscall(SYS_bpf, -1, NULL, 0), EPERM);
    struct perf_event_attr pa;
    memset(&pa, 0, sizeof pa);
    pa.type = PERF_TYPE_SOFTWARE; pa.size = sizeof pa; pa.config = PERF_COUNT_SW_TASK_CLOCK;
    pa.disabled = 1; pa.exclude_kernel = 1; pa.exclude_hv = 1;
    refused("perf_event_open (itself)", syscall(SYS_perf_event_open, &pa, 0, -1, -1, 0), EPERM);
    refused("keyctl(GET_KEYRING_ID)", syscall(SYS_keyctl, KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 0), EPERM);
    refused("add_key", syscall(SYS_add_key, "user", "enclave-probe", "x", 1, KEY_SPEC_PROCESS_KEYRING), EPERM);
    refused("request_key", syscall(SYS_request_key, "user", "enclave-probe-none", NULL, 0), EPERM);
    refused("userfaultfd (user mode)", syscall(SYS_userfaultfd, O_CLOEXEC | 1 /* UFFD_USER_MODE_ONLY */), EPERM);

    /* KILLED */
    killed("kexec_load kills", k_kexec_load);
    killed("kexec_file_load kills", k_kexec_file_load);
    killed("init_module kills", k_init_module);
    killed("finit_module kills", k_finit_module);
    killed("delete_module kills", k_delete_module);
    killed("an i386 syscall (int 0x80) kills", k_i386);
    killed("an x32 syscall kills", k_x32);

    /* ALLOWED: what wasmtime and a run-mode app need */
    int s4 = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    say(s4 >= 0 && bind(s4, (struct sockaddr *)&a, sizeof a) == 0 && listen(s4, 1) == 0, "socket(AF_INET) + bind + listen on loopback", "fd %d", s4);
    int su = socket(AF_UNIX, SOCK_STREAM, 0);
    say(su >= 0, "socket(AF_UNIX)", "fd %d", su);
    say(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0, "socketpair(AF_UNIX)", "ok");
    pthread_t t;
    int pr = pthread_create(&t, NULL, thread_fn, NULL);
    say(pr == 0 && pthread_join(t, NULL) == 0, "a thread (glibc: clone3 ENOSYS, then clone)", "pthread_create %d", pr);
    pid_t f = fork();
    if (f == 0) _exit(7);
    int fst = 0;
    waitpid(f, &fst, 0);
    say(f > 0 && WIFEXITED(fst) && WEXITSTATUS(fst) == 7, "fork (clone, no CLONE_NEW*)", "child exit %d", WIFEXITED(fst) ? WEXITSTATUS(fst) : -1);
    say(syscall(SYS_unshare, CLONE_FILES) == 0, "unshare(CLONE_FILES) (no CLONE_NEW*)", "ok");
    int mfd = memfd_create("jit", MFD_CLOEXEC);
    say(mfd >= 0 && ftruncate(mfd, 4096) == 0, "memfd_create", "fd %d", mfd);
    void *m = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    say(m != MAP_FAILED && mprotect(m, 4096, PROT_READ | PROT_EXEC) == 0, "mmap RW then mprotect RX (a JIT)", "ok");
    int ep = epoll_create1(EPOLL_CLOEXEC);
    say(ep >= 0, "epoll_create1", "fd %d", ep);

    fprintf(out, "done ok=%d bad=%d\n", n_ok, n_bad);
    fclose(out);
    return 0;
}
