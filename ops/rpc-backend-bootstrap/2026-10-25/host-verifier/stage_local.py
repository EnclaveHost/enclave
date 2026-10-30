from pathlib import Path
import hashlib,json,shutil
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
manifest=json.loads((p/'host-verifier-package/a/manifest.json').read_text())
dest=Path('/home/steven/enclave-prod/rpc-host-verifier-'+manifest['artifact']['sha256'][:8])
if dest.exists(): raise SystemExit('destination exists; inspect instead of replacing')
binroot=p.parent/'resume-after-checkpoint-20261022/rpc-runtime-final-integration/bin-release'
files={'listener':binroot/'enclave-base-head-listener','helios':binroot/'helios-eeffcc9','witnessCheck':binroot/'witness-check'}
def sha(f):
 h=hashlib.sha256()
 with f.open('rb') as s:
  for chunk in iter(lambda:s.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
for role,f in files.items():
 assert sha(f)==manifest['binaryPins'][role]['sha256'],role
assert sha(p/'host-verifier-package/a/rpc-runtime.mjs')==manifest['artifact']['sha256']
dest.mkdir(mode=0o755);(dest/'bin').mkdir()
for name in ['rpc-runtime.mjs','manifest.json']:shutil.copyfile(p/'host-verifier-package/a'/name,dest/name);(dest/name).chmod(0o444)
cfg=json.loads((p/'route-stage/examples/host-rpc-runtime.metal0.json').read_text());cfg.pop('_note')
for role,f in files.items():
 target=dest/'bin'/f.name;shutil.copyfile(f,target);target.chmod(0o555)
 assert sha(target)==manifest['binaryPins'][role]['sha256']
 cfg['binaries'][role]['path']=str(target)
cfg['stateDir']='/home/steven/.local/state/enclave-rpc-host-verifier'
(dest/'config.json').write_text(json.dumps(cfg,indent=2)+'\n');(dest/'config.json').chmod(0o444)
recipe=Path(__file__).resolve().parent
shutil.copyfile(recipe/'preflight.py',dest/'preflight.py');(dest/'preflight.py').chmod(0o444)
unit=(recipe/'enclave-rpc-host-verifier.service.in').read_text().replace('@STAGE@',str(dest)).replace('@STATE@',cfg['stateDir'])
(p/'host-verifier-package/enclave-rpc-host-verifier.service').write_text(unit)
out=p/'host-verifier-package/staged.json'
out.write_text(json.dumps({'directory':str(dest),'artifact':manifest['artifact'],'configSha256':sha(dest/'config.json'),'stateDir':cfg['stateDir'],'activated':False,'newWitnessCacheBytes':0},indent=2)+'\n')
print(out.read_text())
