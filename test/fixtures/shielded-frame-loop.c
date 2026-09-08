/* Host socketpair fixture for anchor-frame-loop.h (the bridgebench engine). A framed echo thread reads a
 * whole frame (4-byte BE length + payload) then echoes it; the fixture forces small socket buffers so a
 * 3 MiB frame exercises partial reads/writes and poll waits in BOTH directions. Cases: 3 MiB success,
 * size 1 success (no marker overlap), a dead reader (echo never drains) -> write-side timeout, a dead
 * writer (echo never replies) -> read-side timeout, a middle-byte corruption -> content mismatch, and a
 * partial header (echo returns 2 of 4 length bytes then stalls) -> timeout, plus an fd/flag audit. */
#define _GNU_SOURCE
#include "../../shielded/anchor/avf/host/anchor-frame-loop.h"
#include <assert.h>
#include <dirent.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
static int count_fds(void){DIR*d=opendir("/proc/self/fd");int n=0;struct dirent*e;while((e=readdir(d)))if(e->d_name[0]!='.')n++;closedir(d);return n-1;}
static void small_bufs(int fd){int v=8192;setsockopt(fd,SOL_SOCKET,SO_SNDBUF,&v,sizeof v);setsockopt(fd,SOL_SOCKET,SO_RCVBUF,&v,sizeof v);}
static int readn(int fd,uint8_t*p,size_t n){size_t o=0;while(o<n){ssize_t r=read(fd,p+o,n-o);if(r>0){o+=(size_t)r;continue;}if(r==0)return -1;if(errno==EINTR)continue;return -1;}return 0;}
static int writen(int fd,const uint8_t*p,size_t n){size_t o=0;while(o<n){ssize_t w=send(fd,p+o,n-o,MSG_NOSIGNAL);if(w>0){o+=(size_t)w;continue;}if(errno==EINTR)continue;return -1;}return 0;}
/* echo modes: 0 faithful, 1 corrupt one middle byte, 2 dead reader (drain nothing), 3 dead writer (drain, never reply), 4 partial header, 5 wrong echoed length */
typedef struct{int fd,mode;}echo_arg;
static void*echo(void*a){echo_arg*e=a;int fd=e->fd;uint8_t*buf=malloc(3u<<20);   /* run_case owns fd; the thread never closes it */
  if(e->mode==2){free(buf);return NULL;}               /* never read: the peer's write fills the buffer then times out */
  for(;;){uint8_t h[4];if(readn(fd,h,4))break;uint32_t n=afl_get_be32(h);if(n>(3u<<20))break;if(readn(fd,buf,n))break;
    if(e->mode==3)continue;                            /* drained, never reply */
    if(e->mode==4){uint8_t two[2]={h[0],h[1]};writen(fd,two,2);continue;}   /* half a length, then stall */
    if(e->mode==5){uint8_t bad[4];afl_put_be32(bad,n^1u);writen(fd,bad,4);continue;}   /* full frame drained, wrong echoed length */
    if(e->mode==1&&n>=3)buf[n/2]^=0xff;
    if(writen(fd,h,4)||writen(fd,buf,n))break;}
  free(buf);return NULL;}
static int run_case(int mode,size_t sz,int timeout_ms,anchor_frame_stats*st){
  int sp[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,sp));small_bufs(sp[0]);small_bufs(sp[1]);
  echo_arg ea={sp[1],mode};pthread_t th;assert(!pthread_create(&th,NULL,echo,&ea));
  uint8_t*sb=malloc(sz),*rb=malloc(sz);assert(sb&&rb);
  int fl=fcntl(sp[0],F_GETFL);
  int rc=anchor_frame_bench(sp[0],sz,2,mode?4:20,timeout_ms,sb,rb,st);
  assert(fcntl(sp[0],F_GETFL)==fl);                    /* flags restored */
  close(sp[0]);                                        /* wakes a thread blocked reading sp[1] with EOF */
  pthread_join(th,NULL);
  close(sp[1]);                                        /* run_case owns both ends: no descriptor leaks */
  free(sb);free(rb);return rc;}

/* control-frame peer for anchor_frame_control: reads the 4-byte 0-length request, then per mode:
   'a' echoes a 0-length ack; 'b' reads and never replies (deadline); 'c' replies a nonzero-length ack. */
typedef struct { int fd; char mode; } ctl_arg;
static void *ctl_peer(void *a){ ctl_arg*e=a; uint8_t h[4]; if(readn(e->fd,h,4)==0){
    if(e->mode=='a'){ uint8_t z[4]={0,0,0,0}; writen(e->fd,z,4); }
    else if(e->mode=='c'){ uint8_t nz[5]={0,0,0,1,7}; writen(e->fd,nz,5); }
    /* 'b': read the request, send nothing */
  } return NULL; }
static int ctl_case(char mode,int timeout_ms){
  int sp[2]; assert(!socketpair(AF_UNIX,SOCK_STREAM,0,sp));
  ctl_arg ea={sp[1],mode}; pthread_t th; assert(!pthread_create(&th,NULL,ctl_peer,&ea));
  int rc=anchor_frame_control(sp[0],timeout_ms);
  close(sp[0]); pthread_join(th,NULL); close(sp[1]); return rc; }

