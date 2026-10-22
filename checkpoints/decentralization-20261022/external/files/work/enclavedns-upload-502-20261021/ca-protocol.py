import subprocess,json,concurrent.futures,urllib.parse,pathlib
r=subprocess.run(['curl','-4','-fsS','--max-time','12','https://acme.zerossl.com/v2/DV90'],capture_output=True,timeout=15)
if r.returncode:print('Directory not reachable');raise SystemExit(1)
u=json.loads(r.stdout)['newNonce'];p=urllib.parse.urlparse(u);assert p.scheme=='https' and p.hostname=='acme.zerossl.com' and not p.username and not p.password
print('Nonce endpoint: '+u)
def run(proto):
 c=['curl','-4',proto,'-sS','--max-time','25','-D','-','-o','/dev/null','-w','RESULT %{http_code} %{http_version} %{time_total}',u]
 r=subprocess.run(c,capture_output=True,text=True,timeout=28)
 return {'protocolRequested':proto,'exit':r.returncode,'result':r.stdout.split('RESULT ')[-1] if 'RESULT ' in r.stdout else '', 'noncePresent':'replay-nonce:' in r.stdout.lower(),'err':r.stderr[:200]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as x:o=list(x.map(run,['--http1.1','--http2']))
pathlib.Path('work/enclavedns-upload-502-20261021/ca-protocol.json').write_text(json.dumps(o,indent=2));print(json.dumps(o))
