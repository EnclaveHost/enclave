import datetime,fcntl,hashlib,json,os,pathlib,subprocess

workspace=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
production=pathlib.Path('/home/steven/enclave-prod/enclave-network')
config=production/'metal0/config.json'
release=production/'relay-free-0b326889'
backup=workspace/'work/private/relay-free-network-rollout'
override=pathlib.Path('/home/steven/.config/systemd/user/enclave-network-agent.service.d/zzz-relay-free.conf')
source=workspace/'work/relay-free-agent-release/privacy-agent.mjs'
report=workspace/'outputs/relay-free-network/activation.json'

def atomic(path,data,mode=0o600):
    tmp=path.with_name(path.name+'.new')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
    with os.fdopen(fd,'wb') as f:
        f.write(data);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)

with (production/'.reconcile.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if backup.exists() or override.exists() or release.exists():
        raise RuntimeError('rollout already prepared; inspect before retrying')
    before=config.read_bytes();candidate=json.loads(before)
    network=candidate['enclaveNetwork']
    if network.get('relay')!='https://api.enclave.host' or len(network.get('directories',[]))<2:
        raise RuntimeError('unexpected live discovery configuration')
    if network.get('bootstrap') is not None:
        raise RuntimeError('bootstrap policy changed since preflight')
    if candidate['chain']['authorityPins']['registry']!='0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac':
        raise RuntimeError('registry pins changed since preflight')
    del network['relay']
    backup.mkdir(mode=0o700)
    atomic(backup/'config-before.json',before)
    after=(json.dumps(candidate,indent=2)+'\n').encode()
    atomic(backup/'config-candidate.json',after)
    release.mkdir(mode=0o700)
    bundle=source.read_bytes();atomic(release/'privacy-agent.mjs',bundle)
    dropin=('[Service]\nExecStart=\nExecStart=/usr/bin/node '+str(release/'privacy-agent.mjs')+' --config '+str(config)+'\n').encode()
    atomic(override,dropin,0o644)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    if config.read_bytes()!=before:raise RuntimeError('live config changed despite reconcile lock')
    atomic(config,after)
    subprocess.run(['systemctl','--user','restart','enclave-network-agent.service'],check=True)
    result={'activatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'sourceCommit':'0b3268897883782b948f325acab30f0c1319321b',
      'release':str(release),'bundleSha256':hashlib.sha256(bundle).hexdigest(),
      'configChange':'Removed enclaveNetwork.relay; bootstrap/control settings unchanged',
      'relayConfigured':False,'bootstrapConfigured':False,'targetedTestsPassed':91,
      'verificationPending':True,'guestServicesRestarted':False,
      'limitations':['Providers/checkers remain Enclave-operated.','The existing top-level API route mirror remains configured.','Independent-provider bootstrap is tested and supported, not enabled with an implicit direct chain path.','Local BYO is available but no production app currently selected it.']}
    atomic(report,(json.dumps(result,indent=2)+'\n').encode(),0o644)
    print(json.dumps({'activatedAt':result['activatedAt'],'bundleSha256':result['bundleSha256']}))
