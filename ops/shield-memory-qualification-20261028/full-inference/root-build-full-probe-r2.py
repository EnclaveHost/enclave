from pathlib import Path
import os,subprocess,shutil,hashlib,json
m=Path(__file__).resolve().parent
out=m/'full-probe-build-r2';out.mkdir(exist_ok=False)
pgi=Path('/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init')
base=pgi/'isolation/m4/evidence/shield-target25-2026-09-27/probe'
for n in ['Cargo.toml','Cargo.lock']:shutil.copy2(base/n,out/n)
shutil.copytree(base/'wit',out/'wit');(out/'src').mkdir()
shutil.copy2(m/'full-bench-prep/probe-bench/src/lib.rs',out/'src/lib.rs')
pins={'source_sha256':hashlib.sha256((out/'src/lib.rs').read_bytes()).hexdigest()}
(out/'SOURCE.json').write_text(json.dumps(pins,indent=2)+'\n')
env=dict(os.environ,CARGO_BUILD_JOBS='1',CARGO_NET_OFFLINE='true',CARGO_TARGET_DIR=str(out/'target'))
subprocess.run(['/home/steven/.cargo/bin/cargo','component','build','--release','--target','wasm32-wasip1'],cwd=out,env=env,check=True)
print('Public synthetic probe component compiled; no VM/GPU/network operation')
