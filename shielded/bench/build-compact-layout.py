#!/usr/bin/env python3
"""Build an OFFLINE compact-layout experiment; never modifies a runtime.

Accepts public GGUF tensors and deterministic synthetic masks only. Run with
explicit CPU/RAM limits. The generated provider deliberately accepts batch 64
only; it is not production-ready. Both candidates retain all exact field math.
"""
import argparse, re, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('output',type=Path)
p.add_argument('--onednn-root',type=Path,required=True)
p.add_argument('--ggml-include',type=Path,required=True)
p.add_argument('--ggml-lib',type=Path,required=True)
p.add_argument('--sanitize',action='store_true',help='build sanitizer fixtures, not timing evidence')
a=p.parse_args()
w=a.output.resolve();w.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[2];src=root/'wasm/ggml-shielded'
dn=a.onednn_root.resolve();gg=a.ggml_include.resolve();lib=a.ggml_lib.resolve()
def change(text, old, new):
 if text.count(old) != 1:
  raise ValueError('provider shape changed; review transformation: '+old[:80])
 return text.replace(old,new)
baseline='7728ee9ee' # Freeze the original experiment; runtime has since evolved.
def original(path):
 return subprocess.check_output(['git','show',baseline+':'+path],cwd=root,text=True)
code=original('wasm/ggml-shielded/shielded-compact.cpp')
candidate=change(code,'#include <vector>','#include <vector>\n#include <memory>\n#include <oneapi/dnnl/dnnl.hpp>')
kernel='''
static dnnl::engine eng(dnnl::engine::kind::cpu,0);
struct kernel {
 dnnl::memory::desc src,plain,packed,dst,workspace;
 dnnl::matmul op;
 kernel(int64_t k,int64_t n):
 src({192,k},dnnl::memory::data_type::u8,dnnl::memory::format_tag::ab),
 plain({k,n},dnnl::memory::data_type::s8,dnnl::memory::dims{1,k}),
 dst({192,n},dnnl::memory::data_type::s32,dnnl::memory::format_tag::ab) {
 dnnl::primitive_attr attr;attr.set_scratchpad_mode(dnnl::scratchpad_mode::user);
 dnnl::matmul::primitive_desc pd(eng,src,dnnl::memory::desc({k,n},dnnl::memory::data_type::s8,dnnl::memory::format_tag::any),dst,attr);
 packed=pd.weights_desc();workspace=pd.scratchpad_desc();op=dnnl::matmul(pd);
 require(workspace.get_size() <= (64U<<20),"workspace bound");
 }
 void reorder(const void* in,void*out,bool reverse)const{
  auto dims=plain.get_dims(), strides=packed.get_strides(), blks=packed.get_inner_blks(), idx=packed.get_inner_idxs();
  if(!reverse)memset(out,0,packed.get_size());
  for(int64_t n=0;n<dims[1];++n)for(int64_t k=0;k<dims[0];++k){
   int64_t p[2]={k,n},off=0,step=1;
   for(int j=(int)blks.size()-1;j>=0;--j){off+=(p[idx[j]]%blks[j])*step;p[idx[j]]/=blks[j];step*=blks[j];}
   off+=p[0]*strides[0]+p[1]*strides[1];
   if(reverse)((int8_t*)out)[n*dims[0]+k]=((const int8_t*)in)[off];
   else ((int8_t*)out)[off]=((const int8_t*)in)[n*dims[0]+k];
  }
 }
 void run(uint8_t*a,int8_t*b,int32_t*c,uint8_t*scratch)const{
  dnnl::stream stream(eng);dnnl::memory am(src,eng,a),bm(packed,eng,b),cm(dst,eng,c);
  dnnl::memory tmp(workspace,eng,scratch);
  op.execute(stream,{{DNNL_ARG_SRC,am},{DNNL_ARG_WEIGHTS,bm},{DNNL_ARG_DST,cm},{DNNL_ARG_SCRATCHPAD,tmp}});stream.wait();
 }
};
'''
candidate=change(candidate,'struct sh_compact_store {',kernel+'\nstruct sh_compact_store {\n  std::vector<std::shared_ptr<kernel>> kernels;')
candidate=change(candidate,'auto packed = pack_bits(w + j * K, n);','''auto kr = j == 0 || std::min(s->rows,N-j) != s->rows ? std::make_shared<kernel>(K,std::min(s->rows,N-j)) : s->kernels[0];
      std::vector<int8_t> reordered(kr->packed.get_size()),verify(reordered.size());
      kr->reorder(w+j*K,reordered.data(),false);
      auto packed = pack_bits(reordered.data(),reordered.size());
      require(unpack_bits(packed.data(),packed.size(),verify.data(),verify.size()) && verify == reordered,"packed admission");
      kr->reorder(verify.data(),check.data(),true);
      s->kernels.push_back(kr);''')
candidate=change(candidate,'unpack_bits(packed.data(), packed.size(), check.data(), n) &&','')
candidate=change(candidate,'require(unpack_bits(v.data(), v.size(), block.data(), len),\n              "private decode");','''std::vector<int8_t> tmp(s->kernels[ci]->packed.get_size());
      require(unpack_bits(v.data(),v.size(),tmp.data(),tmp.size()),"private decode");
      s->kernels[ci]->reorder(tmp.data(),block.data(),true);''')
