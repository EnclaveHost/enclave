# ROOT EXECUTES (prepared by Claude 2026-10-21; derived from linux-corrected-release/activation/prepare-admission.py).
# Reads ONLY the public attestation endpoint. Builds the ADDITIVE measurement allowlist: every currently allowed
# measurement (51516b778's 9fcbd925... and c083's included - removing any is root's separate decision) plus this
# release's. The installed file it will replace must be exactly what the 51516b778 admission installed. Local files only.
from pathlib import Path
import urllib.request,json,secrets,datetime,hashlib
A=Path(__file__).resolve().parent;plan=json.loads((A/'plan.json').read_text())
OLD=Path(__file__).resolve().parents[2]/'linux-corrected-release/activation/admission.json';old=json.loads(OLD.read_text())
assert not (A/'admission.json').exists(),'already prepared; inspect'
assert old['stage']=='verified active; old control still connected' and old['environmentSha256']=='810760c0bd258e596c96af49ee4e8133c409c2b541d5b37db331db7b95ca4fe1'
url='https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32)
with urllib.request.urlopen(url,timeout=20) as r:d=json.load(r)
allowed=d['operatorAllowlist']['measurements']
assert len(allowed)==len(set(allowed)) and all(len(x)==96 and all(c in '0123456789abcdef' for c in x) for x in allowed)
assert d['operatorAllowlist']['admittedAtAttach']=='b8376e15f7f94f9b40e9891a19be4779b1635b1c6e269e820ee09cf9313c9dfcc810072bd4ab3d1f4b19e1b6794ac35d','production is not on the rollback measurement'
assert old['added'] in allowed and set(old['existing'])<=set(allowed) and len(allowed)==len(old['existing'])+1,'the installed admission is not what the 51516b778 record says'
assert plan['measurement'] not in allowed
text='METAL_ALLOWED_MEASUREMENTS='+','.join(allowed+[plan['measurement']])+'\n'
(A/'measurement.env').write_text(text)
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'existing':allowed,'added':plan['measurement'],
 'oldAdmittedAtAttach':d['operatorAllowlist']['admittedAtAttach'],'environmentSha256':hashlib.sha256(text.encode()).hexdigest(),
 'replacesInstalledSha256':old['files']['/etc/nan-relay/linux-leasegas-measurements.env'],
 'dropinSha256':old['files']['/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf'],
 'stage':'prepared only'}
(A/'admission.json').write_text(json.dumps(record,indent=2)+'\n')
print('Prepared additive admission:',len(allowed),'currently allowed measurements retained, plus',plan['measurement'][:16])
