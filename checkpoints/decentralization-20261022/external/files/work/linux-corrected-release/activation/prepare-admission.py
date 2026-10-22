# ROOT EXECUTES (prepared by Claude 5a07654a; derived from linux-lease-root-release/activation/prepare-admission.py).
# Reads ONLY the public attestation endpoint. Builds the additive measurement allowlist: every currently allowed
# measurement (the 32 originals and c083's 22cc..., all retained) plus the corrected 9fcbd925.... Local files only.
from pathlib import Path
import urllib.request,json,secrets,datetime,hashlib
A=Path(__file__).resolve().parent;plan=json.loads((A/'plan.json').read_text())
OLD=Path(__file__).resolve().parents[2]/'linux-lease-root-release/activation/admission.json';old=json.loads(OLD.read_text())
assert not (A/'admission.json').exists(),'already prepared; inspect'
url='https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32)
with urllib.request.urlopen(url,timeout=20) as r:d=json.load(r)
allowed=d['operatorAllowlist']['measurements']
assert len(allowed)==len(set(allowed)) and all(len(x)==96 and all(c in '0123456789abcdef' for c in x) for x in allowed)
assert d['operatorAllowlist']['admittedAtAttach']=='b8376e15f7f94f9b40e9891a19be4779b1635b1c6e269e820ee09cf9313c9dfcc810072bd4ab3d1f4b19e1b6794ac35d','production is not on the rollback measurement'
assert old['added'] in allowed and set(old['existing'])<=set(allowed),'the installed admission is not what the old record says'
assert plan['measurement'] not in allowed
text='METAL_ALLOWED_MEASUREMENTS='+','.join(allowed+[plan['measurement']])+'\n'
(A/'measurement.env').write_text(text)
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'existing':allowed,'added':plan['measurement'],
 'oldAdmittedAtAttach':d['operatorAllowlist']['admittedAtAttach'],'environmentSha256':hashlib.sha256(text.encode()).hexdigest(),
 'replacesInstalledSha256':old['files']['/etc/nan-relay/linux-leasegas-measurements.env'],
 'dropinSha256':old['files']['/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf'],
 'stage':'prepared only'}
(A/'admission.json').write_text(json.dumps(record,indent=2)+'\n')
print('Prepared additive admission:',len(allowed),'currently allowed measurements retained, plus the corrected image.')
