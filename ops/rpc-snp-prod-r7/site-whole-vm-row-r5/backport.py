"""Backport of main c2b36aa62 (no Open link or address for a whole-VM app) onto the r4 reconstructed dashboard source.

python3 -I backport.py DEPLOYMENTS_JS

The live site serves one css/site.css that an additive release must not change, so the note carries its style inline
(the live CSP allows inline style and this file already uses it). Each anchor must match exactly once.
"""
import sys

PATCHES = [
    ('  if (!d || !d.id) return (d && d.network && d.network.endpoint) || "";\n'
     '  const root = Enclave.base.replace(/\\/v1\\/?$/, "");\n',
     '  if (!d || !d.id) return (d && d.network && d.network.endpoint) || "";\n'
     '  if (isWholeVm((d.image && d.image.reference) || d.appRef)) return "";   // it has no origin of either kind\n'
     '  const root = Enclave.base.replace(/\\/v1\\/?$/, "");\n'),
    ('  return root + "/x/" + d.id;                              // direct-to-enclave override\n}\n',
     '  return root + "/x/" + d.id;                              // direct-to-enclave override\n}\n'
     '// A WHOLE-VM app (catalog runtime "sev-snp-vm", e.g. Enclave RPC) is its own measured SEV-SNP VM, launched by the\n'
     '// host\'s snp-vm manager. It ends TLS on a certificate bound to its attestation report, which no public CA signs, and\n'
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
     '}\n'
     'const WHOLE_VM_NOTE = \'<div class="enc-eprow"><span class="enc-epnote" style="font-family:var(--font-mono);font-size:.72rem;color:var(--text-dim)" title="This app runs as a whole SEV-SNP VM and serves an API on a certificate bound to its attestation report. Browsers do not trust that certificate without checking the report, so the app has no app.enclave.host address and no page to open. Its host reports it running only after verifying the VM’s launch measurement.">\'\n'
     '  + \'no app address · an API served on the VM’s own attested certificate</span></div>\';\n'),
    ('              + openCtl(d, ep, this._tls && this._tls.get(d.id)) + \'</div>\' : \'\') +\n',
     '              + openCtl(d, ep, this._tls && this._tls.get(d.id)) + \'</div>\'\n'
     '            : isWholeVm((d.image && d.image.reference) || d.appRef) ? WHOLE_VM_NOTE : \'\') +\n'),
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
