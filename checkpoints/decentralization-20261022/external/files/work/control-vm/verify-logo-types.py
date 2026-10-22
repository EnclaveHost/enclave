from pathlib import Path
import json,urllib.request,hashlib,concurrent.futures,datetime
items=json.loads(Path('work/logo-svg-inventory.json').read_text())
hosts={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
def check(pair):
 region,ip=pair;count=0
 for x in items:
  with urllib.request.urlopen('http://'+ip+':8189/ipfs/'+x['cid']+'?filename=i.svg',timeout=15) as r:
   assert r.headers['Content-Type']=='image/svg+xml',(region,x['cid'],r.headers['Content-Type'])
   assert hashlib.sha256(r.read()).hexdigest()==x['sha256'];count+=1
 return {'region':region,'svgCount':count,'bytesVerified':True,'correctImageType':True}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: results=list(pool.map(check,hosts.items()))
Path('outputs/logo-media-verification.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':results},indent=2)+'\n')
print(json.dumps(results))