candidate=change(candidate,'b < 1 || b > 64','b != 64')
candidate=change(candidate,'require(unpack_bits(v.data(), v.size(), block.data(), nr * s->K),','grow(block,s->kernels[ci]->packed.get_size());\n      require(unpack_bits(v.data(), v.size(), block.data(), s->kernels[ci]->packed.get_size()),')
start=candidate.index('      int32_t co = 0;')
end=candidate.index('      for (int i = 0; i < b; i++)',start)
candidate=change(candidate,'std::vector<uint8_t> planes;', 'std::vector<uint8_t> planes, workspace;')
candidate=change(candidate,'volatile uint8_t *p = planes.data();', 'volatile uint8_t *tmp = workspace.data();\n    for (size_t i=0;i<workspace.size();++i) tmp[i]=0;\n    volatile uint8_t *p = planes.data();')
# Recompute the replacement indices after adding the thread-private scratch.
start=candidate.index('      int32_t co = 0;')
end=candidate.index('      for (int i = 0; i < b; i++)',start)
candidate=candidate[:start]+'''      grow(scratch.workspace,s->kernels[ci]->workspace.get_size()+64);
      auto tmp=(uint8_t*)(((uintptr_t)scratch.workspace.data()+63)&~uintptr_t(63));
      s->kernels[ci]->run(planes.data(),block.data(),accum.data(),tmp);
'''+candidate[end:]

# Fail visibly if the production provider changes beneath this source-derived fixture.
assert 'b != 64' in candidate and 's->kernels[ci]->run' in candidate
assert 'dnnl_gemm_u8s8s32' not in candidate
flags=(['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer'] if a.sanitize else ['-O3'])
flags+=['-ffp-contract=off','-ffunction-sections','-fdata-sections']
simd=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni']
objs=[]
for name in ['shielded-simd','shielded-field','tweetnacl']:
 o=w/(name+'.o')
 subprocess.run(['cc',*flags,*simd,'-DSH_SIMD_AVX512','-c',str(src/(name+'.c')),'-o',str(o)],check=True);objs.append(str(o))
plain=change(candidate,'dnnl::memory::desc({k,n},dnnl::memory::data_type::s8,dnnl::memory::format_tag::any),dst','plain,dst')
assert plain != candidate
for name,body in [('base',code),('prepack',candidate),('primitive',plain)]:
 for symbol in ['kernel','compact_scratch','omp_one']:
  body=re.sub(r'\b'+symbol+r'\b',name+'_'+symbol,body)
 body=body.replace('sh_compact_',name+'_compact_')
 source=w/(name+'.cpp');source.write_text(body);o=w/(name+'.o')
 subprocess.run(['c++',*flags,*simd,'-std=c++20','-I'+str(src),'-I'+str(dn/'usr/include'),'-c',str(source),'-o',str(o)],check=True);objs.append(str(o))
subprocess.run(['c++',*flags,*simd,'-std=c++20','-I'+str(gg),str(root/'shielded/bench/compact-layout.cpp'),*objs,'-L'+str(dn/'usr/lib'),'-ldnnl','-lgomp','-Wl,-rpath,'+str(dn/'usr/lib'),'-L'+str(lib),'-lggml','-lggml-base','-lcrypto','-pthread','-lm','-Wl,--gc-sections','-Wl,-rpath,'+str(lib),'-o',str(w/'compact-layout')],check=True)
print(w/'compact-layout')
if a.sanitize:
 fixture=original('test/fixtures/shielded-compact-runtime.cpp')
 fixture=fixture.replace('#include "../../wasm/ggml-shielded/shielded-compact.cpp"','#include "prepack.cpp"')
 fixture=fixture.replace('sh_compact_','prepack_compact_').replace('{1,16,32,64}','{64}').replace('{64,16,32}','{64}')
 extra='''
  {
    // Share one immutable plan between workers; scratch must remain private.
    const int K=5120,N=385,b=64;std::vector<int8_t> weights(K*N,3);
    auto *shared=prepack_compact_create(weights.data(),K,N);assert(shared);
    std::vector<std::thread> parallel;
    for(int t=0;t<4;++t)parallel.emplace_back([&,t]{
      std::vector<int32_t> r(b*K,12345+t),u(b*N);
      for(int round=0;round<3;++round){
        assert(prepack_compact_refill(shared,r.data(),b,u.data(),N)==SH_OK);
        for(auto x:u)assert(x==sh_balanced((int64_t)K*3*(12345+t)));
      }
    });
    for(auto &thread:parallel)thread.join();
    std::vector<int32_t> r(b*K,0),u(b*N,123);
    for(int invalid:{-1,(int)SH_M_MOD}){
      r.back()=invalid;
      assert(prepack_compact_refill(shared,r.data(),b,u.data(),N)==SH_ERR_VERIFY);
      for(auto x:u)assert(x==0);
    }
    assert(prepack_compact_refill(shared,r.data(),16,u.data(),N)==SH_ERR_RANGE);
    prepack_compact_free(shared);
  }
'''
 fixture=fixture.replace('  int8_t bad=120;',extra+'  int8_t bad=120;')
 (w/'layout-check.cpp').write_text(fixture)
 subprocess.run(['c++',*flags,*simd,'-std=c++20','-pthread','-I'+str(src),'-I'+str(dn/'usr/include'),str(w/'layout-check.cpp'),str(w/'shielded-simd.o'),str(w/'shielded-field.o'),'-L'+str(dn/'usr/lib'),'-ldnnl','-lgomp','-Wl,-rpath,'+str(dn/'usr/lib'),'-o',str(w/'layout-check')],check=True)
 print(w/'layout-check')
