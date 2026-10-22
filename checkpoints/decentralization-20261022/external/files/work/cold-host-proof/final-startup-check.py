import pathlib,subprocess,os,sys,tempfile,json,datetime
root=pathlib.Path(__file__).resolve().parent
repo=root.parent/'enclave'
hidden=['/boot','/lib/modules',str(root.parent/'direct-bootstrap-hardware-release-v3'),str(root.parent/'bootstrap-hardware/guests/store')]
if '--inner' in sys.argv:
 with tempfile.TemporaryDirectory(prefix='cold-host-final-') as empty:
  subprocess.run(['mount','--make-rprivate','/'],check=True)
  for target in hidden:subprocess.run(['mount','--bind',empty,target],check=True)
  masked=pathlib.Path(empty)/'not-executable';masked.write_text('host wasmtime unavailable\n');masked.chmod(0o600)
  wt=pathlib.Path('/usr/sbin/wasmtime').resolve()
  subprocess.run(['mount','--bind',str(masked),str(wt)],check=True)
  env=dict(os.environ,GUESTD_ENABLE='1')
  args=[str(root/'guestd-final'),'-isolation',str(repo/'isolation'),'-root',str(root/'final-startup-empty-root'),'-cpu-release',str(root/'release'),'-isolation-release','5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad','-gateway','["http://127.0.0.1:1","http://134.209.248.172:8189","http://165.245.191.129:8189"]','-instance-prefix','ch','-release','-direct-bootstrap','-adopt-check']
  r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=120)
  (root/'final-startup.log').write_text(r.stdout+r.stderr)
  if r.returncode:raise RuntimeError(r.stderr)
  assert not os.access(wt,os.X_OK)
  proof={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'mode':'adopt-check on a new empty guest root','hiddenDirectories':hidden,'hostWasmtimeUnavailable':True,'defaultRoutes':pathlib.Path('/proc/net/route').read_text().strip().splitlines()[1:],'guestBooted':False,'serviceStarted':False}
  (root/'final-startup.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
else:subprocess.run(['unshare','--user','--map-root-user','--net','--mount',sys.executable,__file__,'--inner'],check=True,timeout=140)
