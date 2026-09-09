/* Actual wire source, real TCP fragmentation and injected option/read failures.
 * TCP exercises readiness/tails; it does not prove the Android VSOCK wake gate. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <linux/vm_sockets.h>
static int target=-1, fake_vsock=0, set_fail=0, set_calls=0, get_mismatch=0;
static int poll_interrupt=0, recv_interrupt=0, recv_again=0, recv_fragment=0;
static unsigned long long capacity=262144;
static int wrap_set(int fd,int level,int opt,const void *v,socklen_t n) {
    if(fd==target && level==SOL_SOCKET && opt==SO_RCVLOWAT) {
        ++set_calls;
        if(set_calls==set_fail) {errno=EIO;return -1;}
    }
    return setsockopt(fd,level,opt,v,n);
}
static int wrap_get(int fd,int level,int opt,void *v,socklen_t *n) {
    if(fd==target && fake_vsock && level==AF_VSOCK && opt==SO_VM_SOCKETS_BUFFER_SIZE) {
        assert(*n==sizeof capacity);memcpy(v,&capacity,*n);return 0;
    }
    int rc=getsockopt(fd,level,opt,v,n);
    if(!rc && fd==target && opt==SO_RCVLOWAT && get_mismatch && set_calls==1) *(int *)v=1;
    return rc;
}
static int wrap_name(int fd,struct sockaddr *a,socklen_t *n) {
    int rc=getsockname(fd,a,n);
    if(!rc && fd==target && fake_vsock)a->sa_family=AF_VSOCK;
    return rc;
}
static int wrap_poll(struct pollfd *fds,nfds_t n,int timeout) {
    if(n==1 && fds[0].fd==target && poll_interrupt) {--poll_interrupt;errno=EINTR;return -1;}
    return poll(fds,n,timeout);
}
static ssize_t wrap_recv(int fd,void *p,size_t n,int flags) {
    if(fd==target) {
        assert(flags==MSG_DONTWAIT);
        if(recv_interrupt) {--recv_interrupt;errno=EINTR;return -1;}
        if(recv_again) {--recv_again;errno=EAGAIN;return -1;}
        if(recv_fragment && n>3) {size_t bound=n<=9?3:4093;if(n>bound)n=bound;--recv_fragment;}
    }
    return recv(fd,p,n,flags);
}
#define setsockopt wrap_set
#define getsockopt wrap_get
#define getsockname wrap_name
#define poll wrap_poll
#define recv wrap_recv
#include "../../wasm/ggml-shielded/shielded-wire.c"
#undef setsockopt
#undef getsockopt
#undef getsockname
#undef poll
#undef recv
static void tcp_pair(int fds[2]) {
    int l=socket(AF_INET,SOCK_STREAM,0);assert(l>=0);
    struct sockaddr_in a={.sin_family=AF_INET,.sin_addr={htonl(INADDR_LOOPBACK)}};
    assert(!bind(l,(struct sockaddr *)&a,sizeof a) && !listen(l,1));
    socklen_t n=sizeof a;assert(!getsockname(l,(struct sockaddr *)&a,&n));
    fds[0]=socket(AF_INET,SOCK_STREAM,0);assert(fds[0]>=0);
    assert(!connect(fds[0],(struct sockaddr *)&a,n));fds[1]=accept(l,NULL,NULL);assert(fds[1]>=0);close(l);
    int one=1;assert(!setsockopt(fds[1],IPPROTO_TCP,TCP_NODELAY,&one,sizeof one));
    target=fds[0];set_calls=0;set_fail=0;get_mismatch=0;fake_vsock=0;capacity=262144;
    poll_interrupt=recv_interrupt=recv_again=recv_fragment=0;
}
static int mark(int fd) {int v=0;socklen_t n=sizeof v;assert(!getsockopt(fd,SOL_SOCKET,SO_RCVLOWAT,&v,&n));return v;}
static void send_bytes(int fd,const void *p,size_t n) {
    while(n) {ssize_t r=send(fd,p,n,MSG_NOSIGNAL);assert(r>0);p=(const char *)p+r;n-=r;}
}
struct job {int fd,mode;size_t size;};
static void *server(void *v) {
    struct job *j=v;uint8_t h[9],q[3];assert(read_all(j->fd,h,9)==SH_OK && read_all(j->fd,q,3)==SH_OK);
    memset(h,0,sizeof h);h[0]=j->mode==3;put_u64(h+1,j->mode==4?SH_MAX_FRAME+1:j->size);
    send_bytes(j->fd,h,j->mode==1?4:9);
    if(j->mode!=1 && j->mode!=4) {
        size_t n=j->mode==2?37:j->size;uint8_t b[16381];size_t pos=0;
        while(pos<n) {size_t k=n-pos<sizeof b?n-pos:sizeof b;
            for(size_t i=0;i<k;i++)b[i]=(uint8_t)((pos+i)*17+3);
            send_bytes(j->fd,b,k);pos+=k;
        }
    }
    if(j->mode==0) {char ack;assert(read(j->fd,&ack,1)==1 && ack==42);}
    assert(!shutdown(j->fd,SHUT_WR));return NULL;
}
static void exchange(int enabled,int mode) {
    int fds[2];tcp_pair(fds);int old=7;assert(!setsockopt(target,SOL_SOCKET,SO_RCVLOWAT,&old,sizeof old));
    sh_pipe *p=calloc(1,sizeof *p);assert(p);p->fd=target;
    assert(sh_pipe_set_rcvlowat(p,131072,NULL)==SH_ERR_IO); /* real TCP refused */
    if(enabled) {fake_vsock=1;uint64_t bytes=0;assert(sh_pipe_set_rcvlowat(p,131072,&bytes)==SH_OK && bytes==capacity);assert(mark(target)==old);}
    struct job j={fds[1],mode,262145};pthread_t t;assert(!pthread_create(&t,NULL,server,&j));
    if(enabled) {poll_interrupt=1;recv_interrupt=1;recv_again=1;recv_fragment=100;}
    uint8_t q[3]={4,5,6};sh_reply out;
    int rc=sh_pipe_call(p,SH_CMD_FIELD_GEMM24,q,sizeof q,&out);
    assert(rc==(mode==0?SH_OK:mode==3?SH_ERR_VIOLATION:mode==4?SH_ERR_PROTO:SH_ERR_IO));
    if(!mode) {assert(out.len==j.size);for(size_t i=0;i<out.len;i++)assert(((uint8_t *)out.data)[i]==(uint8_t)(i*17+3));}
    else assert(!out.data && !out.len);
    assert(mark(target)==old && !(fcntl(target,F_GETFL)&O_NONBLOCK));
    if(!enabled)assert(set_calls==0);
    if(!mode) {char ack=42;send_bytes(target,&ack,1);}
    assert(!pthread_join(t,NULL));close(fds[1]);sh_pipe_close(p);
}
static void failures(void) {
    int fds[2];tcp_pair(fds);sh_pipe p={.fd=fds[0]};fake_vsock=1;
    assert(sh_pipe_set_rcvlowat(&p,-1,NULL)==SH_ERR_PROTO);
    assert(sh_pipe_set_rcvlowat(&p,131073,NULL)==SH_ERR_PROTO);
    capacity=131072;assert(sh_pipe_set_rcvlowat(&p,131072,NULL)==SH_ERR_PROTO);capacity=262144;
    get_mismatch=1;assert(sh_pipe_set_rcvlowat(&p,131072,NULL)==SH_ERR_IO && !p.rcvlowat_cap && mark(target)==1);
    get_mismatch=0;set_calls=0;set_fail=1;assert(sh_pipe_set_rcvlowat(&p,131072,NULL)==SH_ERR_IO && mark(target)==1);
    set_calls=0;set_fail=0;assert(sh_pipe_set_rcvlowat(&p,131072,NULL)==SH_OK);
    set_calls=0;set_fail=1;uint8_t out[9];assert(read_reply(&p,out,sizeof out)==SH_ERR_IO && mark(target)==1);
    set_fail=0;set_calls=0;send_bytes(fds[1],"123456789",9);
    /* Successful read, failed restoration: must close and invalidate the fd. */
    set_fail=2;assert(read_reply(&p,out,sizeof out)==SH_ERR_IO && p.fd==-1);
    assert(fcntl(fds[0],F_GETFD)==-1 && errno==EBADF);close(fds[1]);
    tcp_pair(fds);p.fd=fds[0];fake_vsock=1;set_fail=2;
    assert(sh_pipe_set_rcvlowat(&p,131072,NULL)==SH_ERR_IO && p.fd==-1);close(fds[1]);
}
int main(void) {
    alarm(10);
    for(int enabled=0;enabled<2;enabled++)for(int mode=0;mode<5;mode++)exchange(enabled,mode);
    failures();puts("receive low-water: PASS");return 0;
}
