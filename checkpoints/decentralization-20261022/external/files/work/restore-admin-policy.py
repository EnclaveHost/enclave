from pathlib import Path
r=Path('work/enclave')
def edit(name, old, new):
 p=r/name;s=p.read_text();assert old in s,(name,old[:100]);p.write_text(s.replace(old,new))
p=r/'site/js/core/catalog-policy.js';p.write_text('''// Platform moderation is mandatory; host owners may impose additional restrictions.
export function catalogAdmissionRefusal(app, version, {forPrivate = false} = {}) {
  if (app?.active !== true) return 'This app is delisted or its catalog status is unavailable.';
  if (!version || version.yanked !== false) return 'This version is yanked or its catalog status is unavailable.';
  if (Number(version.approval) === 2) return 'This version was rejected by the catalog owner.';
  if (Number(version.approval) === 1) return null;
  if (Number(version.approval) === 0 && forPrivate === true) return null;
  return 'This version requires catalog approval; pending versions may only be deployed PRIVATE for testing.';
}
export function catalogStatus(app, version) {
  return [app?.active === false && 'delisted', version?.yanked === true && 'yanked',
    Number(version?.approval) !== 1 && (Number(version?.approval) === 2 ? 'rejected' : 'pending approval')].filter(Boolean).join(', ');
}
export function catalogAdmissionNotice(app, version) {
  if (!catalogStatus(app, version)) return '';
  return catalogAdmissionRefusal(app, version) || '';
}
''')
edit('network/host-admission-policy.mjs',"import {canonical} from './route-record.mjs';","import {canonical} from './route-record.mjs';\nimport {catalogAdmissionRefusal} from '../site/js/core/catalog-policy.js';")
edit('network/host-admission-policy.mjs','{hostId,deploymentId,appRef,version})','{hostId,deploymentId,appRef,version,forPrivate=false})')
edit('network/host-admission-policy.mjs'," if(p.requireCatalogApproval&&(!version||version.active!==true||version.yanked!==false||Number(version.approval)!==1))return 'this host owner requires current catalog approval';"," const platformRefusal=catalogAdmissionRefusal(version,version,{forPrivate});\n if(platformRefusal)return platformRefusal;\n // The legacy commitment field can tighten private development admission, never bypass platform policy.\n if(p.requireCatalogApproval&&Number(version.approval)!==1)return 'this host owner requires current catalog approval';")
edit('network/host-admission-runtime.mjs','async refusal({deploymentId,appRef})','async refusal({deploymentId,appRef,forPrivate=false})')
edit('network/host-admission-runtime.mjs',"      // Only this host owner's policy can give catalog governance veto power.\n      if(a.policy.requireCatalogApproval){","      // Always enforce platform moderation using fresh agreeing chain reads.\n      // forPrivate must come from the authoritative deployment record at the caller.\n      {")
edit('network/host-admission-runtime.mjs','{hostId,deploymentId,appRef,version});','{hostId,deploymentId,appRef,version,forPrivate});')
edit('supervisor.js','async function hostWalletRefusal(deploymentId,appRef) {','async function hostWalletRefusal(deploymentId,appRef,forPrivate=false) {')
edit('supervisor.js','.refusal({deploymentId,appRef});','.refusal({deploymentId,appRef,forPrivate});')
edit('supervisor.js','hostWalletRefusal(opts.deploymentId,ref)','hostWalletRefusal(opts.deploymentId,ref,opts.forPrivate===true)')
edit('supervisor.js','hostWalletRefusal(rec.id,fresh.appRef)','hostWalletRefusal(rec.id,fresh.appRef,fresh.isPublic===false)')
edit('supervisor.js','hostWalletRefusal(rec.id,d.appRef)','hostWalletRefusal(rec.id,d.appRef,d.isPublic===false)')
edit('supervisor.js','  // Wallet policy is enforced per host by auditClaims and renewal checks.\n  if(HOST_WALLET_POLICY)return;','  // Publisher yanks remain enforced alongside wallet policy on every host.')
edit('cli/enclave.mjs','import {catalogAdmissionNotice}', 'import {catalogAdmissionNotice,catalogAdmissionRefusal}')
edit('cli/enclave.mjs','async function resolveAppRef(input) {','async function resolveAppRef(input, {forPrivate=false}={}) {')
edit('cli/enclave.mjs','a.slug === slug && (verLabel !== undefined || a.active)','a.slug === slug && a.active')
edit('cli/enclave.mjs','  const ver = versions[vi];\n  return { ref:', '  const ver = versions[vi];\n  const refusal = catalogAdmissionRefusal(app, ver, {forPrivate});\n  if (refusal) throw new Error(refusal);\n  return { ref:')
edit('cli/enclave.mjs','resolveAppRef(sess ? sessionAppInput(sess, f._[0]) : f._[0]);','resolveAppRef(sess ? sessionAppInput(sess, f._[0]) : f._[0], {forPrivate: !!f.private});')
edit('cli/enclave.mjs','  const notice = catalogAdmissionNotice(app, ver);','  const refusal = catalogAdmissionRefusal(app, ver, {forPrivate: d.isPublic === false});\n  if (refusal) throw new Error(refusal);\n  const notice = catalogAdmissionNotice(app, ver);')
edit('cli/enclave.mjs',"// an explicit version leaves admission to each host. The ref names the", "// explicit versions still obey platform moderation. The ref names the")
edit('cli/enclave.mjs',"// An explicit version selects the immutable release regardless of catalog moderation.\n// Hosts enforce their owning wallets' admission policy; the CLI reports status.","// Hosts enforce platform moderation plus their owning wallets' additional restrictions.")
edit('cli/enclave.mjs','approval is pending. Each host decides whether to run this release. For owner-only access:', 'approval is pending. Only PRIVATE deployments are allowed for testing. For owner-only access:')
edit('site/js/core/catalog.js','import {catalogAdmissionNotice}', 'import {catalogAdmissionNotice,catalogAdmissionRefusal}')
edit('site/js/core/catalog.js','  REF_CACHE[input] = catalogRef(apps[0].appId, vi);',"  // Selection may include pending development releases; execution checks visibility.\n  const refusal = catalogAdmissionRefusal(apps[0], v, {forPrivate:true});\n  if (refusal) return { reference: input, label: input, error: refusal };\n  REF_CACHE[input] = catalogRef(apps[0].appId, vi);")
edit('site/components/deployments/deployments.js','import {catalogStatus}', 'import {catalogStatus,catalogAdmissionRefusal}')
edit('site/components/deployments/deployments.js','fits: (r.shareFit || resizable) && r.feeFit','fits: (r.shareFit || resizable) && r.feeFit && !catalogAdmissionRefusal(app,r.v,{forPrivate:d.isPublic===false})')
