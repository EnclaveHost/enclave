import subprocess,tarfile,io,yaml,json
from pathlib import Path
root=Path('/home/storageadmin/migration')
r=subprocess.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(root/'backup.pass'),'--decrypt',str(root/'indexd-full-20261019.tar.gpg')],capture_output=True,check=True)
with tarfile.open(fileobj=io.BytesIO(r.stdout)) as t:
 cfg=yaml.safe_load(t.extractfile('indexd.yml'))
print(json.dumps({'topLevelFields':list(cfg),'directory':cfg.get('directory'),'syncer':cfg.get('syncer'),'explorer':cfg.get('explorer'),'adminAddress':cfg.get('adminAPI',{}).get('address'),'applicationAddress':cfg.get('applicationAPI',{}).get('address'),'advertiseURL':cfg.get('applicationAPI',{}).get('advertiseURL'),'geoIPPath':cfg.get('geoIPPath')}))
