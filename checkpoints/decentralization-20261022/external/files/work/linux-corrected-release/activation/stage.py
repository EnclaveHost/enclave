# ROOT EXECUTES (prepared by Claude 5a07654a; derived from linux-lease-root-release/activation/stage.py).
# Copies the CORRECTED release dir and image into /home/steven/enclave-prod under NEW names (never over the c083 ones),
# each copy compared file by file with its source; reuses the already-staged lease-gas record only if byte-equal.
# No active config, drop-in or service is changed. Writes plan.json beside this script.
from pathlib import Path
import hashlib,json,shutil,os,datetime
W=Path('/home/steven/Documents/Codex/2026-10-18/wo'); S=W/'work/linux-corrected-release/stage'; P=Path('/home/steven/enclave-prod'); A=Path(__file__).resolve().parent
os.umask(0o077)
items=['metal-51516b778','dist-leasegas-51516b778']
MEASUREMENT='9fcbd925ada7a67a7b175e933f83f10681be06d86fc4b6ad46000809f9e82628e28fee5a50e1a591e23082b25f0ca0b4'
def inv(root):
 out={}
 for f in sorted(root.rglob('*')):
  if f.is_symlink():out[str(f.relative_to(root))]={'link':os.readlink(f)}
  elif f.is_file():out[str(f.relative_to(root))]={'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'mode':f.stat().st_mode&0o777}
 return out
assert not (A/'plan.json').exists(),'already staged; inspect rather than redo'
assert not (S/items[0]/'node_modules').exists() and not any(p.is_symlink() for p in (S/items[0]).rglob('node_modules'))
assert (S/items[1]/'MEASUREMENT').read_text().strip()==MEASUREMENT
for old in ['metal-c083e27a8','dist-leasegas-c083e27a8']: assert (P/old).exists(),'preserve the c083 evidence: it must still be present'
for name in items:
 source=S/name; dest=P/name; tmp=dest.with_name(dest.name+'.staging')
 assert not dest.exists(),'already staged; inspect rather than overwrite'
 assert not tmp.exists()
 shutil.copytree(source,tmp,symlinks=True)
 assert inv(source)==inv(tmp)
 os.rename(tmp,dest)
record=P/'lease-gas'/'deployment.json'
assert hashlib.sha256(record.read_bytes()).hexdigest()=='1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089','the staged lease-gas record changed'
plan={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'corrected production files staged, no active config or service changed',
 'release':str(P/items[0]),'image':str(P/items[1]),'measurement':(P/items[1]/'MEASUREMENT').read_text().strip(),
 'supersedes':{'release':str(P/'metal-c083e27a8'),'image':str(P/'dist-leasegas-c083e27a8'),'measurement':'22cc4e0d19b5dcf41a9b3ae5454806188365eff7ee6c9bccd2070e247cd1d1b4d75c49e4b65757b68fb4e1a158312d23'},
 'leaseGas':{'recordFile':str(record),'digest':'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089','rpcs':['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'],'relays':['https://134.199.235.187','https://134.209.248.172'],'quorum':2},
 'adoptionRequired':['0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9','0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c'],
 'sourceInventory':{name:inv(S/name) for name in items}}
assert plan['measurement']==MEASUREMENT
(A/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
print(json.dumps({k:v for k,v in plan.items() if k!='sourceInventory'},indent=2))
