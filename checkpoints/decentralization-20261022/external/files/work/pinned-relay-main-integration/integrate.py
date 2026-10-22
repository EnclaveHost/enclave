from pathlib import Path
import re,hashlib,json,os,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');base=root/'work/enclave';cand=root/'work/pinned-host-relay/tree';out=Path(__file__).parent
sha=lambda b:hashlib.sha256(b).hexdigest()
entries=[]
for line in (root/'work/pinned-host-relay/overlay.report').read_text().splitlines():
 m=re.fullmatch(r'patched (\S+) ([0-9a-f]{64}) -> ([0-9a-f]{64})',line)
 if m:rel,before,after=m.groups()
 else:
  m=re.fullmatch(r'added (\S+) ([0-9a-f]{64})',line)
  if not m:continue
  rel,after=m.groups();before=None
 p=Path(rel);assert not p.is_absolute() and '..' not in p.parts
 src=cand/p;dst=base/p;data=src.read_bytes();assert sha(data)==after,('candidate changed',rel)
 assert not dst.is_symlink(),('main symlink',rel)
 actual=sha(dst.read_bytes()) if dst.exists() else None
 assert actual==before,('main changed',rel,actual,before)
 entries.append({'path':rel,'before':before,'after':after,'bytes':len(data)})
assert len(entries)==8,entries
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'PREPARED','files':entries,'sourcePatchSha256':sha((root/'work/pinned-host-relay/pinned-relay.patch').read_bytes()),'validation':{'newConfiguration':{'passed':9,'failed':0},'newRealChain':{'passed':4,'failed':0},'existingSuites':{'passed':20,'failed':0,'log':'work/pinned-host-relay/logs/regression-1.log'}},'productionChanged':False,'generatedArtifacts':'Not updated here; rebuild once after owner-nomination composition.'}
log=(root/'work/pinned-host-relay/logs/regression-1.log').read_text()
report['validation']['existingSuites']['counts']={k:sum(int(n) for n in re.findall(r'^# '+k+r' (\d+)$',log,re.M)) for k in ['tests','pass','fail','skipped']}
assert report['validation']['existingSuites']['counts']['fail']==0
inv=out/'inventory.json';inv.write_text(json.dumps(report,indent=2)+'\n')
for e in entries:
 rel=Path(e['path']);dst=base/rel;src=cand/rel
 if e['before']:
  backup=out/'before'/rel;backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(dst.read_bytes())
 dst.parent.mkdir(parents=True,exist_ok=True)
 data=src.read_bytes();assert sha(data)==e['after']
 actual=sha(dst.read_bytes()) if dst.exists() else None;assert actual==e['before']
 tmp=dst.with_name(dst.name+'.pinned-relay-root-tmp');assert not tmp.exists()
 with tmp.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 tmp.chmod(src.stat().st_mode & 0o777);os.replace(tmp,dst)
 assert sha(dst.read_bytes())==e['after']
report['status']='SOURCE_INTEGRATED_NOT_DEPLOYED';inv.write_text(json.dumps(report,indent=2)+'\n');(root/'outputs/decentralization-audit/pinned-relay-source-integration.json').write_text(inv.read_text())
print(json.dumps({'status':report['status'],'files':len(entries),'patch':report['sourcePatchSha256']}))
