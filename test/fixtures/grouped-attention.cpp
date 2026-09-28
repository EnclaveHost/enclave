// Complete KQ -> softmax -> V attention, including the GQA broadcast.
// Compare every output byte across modes; timings alone are not acceptance.
#include "ggml.h"
#include "ggml-cpu.h"
#include <vector>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cmath>
int main(int argc,char**argv){
 int nk=argc>1?atoi(argv[1]):4096,nt=argc>2?atoi(argv[2]):2,nth=argc>3?atoi(argv[3]):6;
 int layers=16, loops=10, D=256,H=24,HK=4;
 auto*ctx=ggml_init({size_t(1)<<30,nullptr,false});
 std::vector<ggml_cgraph*> gs;
 for(int l=0;l<layers;l++){
 auto*q=ggml_new_tensor_3d(ctx,GGML_TYPE_F32,D,H,nt);
 auto*k=ggml_new_tensor_3d(ctx,GGML_TYPE_F16,D,HK,nk);
 auto*v=ggml_new_tensor_3d(ctx,GGML_TYPE_F16,nk,D,HK);
 auto*m=ggml_new_tensor_2d(ctx,GGML_TYPE_F32,nk,nt);
 for(int i=0;i<ggml_nelements(q);i++)((float*)q->data)[i]=sin(i*.03)*.2;
 for(int i=0;i<ggml_nelements(k);i++)((ggml_fp16_t*)k->data)[i]=ggml_fp32_to_fp16(sin(i*.07)*.2);
 for(int i=0;i<ggml_nelements(v);i++)((ggml_fp16_t*)v->data)[i]=ggml_fp32_to_fp16(sin(i*.13)*.2);
 for(int i=0;i<ggml_nelements(m);i++)((float*)m->data)[i]=0;
 auto*kq=ggml_mul_mat(ctx,ggml_permute(ctx,k,0,2,1,3),ggml_permute(ctx,q,0,2,1,3));ggml_mul_mat_set_prec(kq,GGML_PREC_F32);
 auto*sm=ggml_soft_max_ext(ctx,kq,m,1.0f/sqrtf(D),0);
 auto*out=ggml_mul_mat(ctx,v,sm);auto*g=ggml_new_graph(ctx);ggml_build_forward_expand(g,out);gs.push_back(g);
 }
 auto backend=ggml_backend_cpu_init();ggml_backend_cpu_set_n_threads(backend,nth);
 for(auto*g:gs)ggml_backend_graph_compute(backend,g);
 auto t=std::chrono::steady_clock::now();for(int i=0;i<loops;i++)for(auto*g:gs)ggml_backend_graph_compute(backend,g);
 double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count()/loops;
 printf("kv=%d tokens=%d threads=%d 16_layers_ms=%.3f\n",nk,nt,nth,ms);if(argc>4){auto*f=fopen(argv[4],"wb");for(auto*g:gs){auto*o=ggml_graph_node(g,ggml_graph_n_nodes(g)-1);fwrite(o->data,1,ggml_nbytes(o),f);}fclose(f);}ggml_backend_free(backend);ggml_free(ctx);
}
