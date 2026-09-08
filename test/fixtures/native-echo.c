#include "../../shielded/anchor/avf/host/native-echo.c"
#include <assert.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {int fd,timeout;int64_t result;} echo_job;
typedef struct {int fd;unsigned char *data;size_t size;int failed;} write_job;
static void *echo_thread(void *arg) {echo_job *j=arg;j->result=anchor_native_echo(j->fd,j->timeout);return NULL;}
static void *write_thread(void *arg) {
    write_job *j=arg;size_t at=0;
    while(at<j->size) {
        size_t n=j->size-at;if(n>17003)n=17003;
        ssize_t rc=send(j->fd,j->data+at,n,MSG_NOSIGNAL);
        if(rc<0 && errno==EINTR)continue;
        if(rc<=0){j->failed=1;return NULL;}at+=(size_t)rc;
    }
    assert(shutdown(j->fd,SHUT_WR)==0);return NULL;
}
int main(void) {
    const size_t size=(4<<20)+3;unsigned char *data=malloc(size);assert(data);
    for(size_t i=0;i<size;i++)data[i]=(unsigned char)(i*17+i/13);
    int pair[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    int small=8192;for(int i=0;i<2;i++) {
        assert(setsockopt(pair[i],SOL_SOCKET,SO_SNDBUF,&small,sizeof small)==0);
        assert(setsockopt(pair[i],SOL_SOCKET,SO_RCVBUF,&small,sizeof small)==0);
    }
    int flags=fcntl(pair[1],F_GETFL);assert(flags>=0);
    echo_job echo={pair[1],10000,0};write_job writer={pair[0],data,size,0};pthread_t et,wt;
    assert(pthread_create(&et,NULL,echo_thread,&echo)==0);
    assert(pthread_create(&wt,NULL,write_thread,&writer)==0);
    unsigned char got[997];size_t at=0;
    while(at<size) {
        size_t want=size-at;if(want>sizeof got)want=sizeof got;
        ssize_t n=recv(pair[0],got,want,0);assert(n>0);
        assert(!memcmp(got,data+at,(size_t)n));at+=(size_t)n;
    }
    assert(pthread_join(wt,NULL)==0 && !writer.failed);assert(pthread_join(et,NULL)==0);
    assert(echo.result==(int64_t)size && fcntl(pair[1],F_GETFL)==flags);
    close(pair[0]);close(pair[1]);
    // Idle reads and blocked writes have bounded deadlines. The helper neither
    // closes its descriptor nor changes shared O_NONBLOCK flags.
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    assert(anchor_native_echo(pair[1],5)==-ETIMEDOUT);
    assert(fcntl(pair[1],F_GETFD)>=0);
    echo=(echo_job){pair[1],30,0};writer=(write_job){pair[0],data,size,0};
    assert(pthread_create(&et,NULL,echo_thread,&echo)==0);
    assert(pthread_create(&wt,NULL,write_thread,&writer)==0);
    assert(pthread_join(et,NULL)==0 && echo.result==-ETIMEDOUT);
    close(pair[1]);assert(pthread_join(wt,NULL)==0 && writer.failed);close(pair[0]);
    assert(anchor_native_echo(-1,1)==-EINVAL);free(data);puts("native-echo: ok");
}
