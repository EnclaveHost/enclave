from pathlib import Path
import subprocess,json,sys
b=Path('work/logo-site-hotfix/final');m=json.loads((b/'manifest.json').read_text());cid=m['cid']
remote=r'''
from pathlib import Path
import json,hashlib,subprocess,os,shutil,time
root=Path('/opt/enclave-site')/CID;m=json.loads((root/'manifest.json').read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert m['cid']==CID and sha(root/'site.car')==m['carSHA256']
for x in m['fileManifest']:assert sha(root/'site'/x['path'])==x['sha256'],x['path']
p=Path('/etc/enclave-bootstrap-tls/Caddyfile');s=p.read_text();a=s.index('\nenclave.host {');z=s.index('\nwww.enclave.host {',a);block=s[a:z];old=m['sourceProduction']
assert block.count('root * '+old+'\n')==2
for x in m['sourceManifest']:assert sha(Path(old)/x['path'])==x['sha256'],'production diverged:'+x['path']
block=block.replace('root * '+old+'\n','root * '+str(root/'site')+'\n')
if '@siteEntry' not in block:block=block.replace('    encode zstd gzip\n','    encode zstd gzip\n    @siteEntry path /js/boot.js\n    header @siteEntry Cache-Control "no-cache"\n')
s=s[:a]+block+s[z:]
# Publish a new immutable root alongside old roots; never remap an old CID.
route="""
    @logoSiteV2Car {
        path /ipfs/CID
        query format=car
    }
    handle @logoSiteV2Car {
        root * ROOT
        rewrite * /site.car
        header Content-Type application/vnd.ipld.car
        file_server
    }
    @logoSiteV2Raw {
        path /ipfs/CID
        query format=raw
    }
    handle @logoSiteV2Raw {
        root * ROOT
        rewrite * /site-root.block
        header Content-Type application/vnd.ipld.raw
        file_server
    }
    @logoSiteV2Accept {
        path /ipfs/CID
        header Accept *application/vnd.ipld.car*
    }
    handle @logoSiteV2Accept {
        root * ROOT
        rewrite * /site.car
        header Content-Type application/vnd.ipld.car
        file_server
    }
    handle_path /ipfs/CID/* {
        root * ROOT/site
        file_server
    }
    handle /ipfs/CID {
        redir /ipfs/CID/ permanent
    }
""".replace('CID',CID).replace('ROOT',str(root))
pos=s.index('    @pin0car',s.index('\nipfs.enclave.host {'));s=s[:pos]+route+s[pos:]
candidate=p.with_name('Caddyfile.logo-cache-prepared');candidate.write_text(s)
env=dict(os.environ,CREDENTIALS_DIRECTORY='/etc/enclave-bootstrap-tls/credentials')
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True,text=True,env=env);assert r.returncode==0,r.stderr[-1500:]
backup=p.with_name('Caddyfile.before-logo-cache-'+str(int(time.time())));shutil.copy2(p,backup)
try:
 shutil.copy2(candidate,p);subprocess.run(['systemctl','reload','enclave-bootstrap-tls'],check=True,capture_output=True)
 def get(host,suffix):
  r=subprocess.run(['curl','-fsS','--max-time','20','--resolve',host+':28443:127.0.0.1','https://'+host+':28443'+suffix],capture_output=True);assert r.returncode==0,(host,suffix);return r.stdout
 assert get('enclave.host','/dashboard')==(root/'site/dashboard.html').read_bytes()
 assert get('enclave.host','/js/boot.js')==(root/'site/js/boot.js').read_bytes()
 assert get('ipfs.enclave.host','/ipfs/'+CID+'?format=raw')==(root/'site-root.block').read_bytes()
 build=json.loads((root/'build.json').read_text())
 for x in build['newOutputs']:
  if x['path'].endswith('.js'):assert hashlib.sha256(get('enclave.host','/'+x['path'])).hexdigest()==x['sha256']
except BaseException:
 shutil.copy2(backup,p);subprocess.run(['systemctl','reload','enclave-bootstrap-tls'],capture_output=True);raise
print(json.dumps({'cid':CID,'activated':True,'allNewModulesServed':True,'oldSourceMatched':True,'backup':str(backup)}))
'''
for host in sys.argv[1:]:
 assert host in ['us-west','eu-central','ap-southeast','ca-east']
 target='/opt/enclave-site/'+cid
 subprocess.run(['ssh','-o','BatchMode=yes',host,'test ! -e '+target+' && install -d -m 0755 '+target],check=True)
 with (b/'package.tar.gz').open('rb') as f:subprocess.run(['ssh','-o','BatchMode=yes',host,'tar -C '+target+' -xzf - --no-same-owner'],stdin=f,check=True)
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3','-'],input='CID='+repr(cid)+'\n'+remote,capture_output=True,text=True)
 if r.returncode:raise RuntimeError(host+': '+r.stderr[-1800:])
 entry={'region':host,**json.loads(r.stdout)};print(json.dumps(entry),flush=True)
 p=Path('outputs/logo-cache-repair-final.json');out=json.loads(p.read_text()) if p.exists() else {'sourceCommit':'7b89d6b2','cid':cid,'replicas':[]};out['replicas'].append(entry);p.write_text(json.dumps(out,indent=2)+'\n')
