#!/usr/bin/env python3
# HANDOFF.json: the exact bytes root/owner signs. For each unsigned APK variant: its sha256 and size, and every APK entry
# whose bytes differ from the INSTALLED APK (installed sha256 -> new sha256, size, stored/deflated), plus the entries kept
# byte for byte. Signing never changes an entry, so the signed APK's entries can be checked against this file.
import hashlib, json, os, zipfile, datetime
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INST = '/home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/claude/installed-host.apk'
sha = lambda b: hashlib.sha256(b).hexdigest()
def entries(p):
    z = zipfile.ZipFile(p)
    return {i.filename: {'sha256': sha(z.read(i)), 'bytes': i.file_size, 'stored': i.compress_type == zipfile.ZIP_STORED}
            for i in z.infolist() if not i.filename.startswith('META-INF/')}
inst = entries(INST)
out = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'signed': False,
       'installed': {'file': INST, 'sha256': sha(open(INST, 'rb').read()), 'signerCertSha256': '867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d',
                     'package': 'host.enclave.pvmcpu', 'versionCode': 6, 'codeHash': 'ff559327385fec363bc757837307edc5f6aaae49566578be9cd5731f11eea848'},
       'recommended': 'apk-feature-relaydial-unsigned.apk', 'variants': {}}
for v in ['feature', 'feature-relaydial']:
    p = os.path.join(H, 'artifacts', f'apk-{v}-unsigned.apk'); new = entries(p)
    changed = {n: {'installed': inst.get(n, {}).get('sha256'), 'new': e['sha256'], 'bytes': e['bytes'], 'stored': e['stored']}
               for n, e in sorted(new.items()) if inst.get(n, {}).get('sha256') != e['sha256']}
    removed = sorted(set(inst) - set(new))
    out['variants'][v] = {'file': os.path.relpath(p, os.path.dirname(H)), 'sha256': sha(open(p, 'rb').read()), 'bytes': os.path.getsize(p),
                          'changedOrAdded': changed, 'removed': removed, 'unchangedEntries': sum(1 for n in new if n not in changed)}
json.dump(out, open(os.path.join(H, 'HANDOFF.json'), 'w'), indent=1)
for v, d in out['variants'].items(): print(v, d['sha256'], len(d['changedOrAdded']), 'changed/added', len(d['removed']), 'removed', d['unchangedEntries'], 'unchanged')
