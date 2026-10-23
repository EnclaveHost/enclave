import pathlib,subprocess,json,hashlib
p=pathlib.Path(__file__).resolve().parent;repo=p.parent/'cpu-root-scheduler-quota-20261023/repo';snap=json.loads((p.parent/'coupled-cpu-enforcement-20261023/root-validation/activation-snapshot.json').read_text())
commit='ab2ed9a20dcb6a1cb5d0a758d2a1322964e0f46f';payload=p/'payload';payload.mkdir(exist_ok=True)
stage=r'C:\ProgramData\Enclave\hotfix\cpu-quota-20261023';base=r'C:\Program Files\Enclave\control\windows\vbslike\manager'
rows=[]
for name in ['cpu-share.mjs','main.mjs','server.mjs','wmi-launcher.mjs','wmiserve-run.mjs']:
 b=subprocess.check_output(['git','-C',str(repo),'show',commit+':windows/vbslike/manager/'+name]);(payload/name).write_bytes(b)
 rows.append({'name':name,'live':base+'\\'+name,'before':snap['files'][name],'after':hashlib.sha256(b).hexdigest()})
m={'source':commit,'stage':stage,'files':rows,'config':{'path':r'C:\ProgramData\Enclave\shield-config.cmd','before':snap['files']['shield-config.cmd']},'policy':{'path':r'C:\Program Files\Enclave\network\admitted-shield-policy.json','before':'efee77a65fe904ac1d315effecf7fa3a62dd147a9be83fbe5fe944572f3dea41','oldMeasurement':'8414496cd0d2af2a49ec0476f69b901bef04cea5d3b52b2347b81e1ef3f14b23','newMeasurement':'62ac7aab7700ea41ace82549751ee8797a8e087502bf04ad96c0003727a6b535'},'image':{'source':r'C:\ProgramData\Enclave\hotfix\cpu-workload-exact-20261023\runtime.bin','live':r'C:\Program Files\Enclave\guest\runtime-cpu-c1619eec.bin','sha256':'c1619eec104bf955b4d2540635c9e3b4d340528666f60a05c526083d45997591'},'loader':{'source':r'C:\ProgramData\Enclave\hotfix\cpu-workload-exact-20261023\shield-host.exe','live':r'C:\Program Files\Enclave\bin\shield-host-e4eeb994.exe','sha256':'e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2'}}
(p/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');print('Prepared pinned five-file installed delta and versioned artifact manifest')
