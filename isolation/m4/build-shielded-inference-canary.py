#!/usr/bin/env python3
"""Build a PUBLIC-FIXTURE inference canary, never a production app release.

Requires a GGML-only Wasmtime runtime tree (including backends and runtime.json),
a pinned base per-app template, the public Qwen model, and a fixed-token WASI
probe bundle. Diagnostic logging intentionally exposes the public fixture to
serial. Do not use this image with private prompts or change scheduler admission.
"""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--base-template', required=True, type=Path)
p.add_argument('--runtime', required=True, type=Path)
p.add_argument('--model', required=True, type=Path)
p.add_argument('--bundle', required=True, type=Path)
p.add_argument('--out', required=True, type=Path)
a = p.parse_args()
repo = Path(__file__).resolve().parents[2]
w = a.out.resolve()
if w.exists():
    p.error('output already exists')
if hashlib.file_digest(a.model.open('rb'), 'sha256').hexdigest() != 'f81d63cf49568f78154f6ddc8b114f603579360c7c878831a7f95a51dc284d24':
    p.error('wrong public model: expected Qwen2.5-0.5B-Instruct Q8_0')
for name in ('wasmtime', 'runtime.json', 'backends/libggml-shielded.so', 'backends/libggml-cpu.so'):
    if not (a.runtime/name).is_file(): p.error('missing runtime file: '+name)
for lib in a.runtime.rglob('*.so*'):
    stack = subprocess.check_output(['readelf', '-W', '-l', str(lib)], text=True)
    if any('GNU_STACK' in line and 'RWE' in line for line in stack.splitlines()):
        p.error('executable stack is prohibited: '+str(lib))
t=w/'template'
shutil.copytree(a.base_template,t)
shutil.rmtree(t/'rt')
shutil.copytree(a.runtime,t/'rt')
(t/'rt/calib').mkdir(exist_ok=True)
shutil.copy2(repo/'metal/shielded-overlay/calib/qwen2.5-0.5b-q8-gguf.calib',t/'rt/calib/model.calib')
(t/'models/model').mkdir(parents=True,exist_ok=True)
shutil.copy2(a.model,t/'models/model/model.gguf')
(t/'run').mkdir(exist_ok=True)
subprocess.run(['go','build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',str(t/'shieldbroker'),'./shieldbroker'],cwd=repo/'isolation/m2',env={**os.environ,'CGO_ENABLED':'0','GOFLAGS':''},check=True)
shutil.copy2(a.bundle,w/'app.bundle')
# Historical public diagnostic fixture, pinned before production inference init.
s=subprocess.check_output(['git','show','e424d1fab4c2:isolation/m2/dominit.c'],cwd=repo,text=True)
needle='    lo_up();\n';assert s.count(needle)==1
s=s.replace(needle,needle+'''    char *shield_argv[] = {"/shieldbroker", NULL};
    pid_t shield_pid = spawn(shield_argv, NULL, -1, 0);
    for (int i=0; access("/run/enclave-shield/gpu1", F_OK) != 0; i++) {
        if (i>1000 || shield_pid<0) { printf("DOM ERROR Shield broker not ready\\n"); reboot(RB_POWER_OFF); _exit(1); }
        usleep(10000);
    }
''')
env={
 'ENCLAVE_GGML_BACKEND_DIR':'/rt/backends','GGML_BACKEND_PATH':'/rt/backends/libggml-shielded.so',
 'SHIELDED_HOST':'unix:/run/enclave-shield/gpu0','SHIELDED_PORT':'9501',
 'SHIELDED_WORKERS':'unix:/run/enclave-shield/gpu0|9501|0|2147483648\nunix:/run/enclave-shield/gpu1|9502|0|2147483648',
 'SHIELDED_CALIB':'/rt/calib/model.calib','ENCLAVE_GGML_EXTRA_BUFTS':'0',
 'ENCLAVE_GGML_N_CTX':'512','ENCLAVE_GGML_N_BATCH':'16','ENCLAVE_GGML_N_UBATCH':'16',
 'SHIELDED_REFILL_THREADS':'2','SHIELDED_POOL_DEPTH':'8','OMP_NUM_THREADS':'2',
 'SHIELDED_VERBOSE':'1','SHIELDED_PROFILE':'1','WASMTIME_LOG':'wasmtime_wasi_nn=debug',
}
needle='        char *envp[] = {"HOME=/tmp", "PATH=/rt", extra, NULL};'
assert needle in s
vals=', '.join(json.dumps(k+'='+v) for k,v in env.items())
s=s.replace(needle,'        char *envp[] = {"HOME=/tmp", "PATH=/rt", '+vals+', extra, NULL};')
s=s.replace('char **base = port ? run : serve, *app[48];','char **base = port ? run : serve, *app[64];')
needle='        app[k++] = base[i];'
assert s.count(needle)==1
s=s.replace(needle,'''        if (strcmp(base[i], "/app.wasm") == 0) {
            app[k++]="-S"; app[k++]="nn";
            app[k++]="-S"; app[k++]="nn-graph=ggml::/models/model";
        }
'''+needle)
# LAB ONLY: this fixture takes a public fixed token sequence. Collect counters
# for this hardware experiment. Never use this diagnostic image for user data.
s=s.replace('SPAWN_QUIET | SPAWN_DROP | SPAWN_FILTER','SPAWN_DROP | SPAWN_FILTER')
s=s.replace('if (w == app_pid || w == front_pid)', 'if (w == app_pid || w == front_pid || w == shield_pid)')
(w/'prototype-init.c').write_text(s)
musl = Path(os.environ.get('MUSL_PREFIX', str(Path.home()/'.cache/enclave-isolation/musl-1.2.6')))
clean_env = {k:v for k,v in os.environ.items() if k not in ('CPATH','C_INCLUDE_PATH','LIBRARY_PATH','GCC_EXEC_PREFIX','COMPILER_PATH')}
subprocess.run(['/usr/bin/gcc','-specs',str(musl/'lib/musl-gcc.specs'),'-static','-O2','-I',str(repo/'isolation/m2'),'-o',str(t/'init'),str(w/'prototype-init.c')],env=clean_env,check=True)
subprocess.run(['sh',str(repo/'isolation/m4/assemble-app-image.sh'),str(t),str(w/'app.bundle'),str(w/'inference.cpio.gz')],check=True)
hashes = {str(f.relative_to(t)): hashlib.file_digest(f.open('rb'),'sha256').hexdigest() for f in sorted(t.rglob('*')) if f.is_file()}
(w/'inputs.sha256.json').write_text(json.dumps(hashes,indent=2)+'\n')
print('Built public-fixture inference canary. Not a production release; use 4 vCPUs and 8192 MiB.')