int main(void){
  setvbuf(stdout,NULL,_IONBF,0);   /* NO global SIGPIPE ignore: the helper must be signal-safe on its own (MSG_NOSIGNAL) */
  const int fds0=count_fds();anchor_frame_stats st;
  assert(run_case(0,3u<<20,5000,&st)==AFL_OK);printf("case success 3MiB: p50=%.0f us n=%d\n",st.p50_us,st.iters);
  assert(run_case(0,1,2000,&st)==AFL_OK);printf("case success size 1: ok (deterministic full compare, no marker overlap)\n");
  /* Failure FIELD assertions: the phase, iteration and moved/total bytes must locate the exact stall.
   * Each memset dirties st first, so a pass proves anchor_frame_bench wrote every field it promises. */
  memset(&st,0x5a,sizeof st);int rc=run_case(2,3u<<20,600,&st);
  assert(rc==AFL_TIMEOUT&&st.fail_phase==AFP_WRITE_PAYLOAD&&st.fail_iter==0&&st.fail_total==(3u<<20)&&st.fail_moved<st.fail_total);
  printf("case dead reader: %s phase=write_payload moved=%llu/%llu iter=%d\n",afl_strerror(rc),st.fail_moved,st.fail_total,st.fail_iter);
  memset(&st,0x5a,sizeof st);rc=run_case(3,65536,600,&st);
  assert(rc==AFL_TIMEOUT&&st.fail_phase==AFP_READ_LEN&&st.fail_moved==0&&st.fail_total==4&&st.fail_iter==0);
  printf("case dead writer: %s phase=read_len moved=%llu/%llu\n",afl_strerror(rc),st.fail_moved,st.fail_total);
  memset(&st,0x5a,sizeof st);rc=run_case(4,65536,600,&st);
  assert(rc==AFL_TIMEOUT&&st.fail_phase==AFP_READ_LEN&&st.fail_moved==2&&st.fail_total==4);
  printf("case partial header: %s phase=read_len moved=2/4\n",afl_strerror(rc));
  memset(&st,0x5a,sizeof st);rc=run_case(1,65536,3000,&st);
  assert(rc==AFL_CONTENT&&st.fail_phase==AFP_READ_PAYLOAD&&st.fail_moved==65536&&st.fail_total==65536&&st.fail_iter==0);
  printf("case middle-byte corruption: %s phase=read_payload (full frame read, bytes wrong)\n",afl_strerror(rc));
  memset(&st,0x5a,sizeof st);rc=run_case(5,65536,3000,&st);
  assert(rc==AFL_LENGTH&&st.fail_phase==AFP_READ_LEN&&st.fail_moved==4&&st.fail_total==4);
  printf("case echoed length mismatch: %s phase=read_len\n",afl_strerror(rc));
  /* Pre-transfer errors keep the AFP_NONE no-phase sentinel and 0 bytes moved. Each range case has exactly
   * one bad argument, so the range guard returns before any I/O touches fd 0. */
  { uint8_t b[8]; anchor_frame_stats r; memset(&r,0x33,sizeof r);
    assert(anchor_frame_bench(-1,4,0,1,10,b,b,&r)==AFL_RANGE&&r.fail_phase==AFP_NONE&&r.fail_moved==0&&r.iters==0);
    assert(anchor_frame_bench(0,0,0,1,10,b,b,&r)==AFL_RANGE);       /* sz 0 */
    assert(anchor_frame_bench(0,4,0,0,10,b,b,&r)==AFL_RANGE);       /* iters<1 */
    assert(anchor_frame_bench(0,4,-1,1,10,b,b,&r)==AFL_RANGE);      /* warm<0 */
    assert(anchor_frame_bench(0,4,0,1,0,b,b,&r)==AFL_RANGE);        /* per_rt_timeout<1 */
    assert(anchor_frame_bench(0,4,0,1,10,NULL,b,&r)==AFL_RANGE);    /* null sbuf */
    assert(anchor_frame_bench(0,4,0,1,10,b,b,NULL)==AFL_RANGE);     /* null st: must not crash */
    printf("case range: bad args -> AFL_RANGE, no-phase sentinel\n"); }
  /* A valid but closed fd fails fcntl before any transfer -> AFL_SETUP, still the no-phase sentinel. */
  { int sp[2]; assert(!socketpair(AF_UNIX,SOCK_STREAM,0,sp)); close(sp[0]); close(sp[1]);
    uint8_t b[8]; anchor_frame_stats r; memset(&r,0x33,sizeof r);
    int rc2=anchor_frame_bench(sp[0],4,0,1,10,b,b,&r);
    assert(rc2==AFL_SETUP&&r.fail_phase==AFP_NONE&&r.fail_moved==0&&r.iters==0);
    printf("case setup: closed fd -> %s, no-phase sentinel\n",afl_strerror(rc2)); }
  assert(run_case(0,262144,4000,&st)==AFL_OK);
  { int rc=ctl_case('a',2000); assert(rc==AFL_OK); printf("case control handshake ok\n"); }
  { int rc=ctl_case('b',300); assert(rc==AFL_TIMEOUT); printf("case control no-ack -> timeout\n"); }
  { int rc=ctl_case('c',2000); assert(rc==AFL_LENGTH); printf("case control nonzero-ack -> length error\n"); }
  assert(count_fds()==fds0);
  puts("frame-loop: success(3MiB/1/256K), timeout+phase(reader/writer/partial-hdr), content+phase, length+phase, range+setup sentinel, control(ok/timeout/length), fd audit passed");
  return 0;}
