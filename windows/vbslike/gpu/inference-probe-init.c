/* Public-fixture diagnostic measured image only; never an admission artifact.
 * Requires the pinned CPU runtime tree, /init-real, /shielded-probe,
 * /infer-rt with the Shield engine + runner + calibration, and /model.gguf.
 * The complete image (including the fixed model) is hashed by its builder.
 * Logs this fixed PUBLIC prompt/output to serial. Do not accept user input.
 * See ../SHIELDED-GPU.md. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/wait.h>
int main(void) {
 mount("proc","/proc","proc",0,0); mount("sysfs","/sys","sysfs",0,0);
 mount("devtmpfs","/dev","devtmpfs",0,0);
 if(fork()==0) {
  sleep(20);
  printf("GPU_PROBE diagnostic: masking and verification execute inside the guest\n"); fflush(stdout);
  pid_t p=fork();
  if(p==0) { execl("/shielded-probe","shielded-probe","--host","vsock:2","--port","19595",NULL); _exit(127); }
  int status=0; if(p<0 || waitpid(p,&status,0)<0) _exit(1);
  printf("GPU_PROBE exit=%d\n",WIFEXITED(status)?WEXITSTATUS(status):128);fflush(stdout);
  if(!WIFEXITED(status) || WEXITSTATUS(status)) _exit(1);
  setenv("SHIELDED_HOST","vsock:2",1); setenv("SHIELDED_PORT","19595",1);
  setenv("SHIELDED_SO","/infer-rt/backends/libggml-shielded.so",1);
  setenv("GGML_CPU_SO","/infer-rt/backends/libggml-cpu.so",1);
  setenv("SHIELDED_CALIB","/infer-rt/calib/qwen2.5-0.5b-q8-gguf.calib",1);
  setenv("SHIELDED_RUN_THREADS","2",1); setenv("SHIELDED_REFILL_THREADS","2",1);
  setenv("OMP_NUM_THREADS","2",1); setenv("SHIELDED_POOL_DEPTH","8",1);
  printf("GPU_INFERENCE public fixture only; Qwen 0.5B, fixed prompt, 32 tokens\n"); fflush(stdout);
  p=fork();
  if(p==0) { execl("/infer-rt/ld-linux-x86-64.so.2","ld-linux","--library-path","/infer-rt","/infer-rt/shielded-run","/model.gguf","The capital of France is", "32",NULL); _exit(127); }
  if(p<0 || waitpid(p,&status,0)<0) _exit(1);
  printf("GPU_INFERENCE exit=%d\n",WIFEXITED(status)?WEXITSTATUS(status):128);fflush(stdout);_exit(0);
 }
 execl("/init-real","init",NULL); return 1;
}
