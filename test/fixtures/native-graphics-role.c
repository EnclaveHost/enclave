/* Disposable guest test only. Joins the running desktop, then applies its role
 * policy before any graphics command. Never installed in a production image. */
#define _GNU_SOURCE
#include "role-policy.h"
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/stat.h>
#define CHECK(x) do { if (!(x)) { perror(#x); return 65; } } while (0)
static int read_file(const char *path,char *out,size_t limit) {
 int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0)return -1;
 size_t used=0;while(used<limit){ssize_t n=read(fd,out+used,limit-used);if(n<0){close(fd);return -1;}if(!n)break;used+=(size_t)n;}
 char extra;ssize_t n=read(fd,&extra,1);close(fd);if(n!=0||used==limit)return -1;out[used]=0;return (int)used;
}
int main(int argc,char **argv) {
 if((argc!=2&&argc!=3)||getuid()!=0||geteuid()!=0)return 64;
 int masked=argc==3;if(masked&&strcmp(argv[2],"masked"))return 64;
 char *end;long pid=strtol(argv[1],&end,10);if(*end||pid<2||pid>2147483647)return 64;
 char path[96],env[16384],script[32768];
 CHECK(read_file("/probe-native-graphics.py",script,sizeof script-1)>0);
 const char *assets[]={"prepass","prepass-gl","linear-prepass.comp.spv","prepass.vert.spv","prepass.frag.spv","prepass-gl.comp"};
 int inputs[6];
 if(masked)for(int i=0;i<6;i++){
  snprintf(path,sizeof path,"/probe-graphics-assets/%s",assets[i]);
  inputs[i]=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);CHECK(inputs[i]>=0);
  struct stat st;CHECK(fstat(inputs[i],&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==0&&!(st.st_mode&0222)&&st.st_size>0&&st.st_size<1048576);
 }
 snprintf(path,sizeof path,"/proc/%ld/environ",pid);int bytes=read_file(path,env,sizeof env-1);CHECK(bytes>0);
 char *envp[64];int count=0;for(int at=0;at<bytes;){CHECK(count<63);char *s=env+at;size_t n=strnlen(s,(size_t)(bytes-at));CHECK(n<(size_t)(bytes-at));envp[count++]=s;at+=(int)n+1;}envp[count]=NULL;
 snprintf(path,sizeof path,"/proc/%ld/root",pid);int root=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC);CHECK(root>=0);
 const char *names[]={"mnt","net","ipc","uts","pid"};
 int fds[5];for(int i=0;i<5;i++){snprintf(path,sizeof path,"/proc/%ld/ns/%s",pid,names[i]);fds[i]=open(path,O_RDONLY|O_CLOEXEC);CHECK(fds[i]>=0);}
 for(int i=0;i<5;i++){CHECK(setns(fds[i],0)==0);close(fds[i]);}
 pid_t child=fork();CHECK(child>=0);
 if(child){close(root);int status;CHECK(waitpid(child,&status,0)==child);return WIFEXITED(status)?WEXITSTATUS(status):66;}
 CHECK(fchdir(root)==0&&chroot(".")==0&&chdir("/")==0);close(root);
 if(masked){
  CHECK(mkdir("/tmp/native-graphics-input",0700)==0);
  int dir=open("/tmp/native-graphics-input",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);CHECK(dir>=0);
  for(int i=0;i<6;i++){
   int output=openat(dir,assets[i],O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0500);CHECK(output>=0);
   char buffer[8192];ssize_t n;
   while((n=read(inputs[i],buffer,sizeof buffer))>0){
    ssize_t at=0;while(at<n){ssize_t wrote=write(output,buffer+at,(size_t)(n-at));CHECK(wrote>0);at+=wrote;}
   }
   CHECK(n==0&&fchmod(output,0555)==0);close(output);close(inputs[i]);
  }
  CHECK(fchmod(dir,0555)==0);close(dir);
 }
 CHECK(syscall(SYS_close_range,3U,~0U,0)==0&&native_enter_role(1000)==0);
 char *const args[]={"/usr/bin/python3","-I","-c",script,masked?"masked":NULL,NULL};execve(args[0],args,envp);perror("exec graphics");return 127;
}
