import datetime,hashlib,json,pathlib,subprocess,time,urllib.request
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
out=root/'outputs/relay-free-network'
report=json.loads((out/'activation.json').read_text())
config=pathlib.Path('/home/steven/enclave-prod/enclave-network/metal0/config.json')
ids=['0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c','0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9']
urls=['https://9eb4e600.app.enclave.host/ping','https://7ae476a3.app.enclave.host/healthz','https://enclave.host/dashboard']
for attempt in range(24):
    now=time.time()*1000
    cfg=json.loads(config.read_text())
    if 'relay' in cfg['enclaveNetwork']:raise RuntimeError('relay reintroduced')
    actual=hashlib.sha256(pathlib.Path(report['release'],'privacy-agent.mjs').read_bytes()).hexdigest()
    if actual!=report['bundleSha256']:raise RuntimeError('bundle mismatch')
    service=subprocess.check_output(['systemctl','--user','show','enclave-network-agent.service','-p','ActiveState','-p','MainPID','-p','NRestarts','-p','ExecStart'],text=True)
    if 'ActiveState=active' not in service or report['release'] not in service:raise RuntimeError('expected agent not running')
    status=json.loads(pathlib.Path(cfg['directory'],'status.json').read_text())
    apps=[]
    for id in ids:
        app=next((a for a in status.get('apps',[]) if a['deploymentId']==id),{})
        apps.append({'deploymentId':id,'leaseValid':app.get('leaseUntil',0)>now,'proofValid':app.get('proofUntil',0)>now,
          'healthyCircuits':[c for c in app.get('circuits',[]) if c.get('healthy')]})
    ready=now-status.get('updatedAt',0)<10000 and all(a['leaseValid'] and a['proofValid'] and len(a['healthyCircuits'])>=2 for a in apps)
    print(json.dumps({'attempt':attempt,'agentActive':True,'runtimeReady':ready,'healthyCircuits':[len(a['healthyCircuits']) for a in apps]}),flush=True)
    if ready:
        health=[]
        for url in urls:
            try:
                with urllib.request.urlopen(url,timeout=15) as r:
                    body=r.read(100000);health.append({'url':url,'status':r.status,'bytes':len(body)})
            except Exception as e:health.append({'url':url,'error':str(e)})
        if all(h.get('status')==200 for h in health):
            runtime={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'statusUpdatedAt':status['updatedAt'],'apps':apps}
            (out/'runtime.json').write_text(json.dumps(runtime,indent=2)+'\n')
            report.update({'verifiedAt':runtime['verifiedAt'],'verificationPending':False,'publicHealth':health,'serviceState':service.splitlines(),'runtimeEvidence':'runtime.json','installedBundleVerified':True})
            (out/'activation.json').write_text(json.dumps(report,indent=2)+'\n')
            print('VERIFIED: fresh leases/proofs, two circuits each, public HTTPS healthy',flush=True)
            break
        print(json.dumps({'publicHealth':health}),flush=True)
    time.sleep(10)
else:raise RuntimeError('health verification deadline; inspect service and DNS before any recovery action')
