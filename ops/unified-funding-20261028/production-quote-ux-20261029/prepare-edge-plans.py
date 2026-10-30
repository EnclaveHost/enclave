from pathlib import Path
import json,hashlib
p=Path(__file__).resolve().parent;a=p.parent/'funding-expiry-page-r2/edge-plans';out=p/'edge-plans';out.mkdir(exist_ok=False)
prior=json.loads((a/'root-switch-plan.json').read_text());prov=(p/'composite/composite-provenance.json').read_bytes();j=json.loads(prov)
print(j.keys())
cid=j['composite']['cid']
old=prior['cid'];sha=lambda b:hashlib.sha256(b).hexdigest()
plan={'cid':cid,'activeCid':old,'artifactProvenanceSha256':sha(prov),'edges':[]}
for e in prior['edges']:
 h=e['host'];raw=(a/(h+'.candidate.Caddyfile')).read_bytes();before=json.loads((a/(h+'.candidate.json')).read_text());assert sha(raw)==e['afterCaddyfileSha256']
 oldpath='/opt/enclave-site/'+old+'/site';newpath='/opt/enclave-site/'+cid+'/site';assert raw.count(oldpath.encode())==2
 candidateRaw=raw.replace(oldpath.encode(),newpath.encode());candidate=json.loads(json.dumps(before).replace(oldpath,newpath))
 for n,data in [('before.Caddyfile',raw),('candidate.Caddyfile',candidateRaw),('before.json',(json.dumps(before,indent=2)+'\n').encode()),('candidate.json',(json.dumps(candidate,indent=2)+'\n').encode())]:(out/(h+'.'+n)).write_bytes(data)
 plan['edges'].append({'host':h,'beforeCaddyfileSha256':sha(raw),'afterCaddyfileSha256':sha(candidateRaw),'exactSemanticChanges':e['exactSemanticChanges']})
(out/'root-switch-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
