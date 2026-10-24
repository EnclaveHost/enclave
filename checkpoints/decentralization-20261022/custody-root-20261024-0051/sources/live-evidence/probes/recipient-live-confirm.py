"""Bounded read-only recipient admission/capability observations. No raw attestation or pairing material emitted."""
import urllib.request,json,secrets,hashlib,pathlib,datetime
rows=[]
nonce=secrets.token_hex(32)
for name,url in [('relayAttestation','https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+nonce),('guestd','http://127.0.0.1:8095/health')]:
 row={'name':name,'url':url}
 try:
  with urllib.request.urlopen(url,timeout=20) as r:
   b=r.read(1048577);row['status']=r.status
   if len(b)>1048576:raise ValueError('response too large')
   d=json.loads(b);row['sha256']=hashlib.sha256(b).hexdigest();row['fields']=sorted(d)
   if name=='relayAttestation':
    a=d.get('operatorAllowlist',{});row['admittedAtAttach']=a.get('admittedAtAttach');row['allowedMeasurementCount']=len(a.get('measurements',[]))
    row['measurementFields']={k:v for k,v in d.items() if k in ['measurement','format','verified','attested'] and isinstance(v,(str,bool))}
    row['nonceRequested']=nonce
   else:
    row['supports']=d.get('supports');c=d.get('catalog',{});row['catalog']={k:c[k] for k in ['runtimeId','runtime','release'] if k in c};row['version']=d.get('version')
 except Exception as e:row['error']=str(e)[:180]
 rows.append(row)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'observations':rows,'limits':['Relay-admitted measurement and public guestd capability observations only; not an independent fresh SNP quote verification or a custody release test. No raw quotes, chip IDs, keys or service changes.']}
p=pathlib.Path('work/custody-v2-live-20261023/evidence/recipient-live-confirm.json');p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
