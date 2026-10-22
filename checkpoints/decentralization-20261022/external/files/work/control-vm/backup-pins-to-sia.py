from pathlib import Path
import subprocess
script='''from pathlib import Path
import json,shlex,subprocess
root=Path('/var/lib/indexd-migration/public-pins-20261019');rows=json.loads((root/'manifest.json').read_text());assert len(rows)==181
manifest=[{'key':'nan-retirement/20261019/'+r['cid']+'.car','size':r['carBytes'],'url':'http://127.0.0.1:28081/'+r['cid']+'.car'} for r in rows]
work=Path('/var/lib/indexd-migration/sia-pin-backup');work.mkdir(mode=0o700,exist_ok=True);(work/'ipfs.manifest.json').write_text(json.dumps(manifest))
caddy=work/'Caddyfile';caddy.write_text('{\\n admin off\\n auto_https off\\n}\\nhttp://127.0.0.1:28081 {\\n root * '+str(root)+'\\n file_server\\n}\\n')
r=subprocess.run(['caddy','validate','--config',str(caddy),'--adapter','caddyfile'],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:]
subprocess.run(['systemd-run','--unit=enclave-sia-pin-export','--property=MemoryMax=128M','--property=ProtectSystem=strict','/usr/bin/caddy','run','--config',str(caddy),'--adapter','caddyfile'],check=True,capture_output=True)
wrapper='''+repr('''from pathlib import Path
import os,json,shlex
config=next(t.split('=',1)[1] for t in shlex.split(Path('/opt/sia-import-r2/run-ipfs.sh').read_text(),comments=True) if t.startswith('ENCLAVE_CONFIG='));x=json.loads(config);x['indexer']='https://sia.enclave.host'
os.environ['SIA_APP_KEY']=Path('/etc/indexd/apps/sia-s3.seed').read_text().strip();os.environ['ENCLAVE_CONFIG']=json.dumps(x);os.environ['IMPORT_VERBOSE']='0'
os.execv('/opt/sia-import/wasmtime',['wasmtime','run','-S','inherit-network','-S','allow-ip-name-lookup','--env','SIA_APP_KEY','--env','ENCLAVE_CONFIG','--env','IMPORT_VERBOSE','--dir','/var/lib/indexd-migration/sia-pin-backup::/run','/opt/sia-import-r2/sia-s3.wasm','import','ipfs','/run/ipfs.manifest.json'])
''')+'''
(work/'import.py').write_text(wrapper);(work/'import.py').chmod(0o700)
subprocess.run(['systemd-run','--unit=enclave-sia-pin-backup','--property=MemoryMax=1536M','--property=NoNewPrivileges=yes','/usr/bin/python3',str(work/'import.py')],check=True,capture_output=True)
print(json.dumps({'immutablePublicCARs':len(rows),'bytes':sum(r['carBytes'] for r in rows),'destination':'live Sia service on minipc','importStarted':True,'verifiedReadback':False}))
'''
r=subprocess.run(['ssh','nan','python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-2000:];print(r.stdout)
