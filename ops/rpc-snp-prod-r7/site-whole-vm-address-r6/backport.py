"""Backport of main 154f4f458 (a whole-VM app whose version declares endpoints.web gets its address and Open link)
onto the r5 dashboard source (the r4 reconstructed source plus r5's whole-VM row note).

python3 -I backport.py DEPLOYMENTS_JS

A version that declares no browser address keeps r5's note, with its inline style: the live css/site.css does not
change. Each anchor must match exactly once.
"""
import sys

PATCHES = [
    ('  if (isWholeVm((d.image && d.image.reference) || d.appRef)) return "";   // it has no origin of either kind\n',
     '  if (wholeVmWithoutAddress((d.image && d.image.reference) || d.appRef)) return "";   // it has no origin of either kind\n'),
    ('// host\'s snp-vm manager. It ends TLS on a certificate bound to its attestation report, which no public CA signs, and\n'
     '// its host publishes no Enclave-network route for it: <label>.app.enclave.host does not resolve and there is no /x/<id>\n'
     '// path either. Such a row therefore offers no address, no Open link and no phone pairing. An Open link there could\n'
     '// only ever show "no answer" on an app that is running exactly as designed; the row says what is true instead.\n'
     'export function isWholeVm(ref){\n'
     '  try {\n'
     '    const cr = parseCatalogRef(ref);\n'
     '    const app = cr && STORE.byId[cr.appId];\n'
     '    const ver = app && app.versions ? app.versions[cr.index] : null;\n'
     '    return !!ver && (JSON.parse(ver.config || "{}") || {}).runtime === "sev-snp-vm";\n'
     '  } catch { return false; }\n'
     '}\n',
     '// host\'s snp-vm manager, and it ends TLS itself on a key bound to its attestation report.\n'
     '//  - A version whose config declares a browser address (endpoints.web) asks its host for a publicly trusted\n'
     '//    certificate for <label>.app.enclave.host on that same key, and the host routes the name to the VM once the VM\n'
     '//    serves it: the row is an ordinary one, with its address and Open link.\n'
     '//  - A version that declares none serves only the report-bound certificate, which no public CA signs, and has no\n'
     '//    route: <label>.app.enclave.host does not resolve and there is no /x/<id> path either. Such a row offers no\n'
     '//    address, no Open link and no phone pairing. An Open link there could only ever show "no answer" on an app that\n'
     '//    is running exactly as designed; the row says what is true instead.\n'
     'function versionConfigOf(ref){\n'
     '  try {\n'
     '    const cr = parseCatalogRef(ref);\n'
     '    const app = cr && STORE.byId[cr.appId];\n'
     '    const ver = app && app.versions ? app.versions[cr.index] : null;\n'
     '    return (ver && JSON.parse(ver.config || "{}")) || {};\n'
     '  } catch { return {}; }\n'
     '}\n'
     'export function isWholeVm(ref){ return versionConfigOf(ref).runtime === "sev-snp-vm"; }\n'
     'export function wholeVmWithoutAddress(ref){\n'
     '  const c = versionConfigOf(ref), web = c.endpoints && c.endpoints.web;\n'
     '  return c.runtime === "sev-snp-vm" && !(typeof web === "string" && web.startsWith("/"));\n'
     '}\n'),
    ('            : isWholeVm((d.image && d.image.reference) || d.appRef) ? WHOLE_VM_NOTE : \'\') +\n',
     '            : wholeVmWithoutAddress((d.image && d.image.reference) || d.appRef) ? WHOLE_VM_NOTE : \'\') +\n'),
]

def patch(path):
    s = open(path, encoding='utf-8').read()
    for old, _ in PATCHES:
        if s.count(old) != 1:
            raise SystemExit('anchor not found exactly once: %r' % old[:70])
    for old, new in PATCHES:
        s = s.replace(old, new)
    open(path, 'w', encoding='utf-8').write(s)

if __name__ == '__main__':
    patch(sys.argv[1])
