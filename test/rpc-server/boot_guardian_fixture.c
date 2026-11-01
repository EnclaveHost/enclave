/* Test-only private PID namespace fixture; never embedded in platform media.
 * Calls the actual supervisor; reboot is NOT mocked and must stay in this PID
 * namespace. External controller preholds exact pidfds for every test actor. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "rpc-boot-guardian.h"

static int announce(char role) {
    int fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (fd < 0) return -1;
    union { struct cmsghdr align; char b[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct iovec iov = {&role, 1};
    struct msghdr msg = {.msg_iov=&iov,.msg_iovlen=1,.msg_control=control.b,.msg_controllen=sizeof control.b};
    struct cmsghdr *c=CMSG_FIRSTHDR(&msg);
    c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof fd);
    int result=sendmsg(0,&msg,MSG_DONTWAIT|MSG_NOSIGNAL)==1 ? 0:-1;
    close(fd);return result;
}
int main(int argc,char **argv) {
    if (argc!=3) return 64;
    /* Prove a new user namespace: initial user namespace is explicitly refused
     * even if someone invokes this fixture as real root. */
    FILE *f=fopen("/proc/self/uid_map","r"); unsigned long in,out,count;
    if (!f || fscanf(f,"%lu %lu %lu",&in,&out,&count)!=3 || count!=1 || in!=0 || out==0) return 65;
    fclose(f);
    if (!strcmp(argv[1],"worker")) {
        if (getpid()==1 || announce('E')) return 66;
        pid_t p=fork();if(p<0)return 67;
        if(p==0){if(announce('D'))return 68;for(;;)pause();}
        for(;;)pause();
    }
    if (getpid()!=1 || announce('G')) return 69;
    uint64_t now;if(rpc_guard_now(&now))return 70;
    unsigned long left=strtoul(argv[2],NULL,10);
    if (left<100 || left>5000 || now<RPC_GUARD_WINDOW_NS) return 71;
    uint64_t origin=now-RPC_GUARD_WINDOW_NS+(uint64_t)left*1000000;
    if (!strcmp(argv[1],"future"))origin=now+1000000000;
    if (!strcmp(argv[1],"overflow"))origin=UINT64_MAX;
    if (!strcmp(argv[1],"expired"))origin=now-RPC_GUARD_WINDOW_NS-1;
    uint64_t timing[2]={origin,origin<=INT64_MAX-RPC_GUARD_WINDOW_NS ? origin+RPC_GUARD_WINDOW_NS:0};
    if(send(0,timing,sizeof timing,MSG_DONTWAIT|MSG_NOSIGNAL)!=sizeof timing)return 75;
    if (rpc_guard_enter(origin)) return 72;
    if (announce('W')) return 73;
    if (!strcmp(argv[1],"early-exit")) {usleep(150000);return 7;}
    if (!strcmp(argv[1],"blocked-preparation")) {raise(SIGSTOP);for(;;)pause();}
    char *args[]={argv[0],"worker",argv[2],NULL};
    execv(argv[0],args);return 74;
}
