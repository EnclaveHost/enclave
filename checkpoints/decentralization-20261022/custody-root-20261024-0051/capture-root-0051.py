from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo'); CK=ROOT/'work/source-checkpoint-20261022/main-repo'
BASE='a8f751be1788d160e996dd720a08a04ba05b3391'
OUT=CK/'checkpoints/decentralization-20261022/custody-root-20261024-0051'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip()
assert not OUT.exists()
oldmanifest=CK/'checkpoints/decentralization-20261022/closeout-followup/MANIFEST.json'
oldsha=sha(oldmanifest.read_bytes())
specs={
 'maintenance':('custody-operator-funding-options-20261023','df5d00afc165a56effacad66b978d8ba977c5c80','Prepared,26 local tests and11 mutations; explicit user approval pending; no live change'),
 'control-recovery':('custody-boot-final-recovery-20261024','9a710e345329b57cf2a8c4bbab2c3071f4c2fcee','Prepared,56+2 Python and18 Node tests;89 mutations before transport diagnostic addition; live funding refuses, NOT activated'),
 'r2-canary-scaffold':('custody-v2-r2-production-canary-20261024','8b82d15c7e46615cdaa35b77ba09633fbe921a81','UNFINISHED, NOT EXECUTABLE, no production lifecycle tests'),
 'live-evidence':('custody-v2-live-20261023','6eb04d03d054c63c450212d94ff58722b8c238c2','Fresh original-custodian quote/state and public tenant health; no custody lifecycle claim'),
 'current-docs':('custody-v2-current-docs-20261023','5a30f7aa71dfecc215a58e898f9c6be9201d1b6c','Reconciled evidence and pending authorities; admin rights preserved'),
}
entries=[]; sources=[]; old=bytes.fromhex('54696e666f696c')
def save(rel,b,origin,**extra):
 assert len(b)<5_000_000 and b'\0' not in b
 b.decode('utf8');assert old not in b and old.lower() not in b
 assert b'-----BEGIN PRIVATE KEY-----' not in b
 p=OUT/rel;assert not p.exists();p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin,**extra})
for name,(folder,head,status) in specs.items():
 repo=ROOT/'work'/folder;assert git(repo,'rev-parse','HEAD').decode().strip()==head
 meta=git(repo,'show','-s','--format=%H%n%T%n%P%n%an <%ae>%n%cn <%ce>%n%cI%n%s',head).decode().splitlines()
 assert meta[3]=='SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
 sources.append({'name':name,'repo':str(repo.relative_to(ROOT)),'head':head,'tree':meta[1],'parents':meta[2].split(),'author':meta[3],'committer':meta[4],'date':meta[5],'subject':meta[6],'status':status})
 for rec in git(repo,'ls-tree','-r','-z',head).split(b'\0'):
  if not rec:continue
  hdr,rawpath=rec.split(b'\t',1);mode,kind,oid=hdr.decode().split();path=rawpath.decode()
  assert kind=='blob' and mode in ('100644','100755')
  assert not any(v in Path(path).parts for v in ('node_modules','private','private-backup','.git'))
  assert 'fresh-quote-raw' not in path
  save(Path('sources')/name/path,git(repo,'cat-file','blob',oid),f'{folder}@{head}:{path}',gitBlob=oid,gitMode=mode)
artifacts=['custody-v2-live-verification-20261023.md','custody-v2-verification-history-20261023.md','operator-maintenance-proposal-20261024.md','custody-lease-protection-current-20261024.json']
for name in artifacts:
 p=ROOT/'outputs/decentralization-audit'/name;save(Path('reports')/name,p.read_bytes(),str(p.relative_to(ROOT)))
logs={
 'maintenance-combined.log':'custody-operator-funding-options-20261023/logs/root-combined.log',
 'maintenance-mutants.log':'custody-operator-funding-options-20261023/logs/root-mutants.log',
 'control-full.out':'custody-boot-final-recovery-20261024/logs/root-full-2.out',
 'control-keeper-guard.out':'custody-boot-final-recovery-20261024/logs/root-keeper-guard2.out',
 'control-transport-tests.out':'custody-boot-final-recovery-20261024/logs/root-node-diagnostic.out',
 'control-live-funding-refusal.out':'custody-boot-final-recovery-20261024/logs/root-funding-readonly3.out'}
for name,p in logs.items():save(Path('evidence')/name,(ROOT/'work'/p).read_bytes(),'work/'+p)
manifest={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'previousCloseoutManifestSha256':oldsha,'sourceControlOnly':True,'status':'Custody rollout INCOMPLETE. Temporary lease keeper active. No maintenance execution or new custody lifecycle test. Admin rights preserved.','sources':sources,'entries':entries}
(OUT/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
(OUT/'README.md').write_text('# Custody root continuation, October24\n\nSource and public evidence preservation only. See MANIFEST.json for exact Git object provenance and per-file SHA256. Production rollout is incomplete; the new committee, lifecycle canaries, book activation and dashboard publication have not occurred. The r2 canary scaffold is explicitly unfinished and must not run. Maintenance approval is pending. Temporary keeper ends03:53:51UTC; original tenant VMs and custody remain preserved. No keys, signatures, private journals, raw quotes, sealed state or binaries are included. Prior checkpoint entries and their manifest are unchanged.\n')
assert sha(oldmanifest.read_bytes())==oldsha
print(json.dumps({'files':len(entries),'bytes':sum(e['bytes'] for e in entries),'path':str(OUT),'oldManifestUnchanged':oldsha}))
