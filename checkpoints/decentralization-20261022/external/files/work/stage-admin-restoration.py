from pathlib import Path
import subprocess,difflib
r=Path('work/enclave');old=subprocess.check_output(['git','show','HEAD:supervisor.js'],cwd=r,text=True);new=old
changes=[('async function hostWalletRefusal(deploymentId,appRef) {','async function hostWalletRefusal(deploymentId,appRef,forPrivate=false) {'),('.refusal({deploymentId,appRef});','.refusal({deploymentId,appRef,forPrivate});'),('hostWalletRefusal(opts.deploymentId,ref)','hostWalletRefusal(opts.deploymentId,ref,opts.forPrivate===true)'),('hostWalletRefusal(rec.id,fresh.appRef)','hostWalletRefusal(rec.id,fresh.appRef,fresh.isPublic===false)'),('hostWalletRefusal(rec.id,d.appRef)','hostWalletRefusal(rec.id,d.appRef,d.isPublic===false)'),('  // Wallet policy is enforced per host by auditClaims and renewal checks.\n  if(HOST_WALLET_POLICY)return;','  // Publisher yanks remain enforced alongside wallet policy on every host.')]
for a,b in changes:assert new.count(a)==1,a;new=new.replace(a,b)
patch=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/supervisor.js',tofile='b/supervisor.js'))
p=Path('work/admin-supervisor-only.patch');p.write_text(patch)
assert subprocess.check_output(['git','diff','--cached','--name-only'],cwd=r,text=True)==''
subprocess.run(['git','apply','--cached','--check',str(p.resolve())],cwd=r,check=True)
subprocess.run(['git','apply','--cached',str(p.resolve())],cwd=r,check=True)
files=['network/host-admission-policy.mjs','network/host-admission-runtime.mjs','site/js/core/catalog-policy.js','windows/node/host.mjs','windows/node/chain.mjs','windows/node/host-admission.bundle.mjs','metal/guest/host-policy.bundle.mjs','test/host-admission-policy.test.mjs','test/host-admission-runtime.test.mjs','test/host-policy-mirrors.test.mjs','test/windows-node-wallet-policy.test.mjs','test/supervisor-wallet-policy.test.mjs','docs/design/decentralized-architecture.md','docs/network/authority-profile.md']
subprocess.run(['git','add','--',*files],cwd=r,check=True)
