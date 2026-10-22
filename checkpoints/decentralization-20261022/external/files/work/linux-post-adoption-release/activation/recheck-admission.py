from pathlib import Path
import urllib.request,json,secrets,datetime
p=Path(__file__).resolve().parent
ad=json.loads((p/'admission.json').read_text())
assert ad['stage']=='installed; public endpoint recheck pending'
u='https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32)
with urllib.request.urlopen(u,timeout=25) as r:d=json.load(r)
a=d['operatorAllowlist'];assert a['admittedAtAttach']==ad['oldAdmittedAtAttach'];assert set(a['measurements'])==set(ad['existing']+[ad['added']])
ad.update(stage='verified active; old control still connected',verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
(p/'admission.json').write_text(json.dumps(ad,indent=2)+'\n')
print(json.dumps({'stage':ad['stage'],'allowed':len(a['measurements']),'newMeasurement':ad['added']}))
