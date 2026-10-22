from pathlib import Path
import subprocess,hashlib,json
folder='/root/enclave-local-relay-migration-tools-20261021'
archive=Path('work/windows-local-relay-root-activation/source-tools.tar')
expected=hashlib.sha256(archive.read_bytes()).hexdigest()
r=subprocess.run(['ssh','-o','BatchMode=yes','us-west','test ! -e '+folder+' && mkdir -m 0700 '+folder],check=True)
subprocess.run(['scp','-q',str(archive),'us-west:'+folder+'/source-tools.tar'],check=True)
manifest=json.loads(Path('work/windows-local-relay-root-activation/source-tools-sha.json').read_text())
script='set -euo pipefail\ncd '+folder+'\n'+'test "$(sha256sum source-tools.tar | cut -c1-64)" = '+expected+'\ntar --no-same-owner -xf source-tools.tar\n'
for name,digest in manifest.items():script+='test "$(sha256sum '+name+' | cut -c1-64)" = '+digest+'\n'
script+='chmod 0600 ./*\necho "Source stop/restore scripts and migration gate staged intact; no service changed"\n'
subprocess.run(['ssh','-o','BatchMode=yes','us-west','bash','-s'],input=script.encode(),check=True)
