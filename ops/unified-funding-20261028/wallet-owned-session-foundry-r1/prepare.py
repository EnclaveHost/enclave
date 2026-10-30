# SOURCE COPY/PIN PREPARATION ONLY. Never executes Forge, solc, tests, or product code.
from pathlib import Path
import hashlib,json,re,shutil,posixpath
p=Path(__file__).resolve().parent;D=p.parent/'wallet-owned-session-create-r1-20261029/author-delivery/enclave'
S=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');F=S/'contracts/foundry/lib/forge-std/src'
assert not (p/'seed').exists(),'prepare once'
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
q=['contracts/foundry/test/WalletSessionVault.t.sol'];origins={};missing=[]
pat=re.compile(r'''import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;''')
while q:
 rel=q.pop(0)
 if rel in origins:continue
 src=F/rel[len('lib/forge-std/src/'):] if rel.startswith('lib/forge-std/src/') else D/rel
 if not src.is_file():missing.append({'path':rel,'source':str(src)});continue
 origins[rel]=src.resolve()
 for name in pat.findall(src.read_text()):
  if name.startswith('forge-std/'):dest='lib/forge-std/src/'+name[len('forge-std/'):]
  elif name.startswith('.'):dest=posixpath.normpath(str(Path(rel).parent/name))
  else:missing.append({'path':rel,'import':name});continue
  if dest.startswith('../'):raise SystemExit('outside closure '+dest)
  q.append(dest)
# Existing rig's explicitly authorized read-only P256 fallback fixture.
rel='contracts/foundry/test/fixtures/p256-verifier.hex';src=S/rel
assert src.is_file();origins[rel]=src.resolve()
assert not missing,missing
for rel,src in origins.items():
 dst=p/'seed'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
# Isolated harness config, not a modification to frozen product settings/source.
(p/'seed/foundry.toml').write_text('''[profile.default]
src = "contracts"
test = "contracts/foundry/test"
out = "out"
cache_path = "cache"
libs = ["lib"]
remappings = ["forge-std/=lib/forge-std/src/"]
solc = "/home/steven/.local/share/svm/0.8.35/solc-0.8.35"
auto_detect_solc = false
offline = true
optimizer = true
optimizer_runs = 1
via_ir = true
evm_version = "osaka"
ffi = false
fs_permissions = [{ access = "read", path = "contracts/foundry/test/fixtures" }]

[fuzz]
runs = 32

[invariant]
runs = 16
depth = 16
fail_on_revert = false
''')
(p/'owned-tmp').mkdir(mode=0o700)
seed={str(f.relative_to(p/'seed')):sha(f) for f in sorted((p/'seed').rglob('*')) if f.is_file()}
pins={str(src):sha(src) for src in origins.values()}
for f in (p/'seed').rglob('*'):
 if f.is_file():pins[str(f)]=sha(f)
for src in [Path('/home/steven/.foundry/bin/forge'),Path('/home/steven/.local/share/svm/0.8.35/solc-0.8.35'),Path('/usr/bin/python3').resolve(),Path('/usr/bin/node'),Path('/usr/bin/unshare'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs')]:pins[str(src)]=sha(src)
# Exact deployed ledger remains reference, not an undisclosed replacement in author's rev15d tests.
v16=p.parent/'wallet-ownership-migration-review-r1-20261029/ledger-rev16d-EnclaveDeployments.sol';pins[str(v16)]=sha(v16)
put('source-origins.json',{r:{'path':str(s),'sha256':sha(s)} for r,s in sorted(origins.items())})
put('seed-pins.json',seed);put('input-pins.json',dict(sorted(pins.items())))
put('closure.json',{'status':'PREPARED_ONLY_UNEXECUTED','files':len(seed),'sourcePins':len(pins),'missingImports':missing,'testEntry':'contracts/foundry/test/WalletSessionVault.t.sol','matchContract':'WalletSessionVaultTest','settings':'solc0.8.35,optimizer1,viaIR,osaka,default metadata hash; FFI false, offline, no code_size_limit override','legacyRig':'imports full SessionVault.t.sol plus generic ledger; run only WalletSessionVaultTest. Native P256 expected on osaka but inherited rig may etch existing pinned fixture; do not claim hardware/native P256 proof.','ledgerWarning':'Authored suite uses deploy/ledger rev15d; exact verified rev16d not substituted. Passing it cannot qualify actual deployed ledger. Separate explicit exact-rev16d root regression remains required.','rootNodeResult':'Separate root existing 10=7PASS/3FAIL, no repeats authorized here.','sizing':'runtime<=24576; initcode factory+5*32<=49152; executor+6*32<=49152; library+0<=49152. Factory embeds executor creation. Record unresolved library links; no deployed-bytecode equivalence claim.'})
print(json.dumps({'files':len(seed),'pins':len(pins),'missing':missing}))
