from pathlib import Path
root=Path('.')
def edit(file,old,new):
 p=root/file;s=p.read_text();assert old in s,(file,old[:80]);p.write_text(s.replace(old,new,1))
p=root/'site/js/core/catalog-policy.js';p.write_text('''// Catalog status is a recommendation. Each host's owning wallet controls admission.
export function catalogStatus(app, version) {
  return [app?.active === false && 'delisted', version?.yanked === true && 'yanked',
    Number(version?.approval) !== 1 && (Number(version?.approval) === 2 ? 'rejected' : 'pending approval')].filter(Boolean).join(', ');
}
export function catalogAdmissionNotice(app, version) {
  const status = catalogStatus(app, version);
  return status ? `Catalog status: ${status}. Each host decides whether to run this release; a host may decline it.` : '';
}
''')
p=root/'cli/enclave.mjs';s=p.read_text();s=s.replace('import ', 'import {catalogAdmissionNotice} from "../site/js/core/catalog-policy.js";\nimport ',1)
s=s.replace('// Only an EXPLICIT :version label can name one; rejected/yanked stay refused.','// An explicit version selects the immutable release regardless of catalog moderation.\n// Hosts enforce their owning wallets\' admission policy; the CLI reports status.')
s=s.replace('a.slug === slug && a.active','a.slug === slug && (verLabel !== undefined || a.active)',1)
s=s.replace('v.version === verLabel && !v.yanked','v.version === verLabel',1)
s=s.replace('has no (un-yanked) version labeled "${verLabel}"','has no version labeled "${verLabel}"',1)
start=s.index('  if (Number(ver.approval) === 2)',s.index('async function resolveAppRef'))
end=s.index('\n}',start)
s=s[:start]+'''  return { ref: `catalog://${app.appId}/${vi}`, ver, app, notice: catalogAdmissionNotice(app, ver) };'''+s[end:]
s=s.replace('v.version === rest[1] && !v.yanked','v.version === rest[1]',1).replace('has no (un-yanked) version labeled "${rest[1]}"','has no version labeled "${rest[1]}"',1)
start=s.index('  if (Number(ver.approval) === 2)',s.index('async function cmdUpgrade'))
end=s.index('  // the record\'s shares',start)
s=s[:start]+'''  const notice = catalogAdmissionNotice(app, ver);
  if (notice) say(`! ${notice}`);
'''+s[end:]
start=s.index('  const { ref, ver, app, pending } =',s.index('async function cmdDeploy'))
end=s.index('\n  // WASIp3 apps',start)
s=s[:start]+'''  const { ref, ver, app, notice } = await resolveAppRef(sess ? sessionAppInput(sess, f._[0]) : f._[0]);
  if (sess) sessionRequireApp(sess, app.appId, "deploy.create", app.slug);
  if (notice) say(`! ${notice}`);
'''+s[end:]
s=s.replace('async function resolveAppRef(input, opts = {})','async function resolveAppRef(input)')
s=s.replace('// opts.allowPending: admit a version still AWAITING approval (the publisher\n// dev-mode path: --private deployments on a fleet advertising devDeploy).\n','')
p.write_text(s)
p=root/'site/js/core/catalog.js';s=p.read_text();s='import {catalogAdmissionNotice} from "./catalog-policy.js";\n'+s
s=s.replace('export const verVisible = (app, v) => appPrivileged(app) || (!v.yanked && v.approval !== APPROVAL.rejected);','export const verVisible = (_app, v) => !!v;')
s=s.replace('  const vs = app.versions;\n  for (let i = vs.length - 1;', '  const vs = app.versions;\n  for (let i = vs.length - 1; i >= 0; i--) if (!vs[i].yanked && Number(vs[i].approval) === APPROVAL.approved) return i;\n  for (let i = vs.length - 1;',1)
start=s.index('/* opts.allowPending:');end=s.index('export function resolveAppRef',start)
s=s[:start]+'// Resolve explicit releases; catalog moderation remains visible and host-local.\n'+s[end:]
s=s.replace('resolveAppRef(input, opts = {})','resolveAppRef(input)')
s=s.replace('a.slug === slug && a.active','a.slug === slug',1).replace('x.version === version && !x.yanked','x.version === version',1)
start=s.index('  if (v.approval !== APPROVAL.approved',s.index('export function resolveAppRef'))
end=s.index('  PORTS_CACHE[input]',start)
s=s[:start]+'  REF_CACHE[input] = catalogRef(apps[0].appId, vi);\n'+s[end:]
s=s.replace('...(awaiting ? { awaitingApproval: true } : {})','notice: catalogAdmissionNotice(apps[0], v)')
p.write_text(s)
edit('site/apps.html','<button data-filter="approved" type="button" aria-pressed="false">Approved</button>','<button data-filter="approved" type="button" aria-pressed="false">Approved</button>\n        <button data-filter="all" type="button" aria-pressed="false">All releases</button>')
p=root/'site/js/pages/apps.js';s=p.read_text();s='import {catalogAdmissionNotice} from "../core/catalog-policy.js";\n'+s
s=s.replace('  if (STORE.filter === "delisted"){','  if (STORE.filter === "all"){\n    apps = STORE.apps.filter(a => a.versions.length);\n  } else if (STORE.filter === "delisted"){',1)
s=s.replace(' || !(appApproved(app) || appVerified(app) || appPrivileged(app))','',1)
s=s.replace("      '<p class=\"qd-sub qd-target\" hidden></p>' +", "      (catalogAdmissionNotice(app, v) ? '<p class=\"qd-sub qd-catalog\">' + esc(catalogAdmissionNotice(app, v)) + '</p>' : '') +\n      '<p class=\"qd-sub qd-target\" hidden></p>' +",1)
p.write_text(s)
edit('site/components/app-detail/app-detail.js', '''      '<button class="btn btn-primary btn-sm" data-act="deploy" type="button"'
        + (!app.active ? ' disabled title="Delisted: the enclave refuses its CIDs; relist first"'
           : v.approval === APPROVAL.approved ? '' : ' disabled title="Deploys unlock once the catalog owner approves this version"') + '>Deploy →</button>' '''.strip(),'''      '<button class="btn btn-primary btn-sm" data-act="deploy" type="button">Deploy →</button>' '''.strip())
