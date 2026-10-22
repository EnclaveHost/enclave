import socket,subprocess,json,datetime,pathlib
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'getaddrinfo':sorted({x[4][0] for x in socket.getaddrinfo('38f368d6.app.enclave.host',443)})}
for n,c in [('getent',['getent','ahostsv4','38f368d6.app.enclave.host']),('dig',['dig','+time=3','+tries=1','+noall','+answer','38f368d6.app.enclave.host']),('curl',['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code} %{ssl_verify_result} %{remote_ip}','https://38f368d6.app.enclave.host/ping'])]:
 p=subprocess.run(c,capture_output=True,text=True,timeout=20);r[n]={'rc':p.returncode,'stdout':p.stdout[:1000],'stderr':p.stderr[:400]}
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
