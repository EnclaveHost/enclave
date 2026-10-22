from pathlib import Path
import json
rows=json.loads(Path('/var/lib/enclave-migration/control-code-manifest.json').read_text());count=0
for row in rows:
 if row['kind']=='directory' and any(row['path']==p or row['path'].startswith(p+'/') for p in ['opt/enclave-predict','opt/nan-relay','opt/enclave-dns']):
  p=Path('/')/row['path'];assert p.is_dir() and not p.is_symlink();p.chmod(row['mode']);count+=1
print('Restored original modes on',count,'completed code directories; other paths unchanged.')
