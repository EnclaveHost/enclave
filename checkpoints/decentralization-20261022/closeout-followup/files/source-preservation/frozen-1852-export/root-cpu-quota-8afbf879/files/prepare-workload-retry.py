import pathlib,json,hashlib,shutil
p=pathlib.Path(__file__).resolve().parent;old=p/'workload-kit';new=p/'workload-ready-kit';shutil.copytree(old,new)
f=new/'windows/vbslike/manager/ops/workload-canary.mjs';t=f.read_text();needle='await request({ port: handle.tcpPort, millions: 1, timeoutMs });                     // warm: compiled and serving'
assert needle in t
replacement='''res.warmAttempts = []; let warm = false;
      say({ step: "loaded", share: c.share, at: new Date().toISOString(), vmId: handle.vmId, appCpuRequested: res.appCpuRequested, appCpuPercent: res.appCpuPercent });
      for (let attempt=0; attempt<10; attempt++) {
        try { const r=await request({port:handle.tcpPort,millions:1,timeoutMs:5000}); res.warmAttempts.push({ok:true,ms:Math.round(r.ms)}); warm=true; break; }
        catch(e) { res.warmAttempts.push({ok:false,error:e.message}); await new Promise(r=>setTimeout(r,250)); }
      }
      if (!warm) throw new Error("guest did not answer the warmup within ten bounded attempts");
      say({step:"warm",share:c.share,attempts:res.warmAttempts});'''
t=t.replace(needle,replacement).replace('rejectUnauthorized: false, timeout: timeoutMs','rejectUnauthorized: false, agent: false, timeout: timeoutMs')
f.write_text(t)
m=json.loads((new/'manifest.json').read_text());r=next(x for x in m['files'] if x['path'].endswith('workload-canary.mjs'));r['parentSha256']=r['sha256'];r['sha256']=hashlib.sha256(t.encode()).hexdigest();r['changes']+='; bounded warmup retries because launcher-ready only means relay listening, not guest app ready; disable keepalive in benchmark client'
(new/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
ps=(p/'run-workload.ps1').read_text().replace("enclave-cpuwl-20261023-","enclave-cpuwl-ready-20261023-")
(p/'run-workload-ready.ps1').write_text(ps)
py=(p/'workload.py').read_text().replace("cpu-workload-20261023-1834","cpu-workload-ready-20261023-1841").replace("p/'workload-kit'","p/'workload-ready-kit'").replace("run-workload.ps1","run-workload-ready.ps1").replace("workload-stage.json","workload-ready-stage.json").replace("'workload-'+step","'workload-ready-'+step")
(p/'workload-ready.py').write_text(py)
print('Prepared bounded readiness retry; production and artifact pins unchanged')
