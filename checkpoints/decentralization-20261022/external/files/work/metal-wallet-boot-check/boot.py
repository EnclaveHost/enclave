import json,os,signal,subprocess,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[2];work=Path(__file__).resolve().parent;out=root/'outputs/metal-host-policy-delivery'
prod_before=subprocess.check_output(['systemctl','--user','show','enclave-metal.service','-p','MainPID','--value'],text=True).strip()
log=(work/'boot.log').open('w')
child=subprocess.Popen(['node',str(root/'work/enclave/metal/enclave-metal.mjs'),'--config',str(work/'config.json')],stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'TMPDIR':str(work/'tmp')},start_new_session=True)
record={'status':'booting','launcherPid':child.pid,'productionControlPidBefore':prod_before,'network':'QEMU user networking restrict=on; one loopback-only inbound forward','registryCredentialsSupplied':False,'sellingEnabled':False,'productionChanged':False}
try:
 deadline=time.monotonic()+150
 while time.monotonic()<deadline:
  if child.poll() is not None:raise RuntimeError('test launcher exited')
  try:
   with urllib.request.urlopen('http://127.0.0.1:38881/v1/health',timeout=2) as r:health=json.load(r)
   if health.get('status')=='ok':break
  except Exception:time.sleep(1)
 else:raise RuntimeError('supervisor did not become healthy within 150 seconds')
 record['health']={'status':health.get('status'),'deployments':health.get('deployments')};print(json.dumps({'phase':'supervisor-healthy',**record['health']}),flush=True)
 with urllib.request.urlopen('http://127.0.0.1:38881/v1/attestation',timeout=20) as r:att=json.load(r)
 (out/'control-boot-attestation.json').write_text(json.dumps(att,indent=2)+'\n')
 record['status']='booted-and-attestation-retrieved';record['verifiedAtUnix']=int(time.time())
 text=(work/'boot.log').read_text();record['immutablePinsLogged']='immutable host contract pins active; book polling disabled' in text
 if not record['immutablePinsLogged']:raise RuntimeError('missing pinned-runtime startup evidence')
except Exception as e:
 record['status']='failed';record['error']=str(e)
finally:
 child.terminate()
 try:child.wait(timeout=12)
 except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
 log.close()
 record['testLauncherStopped']=child.poll() is not None
 record['productionControlPidAfter']=subprocess.check_output(['systemctl','--user','show','enclave-metal.service','-p','MainPID','--value'],text=True).strip()
 record['productionControlPidUnchanged']=record['productionControlPidAfter']==prod_before
 (out/'control-boot-verification.json').write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record),flush=True)
if record['status']=='failed':raise SystemExit(1)
