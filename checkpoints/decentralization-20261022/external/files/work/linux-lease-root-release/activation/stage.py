from pathlib import Path
import hashlib,json,shutil,os,datetime
W=Path('/home/steven/Documents/Codex/2026-10-18/wo'); S=W/'work/linux-lease-root-release/stage'; P=Path('/home/steven/enclave-prod'); A=W/'work/linux-lease-root-release/activation'
os.umask(0o077)
items=['metal-c083e27a8','dist-leasegas-c083e27a8']
def inv(root):
 out={}
 for f in sorted(root.rglob('*')):
  if f.is_symlink():out[str(f.relative_to(root))]={'link':os.readlink(f)}
  elif f.is_file():out[str(f.relative_to(root))]={'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'mode':f.stat().st_mode&0o777}
 return out
assert not (S/items[0]/'node_modules').exists()
for name in items:
 source=S/name; dest=P/name
 assert not dest.exists(),'already staged; inspect rather than overwrite'
 assert not dest.with_name(dest.name+'.staging').exists()
 shutil.copytree(source,dest.with_name(dest.name+'.staging'),symlinks=True)
 assert inv(source)==inv(dest.with_name(dest.name+'.staging'))
 os.rename(dest.with_name(dest.name+'.staging'),dest)
record=W/'outputs/app-lease-gas-review/lease-gas-deployment.json'
assert hashlib.sha256(record.read_bytes()).hexdigest()=='1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'
gasdir=P/'lease-gas';gasdir.mkdir(exist_ok=True)
dst=gasdir/'deployment.json'
if dst.exists():assert dst.read_bytes()==record.read_bytes()
else:shutil.copyfile(record,dst)
plan={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'production files staged, no active config or service changed','release':str(P/items[0]),'image':str(P/items[1]),'measurement':(P/items[1]/'MEASUREMENT').read_text().strip(),'leaseGas':{'recordFile':str(dst),'digest':'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089','rpcs':['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'],'relays':['https://134.199.235.187','https://134.209.248.172'],'quorum':2},'sourceInventory':{name:inv(S/name) for name in items}}
(A/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
print(json.dumps({k:v for k,v in plan.items() if k!='sourceInventory'},indent=2))
