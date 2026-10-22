import datetime,fcntl,hashlib,json,os,pathlib,subprocess
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
production=pathlib.Path('/home/steven/enclave-prod/enclave-network')
config=production/'metal0/config.json'
backup=root/'work/private/route-pull-rollout'
release=production/'reconcile-4e309fe3'
override=pathlib.Path('/home/steven/.config/systemd/user/enclave-network-reconcile.service.d/40-no-mirror-default.conf')
prior=override.with_name('30-pinned-inventory.conf')
def atomic(p,data,mode=0o600):
 t=p.with_name(p.name+'.new');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 os.replace(t,p)
with (production/'.reconcile.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if backup.exists() or release.exists() or override.exists():raise RuntimeError('rollout already prepared')
 before=config.read_bytes();cfg=json.loads(before)
 if cfg.get('mirror')!='https://api.enclave.host' or len(cfg['enclaveNetwork'].get('directories',[]))!=4:raise RuntimeError('unexpected mirror/directory state')
 pid=subprocess.check_output(['systemctl','--user','show','enclave-network-agent.service','-p','MainPID','--value'],text=True).strip()
 backup.mkdir(mode=0o700);atomic(backup/'config-before.json',before);atomic(backup/'reconciler-before.conf',prior.read_bytes())
 for app in cfg['apps']:app['publishToMirror']=False
 del cfg['mirror'];cfg['mirrorNewApps']=False
 candidate=(json.dumps(cfg,indent=2)+'\n').encode();atomic(backup/'config-candidate.json',candidate)
 release.mkdir(mode=0o700);bundle=(root/'work/route-pull-release/reconcile-apps.mjs').read_bytes();atomic(release/'reconcile-apps.mjs',bundle)
 previous=prior.read_text();old=str(production/'reconcile-be7144a0/reconcile-apps.mjs')
 if previous.count(old)!=1:raise RuntimeError('unexpected reconciler executable')
 atomic(override,previous.replace(old,str(release/'reconcile-apps.mjs')).encode(),0o644)
 subprocess.run(['systemctl','--user','daemon-reload'],check=True)
 atomic(config,candidate)
 subprocess.run(['systemctl','--user','reload','enclave-network-agent.service'],check=True)
 after=subprocess.check_output(['systemctl','--user','show','enclave-network-agent.service','-p','MainPID','--value'],text=True).strip()
 if after!=pid:raise RuntimeError('agent PID changed during reload')
 out=root/'outputs/route-mirror-removal';out.mkdir(exist_ok=True)
 report={'activatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'agentPid':int(pid),'agentRestarted':False,
  'mirrorConfigured':False,'mirrorNewApps':False,'appsWithMirroring':[],'reconcilerBundleSha256':hashlib.sha256(bundle).hexdigest(),
  'compatibilityReaderBundleSha256':'934b511e173a8afa5777ab5dd41223097a2235c06763c234f2e4e5bf04fd7609',
  'targetedTestsPassed':27,'verificationPending':True}
 (out/'activation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
