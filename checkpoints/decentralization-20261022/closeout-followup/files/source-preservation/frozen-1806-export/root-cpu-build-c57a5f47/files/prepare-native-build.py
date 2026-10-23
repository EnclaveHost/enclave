import pathlib,subprocess,hashlib,json,zipfile
p=pathlib.Path(__file__).resolve().parent;repo=p.parent/'repo';rev='ea6717d2725b8acd1b19837cdc6355421a94972d';prefix='windows/vbslike/host/'
paths=subprocess.check_output(['git','-C',str(repo),'ls-tree','-r','--name-only',rev,'--',prefix],text=True).splitlines();rows=[]
with zipfile.ZipFile(p/'native-loader-source.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for f in paths:
  b=subprocess.check_output(['git','-C',str(repo),'show',rev+':'+f]);rel=f[len(prefix):]
  z.writestr(rel,b);rows.append({'path':rel,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
m={'commit':rev,'files':rows,'zipSha256':hashlib.sha256((p/'native-loader-source.zip').read_bytes()).hexdigest()}
(p/'native-loader-source.json').write_text(json.dumps(m,indent=2)+'\n');print(json.dumps({'commit':rev,'files':len(rows),'bytes':sum(x['bytes'] for x in rows),'zipSha256':m['zipSha256']}))
