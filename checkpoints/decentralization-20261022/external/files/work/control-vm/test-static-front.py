from pathlib import Path
import subprocess,json,hashlib,datetime
base=Path('work/control-vm');manifest=json.loads((base/'website-manifest.json').read_text());cid=manifest['cid'];checks=[]
def fetch(host,path,file):
 r=subprocess.run(['curl','--silent','--show-error','--fail','--max-time','30','--connect-to',host+':443:127.0.0.1:39343','https://'+host+path,'-o',str(file)],capture_output=True,text=True);assert r.returncode==0,r.stderr
for host,p,name,h in [('enclave.host','/index.html','site-index',manifest['fileManifest'][0]['sha256']),('ipfs.enclave.host','/ipfs/'+cid+'/index.html','ipfs-index',''),('ipfs.enclave.host','/ipfs/'+cid+'?format=car','site-car',manifest['carSHA256']),('ipfs.enclave.host','/ipfs/'+cid+'?format=raw','site-block',hashlib.sha256((base/'site-root.block').read_bytes()).hexdigest())]:
 out=base/('static-test-'+name);fetch(host,p,out)
 if 'index' in name:h=hashlib.sha256((base/'verified-site/index.html').read_bytes()).hexdigest()
 assert hashlib.sha256(out.read_bytes()).hexdigest()==h;checks.append({'host':host,'path':p,'verified':True,'bytes':out.stat().st_size})
artifact='bafybeihnfbvrrnuioglduqx6k4hniceutqthzg6aawnaeeyhds3vx2gl7q';out=base/'static-test-adapter';fetch('ipfs.enclave.host','/ipfs/'+artifact,out);assert hashlib.sha256(out.read_bytes()).hexdigest()=='3c76508c400cb7d2704a0ef897ff02ab88f1d4d6121add249979da8867457466';checks.append({'bootstrapArtifact':True,'bytes':out.stat().st_size})
out=base/'static-test-health';fetch('ipfs.enclave.host','/healthz',out);assert json.loads(out.read_text())['ok'];checks.append({'adapterHealthProxy':True})
# A new object absent from the static snapshot must fall through to the live adapter.
recent='bafkreiffwehkbav4d35obhyev6lf4a52wmdn2r4maje7lxkia6xdrognhy';out=base/'static-test-recent';fetch('ipfs.enclave.host','/ipfs/'+recent,out);assert out.stat().st_size==146;checks.append({'recentAdapterFallback':True,'bytes':146})
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'region':'us-west','normalTLSVerification':True,'productionTrafficChanged':False,'checks':checks};Path('outputs/static-front-isolated-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
