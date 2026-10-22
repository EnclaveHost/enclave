import concurrent.futures,datetime,json,pathlib,subprocess,time,urllib.request
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo');out=root/'outputs/route-mirror-removal'
report=json.loads((out/'activation.json').read_text())
activated=datetime.datetime.fromisoformat(report['activatedAt']).timestamp()*1000
ids=['0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c','0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9']
origins=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188']
def get(url):
 with urllib.request.urlopen(url,timeout=12) as r:return json.load(r)
history=[]
for attempt in range(15):
 now=time.time()*1000
 cfg=json.loads(pathlib.Path('/home/steven/enclave-prod/enclave-network/metal0/config.json').read_text())
 if cfg.get('mirror') or cfg.get('mirrorNewApps') or any(a.get('publishToMirror') for a in cfg['apps']):raise RuntimeError('mirroring was re-enabled')
 pid=int(subprocess.check_output(['systemctl','--user','show','enclave-network-agent.service','-p','MainPID','--value'],text=True))
 if pid!=report['agentPid']:raise RuntimeError('network agent restarted')
 status=json.loads(pathlib.Path(cfg['directory'],'status.json').read_text())
 apps={a['deploymentId']:a for a in status['apps']}
 ready=now-status['updatedAt']<10000 and all(apps[id]['leaseUntil']>now and apps[id]['proofUntil']>now and sum(bool(c.get('healthy')) for c in apps[id]['circuits'])>=2 for id in ids)
 with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
  snapshots=list(pool.map(get,[origin+'/v1/network/records' for origin in origins]))
  legacy=pool.submit(get,'https://api.enclave.host/v1/network/routes')
  host=pool.submit(get,'https://api.enclave.host/v1/network/status/'+ids[0])
  legacy=legacy.result();host=host.result()
 sequences=[]
 for snapshot in snapshots:
  records={p['bundle']['record']['deploymentId']:p['bundle']['record'] for p in snapshot['publications']}
  sequences.append({id:{'sequence':records.get(id,{}).get('sequence'),'expiresAt':records.get(id,{}).get('expiresAt',0)} for id in ids})
 row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeReady':ready,'hostReportedAt':host.get('hostReportedAt'),
  'legacyDiagnosticsPresent':host.get('host') is not None,'legacyExpiries':{id:legacy.get('deployments',{}).get(id,{}).get('expiresAt',0) for id in ids},'directories':sequences}
 history.append(row);(out/'observations.json').write_text(json.dumps(history,indent=2)+'\n')
 print(json.dumps({'attempt':attempt,'runtimeReady':ready,'sinceActivationSeconds':int((now-activated)/1000),'hostReportedAt':row['hostReportedAt'],'legacyRoutesFresh':all(t>now for t in row['legacyExpiries'].values())}),flush=True)
 if now-activated>140000:
  if not ready or not all(t>now for t in row['legacyExpiries'].values()):raise RuntimeError('routes/runtime unhealthy after mirror removal')
  if row['hostReportedAt'] and row['hostReportedAt']>activated+15000:raise RuntimeError('host diagnostics still being mirrored')
  if row['legacyDiagnosticsPresent']:raise RuntimeError('old diagnostics did not expire')
  for index,records in enumerate(sequences):
   for id in ids:
    if records[id]['expiresAt']<=now or records[id]['sequence']<=history[0]['directories'][index][id]['sequence']:raise RuntimeError('directory renewal not observed')
  health=[]
  for url in ['https://9eb4e600.app.enclave.host/ping','https://eyesoff.ai/ping','https://7ae476a3.app.enclave.host/healthz','https://enclave.host/dashboard']:
   with urllib.request.urlopen(url,timeout=15) as r:health.append({'url':url,'status':r.status,'bytes':len(r.read(100000))})
  dns=[]
  expected=set(c['address'] for c in apps[ids[0]]['circuits'] if c.get('healthy') and c.get('ingress'))
  for origin in origins:
   ip=origin.split('//')[1].split(':')[0]
   answer=subprocess.check_output(['dig','@'+ip,'9eb4e600.app.enclave.host','A','+short','+time=3','+tries=1'],text=True).strip().splitlines()
   if set(answer)!=expected:raise RuntimeError('authoritative DNS differs from verified guest circuits')
   dns.append({'server':ip,'addresses':answer})
  report.update({'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verificationPending':False,'publicHealth':health,'authoritativeDns':dns,
   'hostDiagnosticsStoppedAt':row['hostReportedAt'],'signedDirectoriesRenewed':4,'legacyApiRoutesFresh':True,'agentPidUnchanged':True,
   'limitations':['The compatibility API remains centralized, but hosts no longer publish routes to it.','Unsigned host diagnostics are intentionally not replicated.','All four directory/provider operators are still Enclave-operated.','DNS-01 challenges, custody, governance and storage writes have separate remaining dependencies.']})
  (out/'activation.json').write_text(json.dumps(report,indent=2)+'\n');print('VERIFIED: directory renewal, API pull, DNS and HTTPS without host mirroring',flush=True);break
 time.sleep(15)
else:raise RuntimeError('verification deadline')
