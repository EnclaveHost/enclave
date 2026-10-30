from pathlib import Path
import json,hashlib,uuid,ast
u=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028');old=u/'rpc-control-vm-l1-client-root-r5';p=u/'rpc-control-vm-l1-client-root-r6';p.mkdir()
pins=json.loads((old/'PINS.json').read_text());oldm=json.loads((old/'MANIFEST.json').read_text());nonce=str(uuid.uuid4())
for n,h in pins.items():
 f=old/n;assert hashlib.sha256(f.read_bytes()).hexdigest()==h
 t=f.read_text().replace(str(old),str(p)).replace('-r5','-r6').replace('r5.slice','r6.slice').replace(oldm['nonce'],nonce)
 (p/n).parent.mkdir(parents=True,exist_ok=True);(p/n).write_text(t)
# Preserve exact standalone sampler source provenance; no peer input changes.
nan=u/'rpc-nan-cl-root-r6/source/client-operations.py';text=nan.read_text();begin=text.index('class DiagnosticFieldTruncated');end=text.index('DIAGNOSTIC_LOG_MARKERS=')
helper=text[begin:end].replace("'bin/lighthouse'","'bin/reth'").replace("'lighthouse' if","'reth' if")
(p/'diagnostic-helper-provenance.json').write_text(json.dumps({'path':str(nan),'sourceSha256AtCopy':hashlib.sha256(nan.read_bytes()).hexdigest(),'extractedOriginalSha256':hashlib.sha256(text[begin:end].encode()).hexdigest(),'changes':'executable metadata classification Lighthouse->Reth only'},indent=2)+'\n')
f=p/'client-operations.py';t=f.read_text().replace('def start_client(side):',helper+'\ndef start_client(side):');t=t.replace('    return info\n\ndef sample_client_memory','    bind_client_diagnostic(info)\n    return info\n\ndef sample_client_memory');f.write_text(t)
f=p/'client-main.py';t=f.read_text().replace("'watchdogDeadline':time.time()+210","'watchdogDeadline':time.time()+500").replace('RuntimeMaxSec=280','RuntimeMaxSec=570').replace('RuntimeMaxSec=360','RuntimeMaxSec=650').replace('samples=[];until=time.monotonic()+90','samples=[];until=time.monotonic()+360;diagnostic_at=0;diagnostic_count=0')
t=t.replace("        sample['rpc']=sample_rpc()","        if time.monotonic()-diagnostic_at>=10 and diagnostic_count<37:\n            sample['diagnostics']=sample_client_diagnostics(s['clients']);diagnostic_at=time.monotonic();diagnostic_count+=1\n        sample['rpc']=sample_rpc()")
f.write_text(t)
f=p/'run-body.py';f.write_text(f.read_text().replace('runtime=220;stop_seconds=95;seconds=335','runtime=510;stop_seconds=95;seconds=625'))
m=json.loads((p/'MANIFEST.json').read_text());sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
m['previousTrial']={'directory':str(old),'pinsSha256':sha(old/'PINS.json'),'resultSha256':sha(old/'RESULT.json'),'terminalSha256':sha(old/'ROOT-TERMINAL.json')}
(p/'remote-program.py').write_text('\n'.join((p/n).read_text() for n in ('capture-remote.py','transport-helpers.py','client-operations.py','client-main.py')))
(p/'run.py').write_text((p/'capture-local.py').read_text()+'\n'+(p/'run-body.py').read_text());m['programSha256']=sha(p/'remote-program.py')
for key,name in [('manifest.json','payload-manifest.json'),('chain_service.py','trial-chain-service.py'),('disks.json','disks.json')]:
 m['payloadFiles'][key].update(localSource=str(p/name),sha256=sha(p/name),bytes=(p/name).stat().st_size)
(p/'MANIFEST.json').write_text(json.dumps(m,indent=2)+'\n')
e=json.loads((p/'EXTERNAL-PINS.json').read_text());e=[r for r in e if not r['path'].startswith(str(old))]
for n in ('PINS.json','RESULT.json','ROOT-TERMINAL.json'):
 f=old/n;e.append({'path':str(f),'realpath':str(f.resolve()),'bytes':f.stat().st_size,'sha256':sha(f)})
(p/'EXTERNAL-PINS.json').write_text(json.dumps(e,indent=2)+'\n')
for f in p.glob('*.py'):ast.parse(f.read_text())
(p/'PINS.json').write_text(json.dumps({n:sha(p/n) for n in pins},indent=2)+'\n')
for n in ['root-check.py','root-fresh-read.py']:
 t=(old/n).read_text().replace('root-r4','root-r5').replace('root-r5','root-r6') if n=='root-fresh-read.py' else (old/n).read_text().replace("old=p.with_name('rpc-control-vm-l1-client-root-r4')","old=p.with_name('rpc-control-vm-l1-client-root-r5')")
 if n=='root-fresh-read.py':t=t.replace('el-r5-fresh','el-r6-fresh')
 (p/n).parent.mkdir(parents=True,exist_ok=True);(p/n).write_text(t)
(p/'ROOT-PLAN.md').write_text('Separate EL diagnostic from r5, not an unchanged retry.360s startup window instead of90; SAME memory/disk/floor caps. Independentwatchdeadline500,watchunit570,main510+95stop,capture625,NBD650,outer720. Metadata sampler every>=10s maximum37; each<=64threads/0.25s between-read bound. Same-incarnation/proc+cgroup identity, onlynumericIO/stat/wchan/exemetadata; noenvironment/cmdline/fdcontents. No debuglevel change to Reth or TOML/history/proof flags. Original/COW/cleanup/financial controls unchanged. RPCstartup alone not sync orproduction.\n')
print(p,sha(p/'PINS.json'))
