"""Reconstruct the pinned source-only candidate in a NEW directory; no build/run."""
from pathlib import Path
import io,tarfile,subprocess,shutil,sys,json
here=Path(__file__).resolve().parent
if len(sys.argv)!=2:raise SystemExit('usage: materialize.py NEW_DIRECTORY')
dest=Path(sys.argv[1]).resolve()
if dest.exists():raise SystemExit('Refusing existing destination')
base=json.loads((here/'PADGOV-BASELINE.json').read_text())['commit']
root=Path(subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=here,text=True).strip())
raw=subprocess.check_output(['git','archive',base,'wasm/ggml-shielded','shielded'],cwd=root)
dest.mkdir(parents=True)
with tarfile.open(fileobj=io.BytesIO(raw)) as tar:tar.extractall(dest,filter='data')
subprocess.run(['git','apply','--check',str(here/'packed24.patch')],cwd=dest,check=True)
subprocess.run(['git','apply',str(here/'packed24.patch')],cwd=dest,check=True)
for f in (here/'new').iterdir():shutil.copy2(f,dest/'wasm/ggml-shielded'/f.name)
print(dest)
