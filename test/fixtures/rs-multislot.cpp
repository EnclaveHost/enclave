// Compare the output file with ENCLAVE_GGML_RS_ALIAS=0 and =1.
// Eight resident sessions, shared-prefix COW, alternating heads and rollback.
#include "enclave_llama.h"
#include <cassert>
#include <cstdio>
#include <vector>
#include <cstdlib>
int main(int argc,char**argv){
 assert(argc==3);ell_init();void*m=ell_load_model(argv[1],0);assert(m);
 void*c=ell_new_server(m,2048,16,16,0,0,1);assert(c);assert(ell_rewind_depth(c)==1);
 int nv=ell_n_vocab(m);FILE*out=fopen(argv[2],"wb");assert(out);
 auto step=[&](int seq,int pos,std::vector<int> t){std::vector<float> y(nv*t.size());assert(ell_decode_seq_full(c,m,seq,pos,t.data(),t.size(),y.data())==0);assert(fwrite(y.data(),sizeof(float),y.size(),out)==y.size());};
 for(int s=0;s<8;s++)for(int p=0;p<32;p+=8){std::vector<int> t;for(int i=0;i<8;i++)t.push_back(100+s*23+(p+i)%17);step(s,p,t);}
 // All heads are live. Copy a branch then diverge source and borrower.
 for(int s=0;s<8;s++)ell_seq_copy(c,s,s+8);
 for(int p=32;p<38;p++)for(int s=0;s<16;s++)step(s,p,{500+s*7+p});
 for(int s=0;s<16;s++){
   step(s,38,{700+s,800+s});
   assert(ell_seq_rewind(c,s,39)==0);
   step(s,39,{900+s}); // must load snapshot, never alias the wrong group
   step(s,40,{1000+s}); // alias becomes safe again
 }
 // Recycle nonzero heads after removing their owners.
 for(int s=0;s<16;s++){ell_seq_remove(c,s);step(s,0,{123+s,456+s});}
 fclose(out);ell_free_context(c);ell_free_model(m);puts("RS_MULTISLOT_PASS");
}