p=root/'site/components/deployments/deployments.js';s=p.read_text();s='import {catalogStatus} from "../../js/core/catalog-policy.js";\n'+s
s=s.replace('verFees[i] = (!v.yanked && v.approval === APPROVAL.approved) ? await catVersionFee(cr.appId, i) : 0n;','verFees[i] = await catVersionFee(cr.appId, i);',1)
start=s.index('    if (sharesOnly && (currentVersion.yanked')
end=s.index('    // The owner\'s hourly ceiling',start);s=s[:start]+s[end:]
s=s.replace('      .filter(r => sharesOnly || (!r.v.yanked && r.v.approval === APPROVAL.approved))\n','',1)
s=s.replace('const newer = others.find(r => r.fits && r.i > cr.index);','const newer = others.find(r => r.fits && r.i > cr.index && !catalogStatus(app, r.v));',1)
s=s.replace('others.find(r => r.fits)) || null','others.find(r => r.fits && !catalogStatus(app, r.v))) || null',1)
s=s.replace('has no other approved version yet - new releases appear here once the catalog owner approves them','has no other version yet',1)
s=s.replace('      +       esc(app.slug + ":" + r.v.version)','      +       esc(app.slug + ":" + r.v.version)\n      +       (catalogStatus(app, r.v) ? " · " + esc(catalogStatus(app, r.v)) : "")',1)
s=s.replace("      +   '</select>')", "      +   '</select><p class=\"enc-shares-note\">Each host decides which releases it accepts. Catalog status does not guarantee a host will run the selected release.</p>')",1)
p.write_text(s)
