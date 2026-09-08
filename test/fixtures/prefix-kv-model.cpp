#include "llama.h"
#include "ggml-backend.h"
#include "prefix-kv.h"
#include "prefix-kv-llama.h"
#include "shielded-sha256.h"
extern "C" {
#include "tweetnacl.h"
}
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
#include <algorithm>
#include <string>
#include <fcntl.h>
#include <unistd.h>
static void quiet(ggml_log_level l,const char *s,void*) {if(l>=GGML_LOG_LEVEL_WARN) fputs(s,stderr);}
int main(int argc,char **argv) {
 assert(argc==4); assert(ggml_backend_load(argv[2])); llama_backend_init(); llama_log_set(quiet,nullptr);
 auto mp=llama_model_default_params(); mp.n_gpu_layers=0; mp.load_mtp=true;
 auto *m=llama_model_load_from_file(argv[1],mp); assert(m);
 auto cp=llama_context_default_params(); cp.n_ctx=64; cp.n_batch=32; cp.n_ubatch=32; cp.n_threads=2; cp.n_threads_batch=2; cp.no_perf=true;
 auto *a=llama_init_from_model(m,cp); auto *b=llama_init_from_model(m,cp); assert(a&&b);
 const char *prefix="The capital of France is"; std::vector<llama_token> tokens(32);
 auto *v=llama_model_get_vocab(m); const int nv=llama_vocab_n_tokens(v);
 int n=llama_tokenize(v,prefix,strlen(prefix),tokens.data(),tokens.size(),true,true); assert(n>0); tokens.resize(n);
 assert(llama_decode(a,llama_batch_get_one(tokens.data(),n))==0);
 const std::string path=std::string(argv[3])+"/proof.kv";
 assert(llama_state_seq_save_file(a,path.c_str(),0,tokens.data(),tokens.size())>0);
 uint8_t pk[32],sk[64],digest[32]={},model_digest[32]; crypto_sign_keypair(pk,sk); char err[256];
 assert(sh_sha256_file(argv[1],model_digest,nullptr)==0);
 assert(sh_prefix_kv_sign_v2(path.c_str(),model_digest,digest,prefix,strlen(prefix),n,sk,err,sizeof err)==0);
 memset(sk,0,sizeof sk);
 int fd=open(path.c_str(),O_RDONLY); assert(fd>=0); sh_prefix_kv_snapshot snap{};
 assert(sh_prefix_kv_snapshot_read_v2(path.c_str(),fd,pk,model_digest,digest,prefix,strlen(prefix),size_t(128)<<20,64,&snap,err,sizeof err)==0); close(fd);
 const uint8_t *state=nullptr; size_t size=0;
 assert(sh_prefix_kv_snapshot_state(&snap,LLAMA_STATE_SEQ_MAGIC,LLAMA_STATE_SEQ_VERSION,nv,&state,&size,err,sizeof err)==0);
 const size_t snapshot_size=snap.size;
 // Destroy the same source inode after verification: only retained private bytes may be loaded.
 fd=open(path.c_str(),O_WRONLY|O_TRUNC); assert(fd>=0); assert(write(fd,"corrupted",9)==9); close(fd);
 assert(sh_prefix_kv_load_snapshot(b,&snap,0,nv,err,sizeof err)==0); sh_prefix_kv_snapshot_free(&snap);
 auto *la=llama_get_logits_ith(a,-1); llama_token next=std::max_element(la,la+nv)-la;
 size_t compared=0;
 for(int i=0;i<8;i++) {
  auto batch=llama_batch_get_one(&next,1); assert(llama_decode(a,batch)==0); assert(llama_decode(b,batch)==0);
  la=llama_get_logits_ith(a,-1); auto *lb=llama_get_logits_ith(b,-1);
  assert(!memcmp(la,lb,nv*sizeof(float))); compared+=nv; next=std::max_element(la,la+nv)-la;
 }
 printf("PREFIX_SNAPSHOT_EQUIVALENT steps=8 logits=%zu snapshot_bytes=%zu source_truncated_before_load=1\n",compared,snapshot_size);
 llama_free(b); llama_free(a); llama_model_free(m); llama_backend_free();
 unlink(path.c_str()); unlink((path+".sig").c_str());
}
