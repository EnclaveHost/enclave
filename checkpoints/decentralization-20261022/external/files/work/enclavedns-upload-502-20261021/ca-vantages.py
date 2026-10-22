import subprocess,concurrent.futures,json,pathlib
cmd=['curl','-4','-sS','--max-time','20','-o','/dev/null','-w','%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}','https://acme.zerossl.com/v2/DV90']
import shlex
q=shlex.join(cmd)
a=[('workstation',cmd),('control-vm',['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',q]),('eu-front',['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','root@134.209.248.172',q])]
def run(x):
 name,c=x
 try:r=subprocess.run(c,capture_output=True,text=True,timeout=30);return {'vantage':name,'exit':r.returncode,'out':r.stdout[:500],'err':r.stderr[:300]}
 except subprocess.TimeoutExpired:return {'vantage':name,'error':'timeout'}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:o=list(pool.map(run,a))
pathlib.Path('work/enclavedns-upload-502-20261021/ca-vantages.json').write_text(json.dumps(o,indent=2));print(json.dumps(o))
