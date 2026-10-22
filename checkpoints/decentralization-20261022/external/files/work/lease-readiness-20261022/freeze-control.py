from pathlib import Path
import hashlib,json
r=Path(__file__).resolve().parent;root=r/'tree';manifest=json.loads((r/'control-closure.json').read_text())
# Detach symlinked ancestors before writing; shared reference trees must never be changed.
for rec in manifest['files']:
 p=root/rec['name']; data=p.read_bytes()
 for parent in list(p.relative_to(root).parents)[::-1]:
  d=root/parent
  if d.is_symlink():
   target=d.resolve();d.unlink();d.mkdir()
   for child in target.iterdir():(d/child.name).symlink_to(child,target_is_directory=child.is_dir())
 if p.is_symlink():p.unlink();p.write_bytes(data)
 # Helpers were deliberately updated after the initial closure: record the current bytes, not obsolete hashes.
 rec['sha256']=hashlib.sha256(data).hexdigest();rec['changed']=rec['sha256']!=rec['recordedLiveSha256']
 assert not p.is_symlink()
(r/'frozen-control.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'regularSourceFiles':len(manifest['files']),'hostServiceHelpers':{x['name']:x['sha256'] for x in manifest['files'] if x['name'] in ['network/host-service-names.mjs','network/host-service-transport.mjs']}}))
