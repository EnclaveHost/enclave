#!/usr/bin/env python3
"""Build offline codecs plus a source-derived radix-256 refill variant.

Only the scratch copy's epilogue and symbol namespace change; runtime untouched.
The caller admits K <= 65536: 65536*255*119 < INT32_MAX per byte-plane dot.
"""
import argparse,subprocess,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--sanitize',action='store_true')
p.add_argument('--rows',type=int,default=4);p.add_argument('--cols',type=int,default=6);p.add_argument('--tiles',type=int,default=2);p.add_argument('--slab',type=int,default=2048);p.add_argument('--onednn-root',type=Path);a=p.parse_args()
assert a.rows in [2,3,4,6,8] and a.cols in [2,3,4,6,8] and 1<=a.tiles<=8 and a.slab in [512,1024,2048,4096]
root=Path(__file__).resolve().parents[2];src=root/'wasm/ggml-shielded';a.output.mkdir(parents=True,exist_ok=True)
subprocess.run(['python3',str(root/'shielded/bench/build-streamed-refill.py'),str(a.output),*(['--sanitize'] if a.sanitize else [])],check=True)
code=(src/'shielded-simd.c').read_text().replace('sh_simd_avx512_','sh_simd_radix_')
code=code.replace('ROWS = 4, COLS = 6, TILES = 2',f'ROWS = {a.rows}, COLS = {a.cols}, TILES = {a.tiles}')
code=code.replace('#define SH_BLK_K 2048',f'#define SH_BLK_K {a.slab}')
start=code.index('static inline int32_t crt_balanced(');end=code.index('\n}',start)+2
code=code[:start]+'''static inline int32_t crt_balanced(int32_t a0,int32_t a1,int32_t a2) {
    int64_t x=(int64_t)a0+256*(int64_t)a1+65536*(int64_t)a2;
    int64_t r=x%SH_M_MOD;
    r+=(r<0)*SH_M_MOD;
    return (int32_t)(r-(r>SH_HALF_M)*SH_M_MOD);
}'''+code[end:]
(a.output/'radix.c').write_text(code)
flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer'] if a.sanitize else ['-O3']
flags+=['-ffp-contract=off','-ffunction-sections','-fdata-sections']
simd=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni']
subprocess.run(['cc',*flags,*simd,'-DSH_SIMD_AVX512','-I'+str(src),'-c',str(a.output/'radix.c'),'-o',str(a.output/'radix.o')],check=True)
gg=Path.home()/'Projects/llama.cpp/ggml/include';lib=Path.home()/'Projects/llamacpp-lib'
extra=[]
if a.onednn_root:extra=['-DCOMPACT_DNNL','-I'+str(a.onednn_root/'usr/include'),'-L'+str(a.onednn_root/'usr/lib'),'-Wl,-rpath,'+str(a.onednn_root/'usr/lib'),'-ldnnl']
subprocess.run(['c++',*flags,*simd,'-std=c++17','-I'+str(gg),str(root/'shielded/bench/compact-refill.cpp'),*[str(a.output/(s+'.o')) for s in ['radix','shielded-simd','shielded-field','tweetnacl']],*extra,'-L'+str(lib),'-lggml','-lggml-base','-lcrypto','-llz4','-lzstd','-pthread','-lm','-Wl,--gc-sections','-Wl,-rpath,'+str(lib),'-o',str(a.output/'compact')],check=True)
