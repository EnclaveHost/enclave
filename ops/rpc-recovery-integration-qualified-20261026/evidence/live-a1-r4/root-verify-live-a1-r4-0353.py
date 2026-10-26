from pathlib import Path
import json,datetime,hashlib,importlib.util,sys,subprocess,os
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
o=p.parent.parent/'outputs/rpc-production-final-20261025'
s=p/'a1-capture-binding-stage/r4';source=s/'src/a1_capture.py'
assert os.geteuid()==0
assert (p/'logs/root-a1-capture-r4-0313.rc').read_text().strip()=='0'
assert hashlib.sha256(source.read_bytes()).hexdigest()=='db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20'
subprocess.run(['sha256sum','-c','--quiet','SHA256SUMS'],cwd=s,check=True)
d=o/'a1-live-verify-r4-0353';d.mkdir(mode=0o700)
spec=importlib.util.spec_from_file_location('capture_r4_verify',source);c=importlib.util.module_from_spec(spec);sys.modules[spec.name]=c;spec.loader.exec_module(c)
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'Offline verification of unmodified live0252capture by testedr4; no newcapture, no chainrefresh, noSNP, usernamespace','productionActivated':False}
try:
 r['verification']=c.verify(o/'a1-capture-live-0252/initial',node='/usr/bin/node',workdir=str(d));r['ok']=True
except Exception as e:r.update(ok=False,error=type(e).__name__+': '+str(e))
(d/'result.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2));sys.exit(0 if r['ok'] else 1)
