from pathlib import Path
import urllib.request,json,secrets,datetime,hashlib
A=Path('work/linux-lease-root-release/activation');plan=json.loads((A/'plan.json').read_text())
url='https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32)
with urllib.request.urlopen(url,timeout=20) as r:d=json.load(r)
allowed=d['operatorAllowlist']['measurements']
assert len(allowed)>=32 and len(allowed)==len(set(allowed))
assert all(len(x)==96 and all(c in '0123456789abcdef' for c in x) for x in allowed)
assert d['operatorAllowlist']['admittedAtAttach']=='b8376e15f7f94f9b40e9891a19be4779b1635b1c6e269e820ee09cf9313c9dfcc810072bd4ab3d1f4b19e1b6794ac35d'
assert plan['measurement'] not in allowed
text='METAL_ALLOWED_MEASUREMENTS='+','.join(allowed+[plan['measurement']])+'\n'
(A/'measurement.env').write_text(text)
(A/'measurement-dropin.conf').write_text('[Service]\nEnvironmentFile=/etc/nan-relay/linux-leasegas-measurements.env\n')
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'existing':allowed,'added':plan['measurement'],'oldAdmittedAtAttach':d['operatorAllowlist']['admittedAtAttach'],'environmentSha256':hashlib.sha256(text.encode()).hexdigest(),'stage':'prepared only'}
(A/'admission.json').write_text(json.dumps(record,indent=2)+'\n')
print('Prepared additive admission:',len(allowed),'existing measurements plus tested lease-gas image; rollback measurement retained.')
