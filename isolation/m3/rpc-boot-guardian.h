/* RPC-only namespace PID1 supervisor. This is part of the measured dominit,
 * not a host-controlled executable or runtime-selected watchdog. The production
 * caller uses origin0 (kernel boot); the host retains its independent earlier
 * preparation deadline. Serving transfer requires a private one-shot commit. */
#ifndef ENCLAVE_RPC_BOOT_GUARDIAN_H
#define ENCLAVE_RPC_BOOT_GUARDIAN_H
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>
#include "rpc-serving-guard.h"

#define RPC_GUARD_WINDOW_NS UINT64_C(900000000000)
#define RPC_GUARD_AS_BYTES (UINT64_C(32) << 20)

/* No filesystem sync, console write, user callback or child wait can prevent
 * this independent process from requesting poweroff. Failure is NOT settlement:
 * an independently enforced host cutoff is still required for kernel stalls. */
static _Noreturn void rpc_guard_poweroff(void) {
    reboot(RB_POWER_OFF);
    _exit(125);
}
static int rpc_guard_now(uint64_t *now) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0 ||
        (uint64_t)t.tv_sec > (uint64_t)INT64_MAX / UINT64_C(1000000000) ||
        t.tv_nsec < 0 || t.tv_nsec >= 1000000000) return -1;
    *now = (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
    return 0;
}
static int rpc_guard_cap(int resource, rlim_t maximum) {
    struct rlimit r;
    if (getrlimit(resource, &r)) return -1;
    if (r.rlim_cur > maximum) r.rlim_cur = maximum;
    if (r.rlim_max > maximum) r.rlim_max = maximum;
    return setrlimit(resource, &r);
}

/* Return only in the gated worker. The original PID1 never performs preparation,
 * loads credentials, invokes tools, mounts storage, or execs the Go monitor.
 * It owns the absolute kernel timer and exact child pidfd until shutdown. */
static int rpc_guard_enter(uint64_t origin, int *serving_fd) {
    uint64_t now, deadline;
    if (!serving_fd || getpid() != 1 || getuid() != 0 || geteuid() != 0 ||
        origin > (uint64_t)INT64_MAX - RPC_GUARD_WINDOW_NS ||
        rpc_guard_now(&now) || now < origin || now >= origin + RPC_GUARD_WINDOW_NS)
        return -1;
    deadline = origin + RPC_GUARD_WINDOW_NS;
    int timer = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
    if (timer < 0) return -1;
    struct itimerspec set = {.it_value = {(time_t)(deadline / UINT64_C(1000000000)), (long)(deadline % UINT64_C(1000000000))}}, got;
    if (timerfd_settime(timer, TFD_TIMER_ABSTIME, &set, NULL) || timerfd_gettime(timer, &got) ||
        got.it_interval.tv_sec || got.it_interval.tv_nsec || (!got.it_value.tv_sec && !got.it_value.tv_nsec)) {
        close(timer); return -1;
    }
    int gate[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, gate)) { close(timer); return -1; }
    pid_t pid = fork();
    if (pid < 0) { close(gate[0]); close(gate[1]); close(timer); return -1; }
    if (pid == 0) {
        close(gate[0]); close(timer);
        /* Install kernel parent-loss behavior before acknowledging readiness.
         * Namespace PID1 death also kills the complete namespace, including
         * descendants that later change parent/death-signal behavior. */
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != 1 ||
            send(gate[1], "R", 1, MSG_DONTWAIT | MSG_NOSIGNAL) != 1) _exit(126);
        char release[2];
        ssize_t n;
        do { n = recv(gate[1], release, sizeof release, 0); } while (n < 0 && errno == EINTR);
        if (n != 1 || release[0] != 'G' || getppid() != 1 || rpc_guard_now(&now) || now >= deadline) _exit(126);
        *serving_fd = gate[1]; /* CLOEXEC until exact monitor handoff */
        return 0;
    }
    close(gate[1]);
    int child = (int)syscall(SYS_pidfd_open, pid, 0);
    /* These caps apply only to the supervisor; the worker keeps its original
     * inherited limits and later measured per-role cgroups. Initial allocations
     * precede this cap and must still be included in host admission. */
    if (child < 0 || rpc_guard_cap(RLIMIT_AS, RPC_GUARD_AS_BYTES) ||
        rpc_guard_cap(RLIMIT_CORE, 0)) rpc_guard_poweroff();
    int released = 0;
    struct rpc_serving_guard state = {.origin=origin,.original_deadline=deadline,.until=deadline};
    for (;;) {
        struct pollfd p[3] = {{timer, POLLIN, 0}, {child, POLLIN, 0}, {gate[0], POLLIN, 0}};
        if (rpc_guard_now(&now) || now >= state.until) rpc_guard_poweroff();
        int n = poll(p, 3, -1);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 || p[0].revents || p[1].revents) rpc_guard_poweroff();
        if (!released && p[2].revents) {
            char ready[2];
            if (p[2].revents != POLLIN || recv(gate[0], ready, sizeof ready, MSG_DONTWAIT) != 1 || ready[0] != 'R') rpc_guard_poweroff();
            struct pollfd live[2] = {{timer, POLLIN, 0}, {child, POLLIN, 0}};
            if (poll(live, 2, 0) != 0 || rpc_guard_now(&now) || now >= deadline ||
                send(gate[0], "G", 1, MSG_DONTWAIT | MSG_NOSIGNAL) != 1) rpc_guard_poweroff();
            released = 1;
        } else if (released && p[2].revents) {
            uint64_t prior=state.until;
            unsigned char frame[RPC_SERVING_FRAME];
            struct iovec iov={frame,sizeof frame};
            struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1};
            if (p[2].revents != POLLIN || recvmsg(gate[0], &msg, MSG_DONTWAIT|MSG_TRUNC|MSG_CMSG_CLOEXEC) != sizeof frame ||
                (msg.msg_flags & (MSG_TRUNC|MSG_CTRUNC)) || rpc_guard_now(&now) || rpc_serving_accept(&state,frame,now)) rpc_guard_poweroff();
            /* Rearm the same absolute timer; an expired permit is never revived.
             * PREPARE leaves state.until exactly equal to originalD. */
            set.it_value.tv_sec=(time_t)(state.until/UINT64_C(1000000000));
            set.it_value.tv_nsec=(long)(state.until%UINT64_C(1000000000));
            if(rpc_guard_now(&now) || now>=prior || now>=state.until)rpc_guard_poweroff();
            if(timerfd_settime(timer,TFD_TIMER_ABSTIME,&set,NULL))rpc_guard_poweroff();
            struct pollfd live[2]={{timer,POLLIN,0},{child,POLLIN,0}};
            if(poll(live,2,0)!=0 || rpc_guard_now(&now) || now>=prior || now>=state.until)rpc_guard_poweroff();
            frame[8]|=0x80;
            if(send(gate[0],frame,sizeof frame,MSG_DONTWAIT|MSG_NOSIGNAL)!=sizeof frame)rpc_guard_poweroff();
        }
    }
}
#endif
