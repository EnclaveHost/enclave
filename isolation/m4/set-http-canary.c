// Hardware test: each HTTP request runs and joins four real guest pthreads.
#include <arpa/inet.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
static atomic_int count;
static void *worker(void *unused) { (void)unused; atomic_fetch_add(&count, 1); return NULL; }
int main(void) {
 int fd=socket(AF_INET, SOCK_STREAM, 0), yes=1;
 setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof yes);
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(8000),.sin_addr={.s_addr=htonl(INADDR_LOOPBACK)}};
 if(fd<0 || bind(fd,(void*)&a,sizeof a) || listen(fd,16)) return 1;
 for(;;) {
  int c=accept(fd,NULL,NULL); if(c<0) continue;
  char req[1024]; if(read(c,req,sizeof req)<=0){close(c);continue;}
  pthread_t t[4]; int started=0; atomic_store(&count,0);
  for(int i=0;i<4;i++) if(!pthread_create(&t[started],NULL,worker,NULL)) started++;
  for(int i=0;i<started;i++) pthread_join(t[i],NULL);
  char body[80], response[256];
  int n=snprintf(body,sizeof body,"spawned=%d joined=%d\n",started,atomic_load(&count));
  int len=snprintf(response,sizeof response,"HTTP/1.1 %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",started==4&&atomic_load(&count)==4?"200 OK":"500 Failed",n,body);
  write(c,response,len); close(c);
 }
}
