"""Build a copied backend in isolation; never install or execute its output."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

t = Path(__file__).resolve().parent
b = t / 'backend-rebuild-r1'
b.mkdir(exist_ok=False)
src = Path('/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov/wasm/ggml-shielded')
copied = b / 'src'
copied.mkdir()
hashes = {}
for p in sorted(src.iterdir()):
    if p.is_file() and (p.suffix in {'.c', '.cpp', '.h', '.hpp', '.inc'} or p.name == 'Makefile'):
        shutil.copyfile(p, copied / p.name)
        hashes[p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
engine = Path('/home/steven/enclave-bench/shield-original-reclaim-20260929/build')
compact = Path('/home/steven/enclave-bench/shield-compact-production-20260930/onednn-wx/install')
argv = ['make', '-C', str(copied), '-j1', 'libggml-shielded.so',
        'GGML_SRC=' + str(engine / 'engine-src'), 'GGML_LIB=' + str(engine / 'engine-build/bin'),
        'SHIELDED_COMPACT_ROOT=' + str(compact),
        'CXXFLAGS=-O2 -std=c++17 -Wall -Wextra -fPIC -fno-math-errno -DGGML_MAX_NAME=128']
record = {'sourceHashes': hashes, 'argv': argv, 'sourceRevision': subprocess.check_output(['git', '-C', str(src), 'rev-parse', 'HEAD'], text=True).strip()}
(b / 'INPUT.json').write_text(json.dumps(record, indent=2) + '\n')
with (b / 'build.log').open('x') as log:
    r = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=300)
record['exitCode'] = r.returncode
if r.returncode == 0:
    output = copied / 'libggml-shielded.so'
    installed = Path('/home/steven/enclave-prod/release-af50d526/template/rt/backends/libggml-shielded.so')
    record['builtSha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
    record['installedSha256'] = hashlib.sha256(installed.read_bytes()).hexdigest()
    record['byteIdentical'] = output.read_bytes() == installed.read_bytes()
(b / 'RESULT.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({k: v for k, v in record.items() if k not in {'sourceHashes', 'argv'}}))
raise SystemExit(r.returncode)
