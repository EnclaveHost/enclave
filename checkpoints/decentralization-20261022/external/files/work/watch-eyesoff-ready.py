import subprocess,time,json
last=None
for i in range(40):
 r=subprocess.run(['curl','-sS','--max-time','8','-w','\n%{http_code}','https://9eb4e600.app.enclave.host/ping'],capture_output=True,text=True)
 code=r.stdout.rsplit('\n',1)[-1];state=(r.returncode,code)
 if state!=last:print(json.dumps({'at':time.strftime('%H:%M:%S'),'exit':r.returncode,'http':code}),flush=True);last=state
 if r.returncode==0 and code=='200':
  try:
   body=json.loads(r.stdout.rsplit('\n',1)[0])
   if body.get('ok') and body.get('pong'):print('PUBLIC_PING_READY',flush=True);break
  except:pass
 time.sleep(15)
else:raise SystemExit('Public ping readiness deadline reached')
