/* Actual wire setter with explicit VSOCK metadata/option fault injection.
 * This validates admission and restoration, not the Android credit transport. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>
static int target, fake_vsock, sets, gets, fail_set, fail_get, short_get, mismatch_get;
static unsigned long long size_value, max_value;
static int order[8];
static int wrap_set(int fd,int level,int opt,const void *v,socklen_t n) {
    if(fd==target && level==AF_VSOCK) {
        assert(n==8 && sets<8);order[sets++]=opt;
        unsigned long long x;memcpy(&x,v,8);
        if(opt==SO_VM_SOCKETS_BUFFER_MAX_SIZE) {max_value=x;if(size_value>x)size_value=x;}
        else {assert(opt==SO_VM_SOCKETS_BUFFER_SIZE);size_value=x>max_value?max_value:x;}
        if(sets==fail_set) {errno=EIO;return -1;} /* mutation before failure */
        return 0;
    }
    return setsockopt(fd,level,opt,v,n);
}
static int wrap_get(int fd,int level,int opt,void *v,socklen_t *n) {
    if(fd==target && fake_vsock && level==AF_VSOCK) {
        ++gets;assert(*n==8);
        if(gets==fail_get) {errno=EIO;return -1;}
        unsigned long long x=opt==SO_VM_SOCKETS_BUFFER_SIZE?size_value:max_value;
        assert(opt==SO_VM_SOCKETS_BUFFER_SIZE || opt==SO_VM_SOCKETS_BUFFER_MAX_SIZE);
        if(gets==mismatch_get)++x;
        memcpy(v,&x,8);if(gets==short_get)*n=4;return 0;
    }
    return getsockopt(fd,level,opt,v,n);
}
static int wrap_name(int fd,struct sockaddr *v,socklen_t *n) {
    int rc=getsockname(fd,v,n);if(!rc && fd==target && fake_vsock)v->sa_family=AF_VSOCK;return rc;
}
#define setsockopt wrap_set
#define getsockopt wrap_get
#define getsockname wrap_name
#include "../../wasm/ggml-shielded/shielded-wire.c"
#undef setsockopt
#undef getsockopt
#undef getsockname
static sh_pipe fresh(int fds[2]) {
    assert(!socketpair(AF_UNIX,SOCK_STREAM,0,fds));target=fds[0];fake_vsock=1;
    sets=gets=fail_set=fail_get=short_get=mismatch_get=0;
    size_value=max_value=262144;memset(order,0,sizeof order);
    return (sh_pipe){.fd=target};
}
static void finish(sh_pipe *p,int fds[2]) {if(p->fd>=0)close(p->fd);close(fds[1]);}
static void closed(sh_pipe *p,int original) {
    assert(p->fd==-1 && !p->rcvbuf_saved);
    assert(fcntl(original,F_GETFD)==-1 && errno==EBADF);
}
static void success(void) {
    for(int larger_max=0;larger_max<2;larger_max++) {
        int fds[2];sh_pipe p=fresh(fds);if(larger_max)max_value=8388608;
        uint64_t original_max=max_value,actual=99;
        assert(!sh_pipe_set_rcvbuf(&p,0,&actual) && actual==262144 && !sets);
        assert(!sh_pipe_set_rcvbuf(&p,4194304,&actual) && actual==4194304 && p.rcvbuf_saved);
        assert(order[0]==SO_VM_SOCKETS_BUFFER_MAX_SIZE && order[1]==SO_VM_SOCKETS_BUFFER_SIZE);
        assert(sh_pipe_set_rcvbuf(&p,4194304,NULL)==SH_ERR_PROTO && sets==2);
        p.rcvlowat_cap=131072;assert(sh_pipe_set_rcvbuf(&p,0,NULL)==SH_ERR_PROTO && sets==2);
        p.rcvlowat_cap=0;assert(!sh_pipe_set_rcvbuf(&p,0,&actual) && actual==262144 && !p.rcvbuf_saved);
        assert(order[2]==SO_VM_SOCKETS_BUFFER_SIZE && order[3]==SO_VM_SOCKETS_BUFFER_MAX_SIZE);
        assert(size_value==262144 && max_value==original_max);
        assert(!sh_pipe_set_rcvbuf(&p,0,NULL) && sets==4);
        assert(!sh_pipe_set_rcvbuf(&p,4194304,NULL));assert(!sh_pipe_set_rcvbuf(&p,0,NULL));
        finish(&p,fds);
    }
}
static void failures(void) {
    int fds[2];sh_pipe p=fresh(fds);
    assert(sh_pipe_set_rcvbuf(&p,-1,NULL)==SH_ERR_PROTO);
    assert(sh_pipe_set_rcvbuf(&p,8388609,NULL)==SH_ERR_PROTO);
    assert(sh_pipe_set_rcvbuf(&p,131072,NULL)==SH_ERR_PROTO);
    p.ring=(uint8_t *)1;assert(sh_pipe_set_rcvbuf(&p,4194304,NULL)==SH_ERR_PROTO);p.ring=NULL;
    fake_vsock=0;assert(sh_pipe_set_rcvbuf(&p,4194304,NULL)==SH_ERR_IO && sets==0);
    finish(&p,fds);
    for(int pos=1;pos<=4;pos++) {
        p=fresh(fds);fail_set=pos;
        int rc=sh_pipe_set_rcvbuf(&p,4194304,NULL);
        if(pos>2) {assert(!rc);rc=sh_pipe_set_rcvbuf(&p,0,NULL);}
        assert(rc==SH_ERR_IO);closed(&p,fds[0]);finish(&p,fds);
    }
    for(int mode=0;mode<3;mode++)for(int pos=1;pos<=6;pos++) {
        p=fresh(fds);if(mode==0)fail_get=pos;else if(mode==1)short_get=pos;else mismatch_get=pos;
        /* An arbitrary valid initial size/max is legitimate: mismatch injection
         * only represents failure once an exact requested readback is expected. */
        if(mode==2 && pos<=2) {finish(&p,fds);continue;}
        int rc=sh_pipe_set_rcvbuf(&p,4194304,NULL);
        if(pos>4) {assert(!rc);rc=sh_pipe_set_rcvbuf(&p,0,NULL);}
        assert(rc==SH_ERR_IO);
        if(pos<=2)assert(p.fd==fds[0] && !sets && !p.rcvbuf_saved);else closed(&p,fds[0]);
        finish(&p,fds);
    }
}
int main(void) {alarm(5);success();failures();puts("receive buffer: PASS");}
