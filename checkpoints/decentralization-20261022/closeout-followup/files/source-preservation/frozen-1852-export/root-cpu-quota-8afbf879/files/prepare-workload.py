import pathlib,subprocess,json,hashlib,shutil
p=pathlib.Path(__file__).resolve().parent;w=p.parent;kit=p/'workload-kit';kit.mkdir(exist_ok=True)
commit='ea6717d2725b8acd1b19837cdc6355421a94972d'
rels=['windows/vbslike/manager/'+n+'.mjs' for n in ['cpu-share','derive','egress','psrun','wmi-launcher','wmiserve-run']]+['windows/vbslike/verify/boot-statements.mjs']
rows=[]
for rel in rels:
 data=subprocess.check_output(['git','-C',str(w/'repo'),'show',commit+':'+rel]);dst=kit/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(data);rows.append({'path':rel,'sha256':hashlib.sha256(data).hexdigest(),'origin':commit})
rel='windows/vbslike/manager/ops/workload-canary.mjs';raw=(w/'repo'/rel).read_text();origin=hashlib.sha256(raw.encode()).hexdigest()
raw=raw.replace('hypervModule: cfg.hypervModule, prefix: cfg.prefix,','hypervModule: cfg.hypervModule, prefix: cfg.prefix, guestCpuAllowance: true,')
raw=raw.replace('res.readback = handle.cpu.readback; res.guestOnlineVcpus = handle.cpu.guestOnlineVcpus;','res.readback = handle.cpu.readback; res.guestOnlineVcpus = handle.cpu.guestOnlineVcpus; res.appCpuRequested = handle.cpu.appCpuRequested; res.appCpuPercent = handle.cpu.appCpuPercent; const expectedCpu = Math.ceil(cpu.vcpus * cpu.limit / 1000); if (expectedCpu > 100 && (res.appCpuRequested !== expectedCpu || res.appCpuPercent !== expectedCpu)) throw new Error("explicit guest CPU allocation was not echoed exactly");')
assert 'guestCpuAllowance: true' in raw and 'explicit guest CPU allocation' in raw
raw=raw.replace('cfg.requestTimeoutMs || 600_000','cfg.requestTimeoutMs || 90_000')
dst=kit/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_text(raw);rows.append({'path':rel,'sha256':hashlib.sha256(raw.encode()).hexdigest(),'origin':'Root reviewed derivative of Q workload source '+origin,'changes':'Enable canonical explicit allowance; require actual guest echo; bound request timeout'})
for name,src,expect in [('runtime.bin',w/'build/out/img-a/runtime.bin','7090c5a51c531ca9cdcfb8f5dcd519b400d9aef5c622ca46335a434b036b4a8e'),('shield-host.exe',p/'candidate-shield-host.exe','e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2'),('cpu-probe.wasm',w/'build/out/cpu-probe.wasm',None)]:
 h=hashlib.file_digest(open(src,'rb'),'sha256').hexdigest();assert expect is None or h==expect
 dst=kit/name;shutil.copyfile(src,dst);rows.append({'path':name,'sha256':h,'bytes':dst.stat().st_size,'origin':str(src)})
(kit/'manifest.json').write_text(json.dumps({'source':commit,'files':rows},indent=2)+'\n')
print(json.dumps({'source':commit,'files':len(rows),'probe':rows[-1]}))
