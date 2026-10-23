import concurrent.futures,datetime,json,pathlib,subprocess
host='a69dcbba.app.enclave.host'
ips=['146.190.246.39','165.245.191.129']
def check(ip):
    out=[]
    for path in ['/ping','/api/status']:
        r=subprocess.run(['curl','-sS','--max-time','12','--resolve',host+':443:'+ip,'-w','\n%{http_code}', 'https://'+host+path],capture_output=True,text=True,timeout=15)
        body,_,status=r.stdout.rpartition('\n')
        out.append({'path':path,'exit':r.returncode,'status':status,'body':body[:2200],'error':r.stderr[:400]})
    return {'ip':ip,'requests':out}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex: results=list(ex.map(check,ips))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':host,'note':'Explicit existing ingress IPs; TLS hostname and CA validation enabled. Default local resolver failed separately.','results':results}
pathlib.Path('work/api-mcp-recovery-20261023/public.json').write_text(json.dumps(o,indent=2))
print(json.dumps(o,indent=2))
