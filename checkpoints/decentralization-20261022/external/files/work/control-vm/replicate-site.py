from pathlib import Path
import subprocess,tarfile,json,datetime
base=Path('work/control-vm');m=json.loads((base/'website-manifest.json').read_text());cid=m['cid'];archive=base/'site-package.tar.gz'
with tarfile.open(archive,'w:gz',compresslevel=3) as t:
 t.add(base/'verified-site',arcname='site');t.add(base/'website.car',arcname='site.car');t.add(base/'website-manifest.json',arcname='manifest.json')
script='''from pathlib import Path
import json,hashlib,sys
p=Path('/opt/enclave-site')/sys.argv[1];m=json.loads((p/'manifest.json').read_text());assert m['cid']==sys.argv[1]
assert hashlib.sha256((p/'site.car').read_bytes()).hexdigest()==m['carSHA256']
for x in m['fileManifest']:
 f=p/'site'/x['path'];assert f.is_file() and not f.is_symlink() and f.stat().st_size==x['bytes'];assert hashlib.sha256(f.read_bytes()).hexdigest()==x['sha256']
print(json.dumps({'files':len(m['fileManifest']),'carSHA256':m['carSHA256'],'verified':True}))
'''
report={'cid':cid,'replicas':[],'servedYet':False}
for host in ['us-west','eu-central','ap-southeast','ca-east']:
 remote='/opt/enclave-site/'+cid
 subprocess.run(['ssh','-o','BatchMode=yes',host,'test ! -e '+remote+' && install -d -m 0755 '+remote],check=True)
 with archive.open('rb') as f:subprocess.run(['ssh','-o','BatchMode=yes',host,'tar -C '+remote+' -xzf - --no-same-owner'],stdin=f,check=True,stdout=subprocess.DEVNULL)
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3','-',cid],input=script,capture_output=True,text=True,check=True);d=json.loads(r.stdout);report['replicas'].append({'region':host,**d});print(host+': all '+str(d['files'])+' website files and CAR verified',flush=True)
 Path('outputs/website-recovery-replicas.json').write_text(json.dumps(report,indent=2)+'\n')
report['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();Path('outputs/website-recovery-replicas.json').write_text(json.dumps(report,indent=2)+'\n')
