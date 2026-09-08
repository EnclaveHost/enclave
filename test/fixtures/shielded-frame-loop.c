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
/* echo modes: 0 faithful, 1 corrupt one middle byte, 2 dead reader (drain nothing), 3 dead writer (drain, never reply), 4 partial header */
typedef struct{int fd,mode;}echo_arg;
static void*echo(void*a){echo_arg*e=a;int fd=e->fd;uint8_t*buf=malloc(3u<<20);   /* run_case owns fd; the thread never closes it */
  if(e->mode==2){free(buf);return NULL;}               /* never read: the peer's write fills the buffer then times out */
  for(;;){uint8_t h[4];if(readn(fd,h,4))break;uint32_t n=afl_get_be32(h);if(n>(3u<<20))break;if(readn(fd,buf,n))break;
    if(e->mode==3)continue;                            /* drained, never reply */
    if(e->mode==4){uint8_t two[2]={h[0],h[1]};writen(fd,two,2);continue;}   /* half a length, then stall */
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
int main(void){
  setvbuf(stdout,NULL,_IONBF,0);   /* NO global SIGPIPE ignore: the helper must be signal-safe on its own (MSG_NOSIGNAL) */
  const int fds0=count_fds();anchor_frame_stats st;
  assert(run_case(0,3u<<20,5000,&st)==AFL_OK);printf("case success 3MiB: p50=%.0f us n=%d\n",st.p50_us,st.iters);
  assert(run_case(0,1,2000,&st)==AFL_OK);printf("case success size 1: ok (deterministic full compare, no marker overlap)\n");
  int rc=run_case(2,3u<<20,600,&st);assert(rc==AFL_TIMEOUT);printf("case dead reader: %s\n",afl_strerror(rc));
  rc=run_case(3,65536,600,&st);assert(rc==AFL_TIMEOUT);printf("case dead writer: %s\n",afl_strerror(rc));
  rc=run_case(1,65536,3000,&st);assert(rc==AFL_CONTENT);printf("case middle-byte corruption: %s\n",afl_strerror(rc));
  rc=run_case(4,65536,600,&st);assert(rc==AFL_TIMEOUT);printf("case partial header: %s\n",afl_strerror(rc));
  assert(run_case(0,262144,4000,&st)==AFL_OK);
  assert(count_fds()==fds0);
  puts("frame-loop: 3MiB success, size 1, dead reader/writer timeout, corruption, partial header, fd audit passed");
  return 0;}
