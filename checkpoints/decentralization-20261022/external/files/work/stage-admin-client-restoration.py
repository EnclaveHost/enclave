from pathlib import Path
import subprocess,difflib
r=Path('work/enclave');patches=[]
def head(n):return subprocess.check_output(['git','show','HEAD:'+n],cwd=r,text=True)
def current(n):return (r/n).read_text()
def section(s,a,b):i=s.index(a);return s[i:s.index(b,i)]
def swap(s,a,b):assert a in s,a[:80];return s.replace(a,b)
def stage(n,s):
 old=head(n);patches.append(''.join(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile='a/'+n,tofile='b/'+n)))
n='cli/enclave.mjs';s=head(n);c=current(n)
s=swap(s,'import {catalogAdmissionNotice}','import {catalogAdmissionNotice,catalogAdmissionRefusal}')
s=swap(s,section(s,'async function resolveAppRef(', 'let _appsCache'),section(c,'async function resolveAppRef(', 'let _appsCache'))
s=swap(s,'resolveAppRef(sess ? sessionAppInput(sess, f._[0]) : f._[0]);','resolveAppRef(sess ? sessionAppInput(sess, f._[0]) : f._[0], {forPrivate: !!f.private});')
s=swap(s,'  const notice = catalogAdmissionNotice(app, ver);','  const refusal = catalogAdmissionRefusal(app, ver, {forPrivate: d.isPublic === false});\n  if (refusal) throw new Error(refusal);\n  const notice = catalogAdmissionNotice(app, ver);')
s=s.replace('an explicit version leaves admission to each host.','explicit versions still obey platform moderation.').replace('// An explicit version selects the immutable release regardless of catalog moderation.\n// Hosts enforce their owning wallets\' admission policy; the CLI reports status.',"// Hosts enforce platform moderation plus their owning wallets' additional restrictions.").replace('approval is pending. Each host decides whether to run this release. For owner-only access:','approval is pending. Only PRIVATE deployments are allowed for testing. For owner-only access:');stage(n,s)
n='site/js/core/catalog.js';s=head(n);c=current(n);s=swap(s,'import {catalogAdmissionNotice}','import {catalogAdmissionNotice,catalogAdmissionRefusal}')
for a,b in [('/* ---- version selection helpers ---- */','export function selIdx'),('// Resolve explicit releases;', '// A mid-session address-book')]:
 if a.startswith('// Resolve'):
  start=s.index(a);s=s[:start]+section(c,'// Resolve catalog releases','// A mid-session address-book')+s[s.index(b,start):]
 else:s=swap(s,section(s,a,b),section(c,a,b))
stage(n,s)
n='site/js/core/chain.js';s=head(n);s=swap(s,'appCount:"b55ca2c3",','getApp:"42c71f1d", appCount:"b55ca2c3",');s=swap(s,'export async function catGetAppsPage',section(current(n),'export async function catGetApp(appId)', 'export async function catGetAppsPage')+'export async function catGetAppsPage');stage(n,s)
n='site/js/pages/deploy.js';s=head(n);s='import { catalogAdmissionRefusal } from "../core/catalog-policy.js";\n'+s;s=swap(s,'waitReceipt, catVersionFee }','waitReceipt, catVersionFee, catGetApp, catGetVersion }');s=swap(s,'  const capMsg =',section(current(n),'  const catalogRef =','  const capMsg =')+'  const capMsg =');stage(n,s)
n='site/js/pages/apps.js';s=head(n);s=swap(s,'  if (STORE.filter === "all"){\n    apps = STORE.apps.filter(a => a.versions.length);\n  } else if (STORE.filter === "delisted"){','  if (STORE.filter === "delisted"){');s=s.replace('// Direct links retain access to every published release, including delisted apps.','// Moderated history remains visible to its publisher and the catalog administrator.').replace('if (!app || !visibleVerIdxs(app).length){ host.innerHTML','if (!app || !visibleVerIdxs(app).length || !(appApproved(app) || appVerified(app) || appPrivileged(app))){ host.innerHTML');stage(n,s)
n='site/components/deployments/deployments.js';s=head(n);s=swap(s,'import {catalogStatus}','import {catalogStatus,catalogAdmissionRefusal}');s=swap(s,'catVersionFee, catGetVersion, waitReceipt','catVersionFee, catGetApp, catGetVersion, waitReceipt');s=swap(s,"    const app = STORE.byId[cr.appId] || (sharesOnly ? { slug: 'app', versions: [] } : null);",section(current(n),'    let app = STORE.byId[cr.appId]', '    if (!app || !app.versions)'));s=swap(s,'fits: (r.shareFit || resizable) && r.feeFit','fits: (r.shareFit || resizable) && r.feeFit && !catalogAdmissionRefusal(app,r.v,{forPrivate:d.isPublic===false})');s=s.replace('Each host decides which releases it accepts. Catalog status does not guarantee a host will run the selected release.','Platform moderation and host admission apply to the selected release.');stage(n,s)
n='test/cli.test.mjs';s=head(n);s=swap(s,section(s,'test("explicit deploy and upgrade leave','/* Explicit authority pins:'),section(current(n),'test("explicit deploy and upgrade enforce','/* Explicit authority pins:'));s=s.replace("S.v2 = { approval: 2, yanked: true, config: '{\"wasi\":\"0.3\"}' }; S.book = 'fail';","S.v2 = { approval: 1, yanked: false, config: '{\"wasi\":\"0.3\"}' }; S.book = 'fail';");stage(n,s)
assert subprocess.check_output(['git','diff','--cached','--name-only'],cwd=r,text=True)==''
p=Path('work/admin-client-only.patch');p.write_text(''.join(patches));subprocess.run(['git','apply','--cached','--check',str(p.resolve())],cwd=r,check=True);subprocess.run(['git','apply','--cached',str(p.resolve())],cwd=r,check=True)
files=['site/apps.html','site/components/app-card/app-card.js','site/components/app-detail/app-detail.js','docs/design/nan-retirement.md','e2e/tests/catalog-host-policy.spec.mjs','test/catalog-platform-enforcement.test.mjs','test/catalog-visibility.test.mjs'];subprocess.run(['git','add','--',*files],cwd=r,check=True)
