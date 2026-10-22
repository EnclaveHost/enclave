import subprocess,json,datetime,pathlib
p=pathlib.Path(__file__).parent; d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
for name,args in [('system',[]),('us-west',['--resolve','38f368d6.app.enclave.host:443:134.199.235.187'])]:
 r=subprocess.run(['curl','--silent','--show-error','--max-time','20',*args,'--output',str(p/('public-'+name+'.body')),'--write-out','%{http_code} %{ssl_verify_result} %{remote_ip} %{time_total}','https://38f368d6.app.enclave.host/'],capture_output=True,text=True,timeout=25)
 d[name]={'exit':r.returncode,'result':r.stdout.strip(),'error':r.stderr[:350]}
(p/'root-public-check.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2))
