from pathlib import Path
import sys,json,urllib.request,urllib.parse,hashlib,shutil,time
rows=json.load(sys.stdin);rows.sort(key=lambda x:(x['unixfsType']==1,x['cid']))
root=Path('/var/lib/indexd-migration/public-pins-20261019');root.mkdir(mode=0o700,exist_ok=True);manifest=root/'manifest.json';done=json.loads(manifest.read_text()) if manifest.exists() else []
seen={x['cid'] for x in done};total=sum(x['carBytes'] for x in done)
for row in rows:
 cid=row['cid'];assert cid.isalnum()
 if cid in seen:continue
 assert shutil.disk_usage(root).free>5<<30,'Source free-space reserve reached'
 p=root/(cid+'.car');temp=p.with_suffix('.part');h=hashlib.sha256();size=0
 request=urllib.request.Request('http://127.0.0.1:5001/api/v0/dag/export?arg='+urllib.parse.quote(cid),data=b'')
 try:
  with urllib.request.urlopen(request,timeout=120) as r,temp.open('wb') as f:
   while chunk:=r.read(1<<20):
    size+=len(chunk);assert size<1<<30 and total+size<8<<30,'Archive size reserve reached';h.update(chunk);f.write(chunk)
  temp.replace(p)
 except BaseException:
  temp.unlink(missing_ok=True);raise
 total+=size;done.append({**row,'carBytes':size,'carSHA256':h.hexdigest()});manifest.write_text(json.dumps(done,indent=2)+'\n')
 if len(done)%20==0:print(json.dumps({'exported':len(done),'total':len(rows),'carBytes':total}),flush=True)
print(json.dumps({'exported':len(done),'total':len(rows),'carBytes':total,'complete':True}),flush=True)
