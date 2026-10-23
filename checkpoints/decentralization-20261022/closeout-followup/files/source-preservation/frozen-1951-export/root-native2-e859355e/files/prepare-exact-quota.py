import pathlib,subprocess,json,hashlib,shutil,argparse
p=pathlib.Path(__file__).resolve().parent
args=argparse.ArgumentParser();args.add_argument('--image',required=True);args.add_argument('--sha256',required=True);a=args.parse_args()
image=pathlib.Path(a.image);assert hashlib.file_digest(open(image,'rb'),'sha256').hexdigest()==a.sha256
kit=p/'workload-exact-kit';assert not kit.exists();shutil.copytree(p/'workload-ready-kit',kit)
repo=p.parents[1]/'cpu-root-scheduler-quota-20261023/repo';commit='ab2ed9a20dcb6a1cb5d0a758d2a1322964e0f46f'
m=json.loads((kit/'manifest.json').read_text());m['source']=commit;m['guestSource']='f6d5fbedf';m['note']='Exact explicit guest quota for every share; no VM-bound marker in candidate.'
for r in m['files']:
 rel=r['path'];f=kit/rel
 if rel.endswith('.mjs') and not rel.endswith('workload-canary.mjs'):
  f.write_bytes(subprocess.check_output(['git','-C',str(repo),'show',commit+':'+rel]));r['origin']=commit
 if rel=='runtime.bin':shutil.copyfile(image,f);r['origin']=str(image);r['bytes']=f.stat().st_size
 if rel.endswith('workload-canary.mjs'):
  s=f.read_text().replace('appCpu: { vcpus: cpu.vcpus, limit: cpu.limit, reservation: cpu.reservation }','appCpu: { vcpus: cpu.vcpus, limit: cpu.limit, reservation: cpu.reservation, appCpuPercent: cpu.appCpuPercent }')
  s=s.replace('const expectedCpu = Math.ceil(cpu.vcpus * cpu.limit / 1000); if (expectedCpu > 100 && (res.appCpuRequested !== expectedCpu || res.appCpuPercent !== expectedCpu))','const expectedCpu = cpu.appCpuPercent; if (res.appCpuRequested !== expectedCpu || res.appCpuPercent !== expectedCpu)')
  s=s.replace('//   partition\'s exact Limit (1% of 16 = 16% of a VP is ~6.25x slower than 6.25% = one whole VP).','//   explicit guest cgroup quota (1% of 16 = 16% of a VP is ~6.25x slower than 6.25% = one whole VP).')
  assert 'appCpuPercent: cpu.appCpuPercent' in s and 'expectedCpu > 100' not in s
  f.write_text(s);r['origin']='Root reviewed sustained benchmark derivative';r['changes']='Exact quota passed and echoed for ALL shares, including 16; guest cgroup rather than unenforced Windows root scheduler Limit.'
 r['sha256']=hashlib.file_digest(open(f,'rb'),'sha256').hexdigest()
(kit/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
s=(p/'run-workload-sustained.ps1').read_text().replace('enclave-cpuwl-sustained-20261023-','enclave-cpuwl-exact-20261023-').replace('7090c5a51c531ca9cdcfb8f5dcd519b400d9aef5c622ca46335a434b036b4a8e',a.sha256)
(p/'run-workload-exact.ps1').write_text(s)
s=(p/'workload-sustained.py').read_text().replace('cpu-workload-sustained-20261023-1845','cpu-workload-exact-20261023').replace("p/'workload-ready-kit'","p/'workload-exact-kit'").replace('run-workload-sustained.ps1','run-workload-exact.ps1').replace('workload-sustained-stage.json','workload-exact-stage.json').replace("'workload-sustained-'+step","'workload-exact-'+step")
(p/'workload-exact.py').write_text(s)
print(json.dumps({'kit':str(kit),'source':commit,'image':a.sha256,'files':len(m['files'])}))
