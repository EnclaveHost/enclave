from pathlib import Path
import yaml,json,urllib.request,base64,time
cfg=yaml.safe_load(Path('/etc/enclave-indexd/indexd.yml').read_text())
for attempt in range(90):
 try:
  def get(path):
   req=urllib.request.Request('http://127.0.0.1:9980/api/'+path);req.add_header('Authorization','Basic '+base64.b64encode((':'+cfg['adminAPI']['password']).encode()).decode())
   with urllib.request.urlopen(req,timeout=3) as r:return json.load(r)
  s=get('state');w=get('wallet'); assert w.get('address');break
 except Exception:time.sleep(1)
else:raise SystemExit('Target admin API did not become ready; do not resume the old source snapshot')
print(json.dumps({'version':s.get('version'),'scanHeight':s.get('scanHeight'),'syncHeight':s.get('syncHeight'),'walletLoaded':True}))
