#include "ggml.h"
#include "ggml-cpu.h"
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cassert>
#include <cmath>
#include <chrono>
int main(){
 auto*ctx=ggml_init({size_t(128)<<20,nullptr,false});
 std::vector<ggml_cgraph*> gs;
 auto tensor=[&](int n,int rows){auto*t=ggml_new_tensor_2d(ctx,GGML_TYPE_F32,n,rows);for(int i=0;i<n*rows;i++)((float*)t->data)[i]=sinf(i*.03f)*.4f;return t;};
 for(int rows:{1,2,4,64}){
 auto*x=tensor(5120,rows);auto*w=tensor(5120,1);
 auto*y=ggml_add(ctx,ggml_mul(ctx,ggml_rms_norm(ctx,x,1e-6f),w),x);
 auto*g=ggml_new_graph(ctx);ggml_build_forward_expand(g,y);gs.push_back(g);
 auto*z=ggml_swiglu(ctx,tensor(34816,rows));g=ggml_new_graph(ctx);ggml_build_forward_expand(g,z);gs.push_back(g);
 auto*q=ggml_reshape_3d(ctx,tensor(256,24*rows),256,24,rows);
 auto*p=ggml_new_tensor_1d(ctx,GGML_TYPE_I32,rows);for(int i=0;i<rows;i++)((int*)p->data)[i]=i+3781;
 auto*r=ggml_rope(ctx,q,p,256,GGML_ROPE_TYPE_NEOX);g=ggml_new_graph(ctx);ggml_build_forward_expand(g,r);gs.push_back(g);
 }
 unsigned selected=0,large=0;double elapsed[2]={};
 for(auto*g:gs){auto*out=ggml_graph_node(g, ggml_graph_n_nodes(g)-1);std::vector<unsigned char> expected(ggml_nbytes(out));
 for(int enabled=0;enabled<2;enabled++){
 setenv("ENCLAVE_GGML_SMALL_GRAPH",enabled?"1":"0",1);auto plan=ggml_graph_plan(g,6,nullptr);std::vector<unsigned char> scratch(plan.work_size+64);plan.work_data=scratch.data();
 if(enabled){if(plan.n_threads==1)selected++;else large++;}
 assert(ggml_graph_compute(g,&plan)==GGML_STATUS_SUCCESS);
 if(!enabled)memcpy(expected.data(),out->data,expected.size());else assert(!memcmp(expected.data(),out->data,expected.size()));
 if(ggml_nelements(out)>49152)continue;
 auto start=std::chrono::steady_clock::now();for(int j=0;j<300;j++)assert(ggml_graph_compute(g,&plan)==GGML_STATUS_SUCCESS);
 elapsed[enabled]+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
 }
 }
 assert(selected>=6 && large>=3);printf("SMALL_GRAPH_PASS bit-identical selected=%u large=%u baseline_ms=%.3f optimized_ms=%.3f\n",selected,large,elapsed[0],elapsed[1]);ggml_free(ctx);
}
