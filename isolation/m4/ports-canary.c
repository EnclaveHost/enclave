// Isolated hardware test. Each published RISC Box port has its own real
// WASI socket and worker. TCP echoes streams; UDP echoes exact datagrams.
#include <arpa/inet.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
static void *echo(void *v) {
 int spec=(int)(intptr_t)v,udp=spec<0,port=udp?-spec:spec;
 int fd=socket(AF_INET,udp?SOCK_DGRAM:SOCK_STREAM,0),yes=1;
 setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof yes);
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port),.sin_addr={.s_addr=htonl(INADDR_LOOPBACK)}};
 if(fd<0||bind(fd,(void*)&a,sizeof a))return (void*)1;
 char b[65507];
 if(udp){for(;;){struct sockaddr_in p; socklen_t n=sizeof p; ssize_t k=recvfrom(fd,b,sizeof b,0,(void*)&p,&n);if(k>=0)sendto(fd,b,k,0,(void*)&p,n);}}
 if(listen(fd,16))return (void*)1;
 for(;;){int c=accept(fd,NULL,NULL);if(c<0)continue;ssize_t n;while((n=read(c,b,sizeof b))>0){ssize_t done=0;while(done<n){ssize_t k=write(c,b+done,n-done);if(k<=0)break;done+=k;}}close(c);}
}
int main(void){
 int ports[]={2222,47984,47989,48010,-47998,-47999,-48000}; pthread_t t[7];
 for(int i=0;i<7;i++)if(pthread_create(&t[i],NULL,echo,(void*)(intptr_t)ports[i]))return 1;
 int fd=socket(AF_INET,SOCK_STREAM,0),yes=1;setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof yes);
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(8000),.sin_addr={.s_addr=htonl(INADDR_LOOPBACK)}};
 if(bind(fd,(void*)&a,sizeof a)||listen(fd,16))return 1;
 for(;;){int c=accept(fd,NULL,NULL);if(c<0)continue;char b[1024];if(read(c,b,sizeof b)>0){const char *r="HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nports-canary-ok\n";write(c,r,strlen(r));}close(c);}
}
