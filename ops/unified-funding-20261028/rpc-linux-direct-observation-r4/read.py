import pathlib,subprocess,json,time,urllib.request,re
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()=='31145670-b569-45d9-953d-51dab8368096'
print(json.dumps({'at':time.time()}))
for pid in [1311,1312]:
 try: print(json.dumps({'pid':pid,'stat':pathlib.Path('/proc',str(pid),'stat').read_text(),'io':pathlib.Path('/proc',str(pid),'io').read_text()}))
 except FileNotFoundError: print(json.dumps({'pid':pid,'gone':True}))
r=subprocess.run(['systemctl','show','enclave-rpc-el.service','enclave-rpc-cl.service','-p','ActiveState','-p','SubState','-p','MemoryCurrent','-p','MemoryPeak','-p','ExecMainStatus'],capture_output=True,text=True,timeout=3);print(json.dumps({'services':r.stdout}))
r=subprocess.run(['journalctl','-u','enclave-rpc-el.service','-u','enclave-rpc-cl.service','--since','2026-11-01 05:37:34 UTC','-n','25','--no-pager','-o','cat'],capture_output=True,text=True,timeout=3);print(json.dumps({'logs':re.sub(r'\x1b\[[0-9;]*m','',r.stdout)[-18000:]}))
for name,url,body in [('elSync','http://127.0.0.1:18645',{'jsonrpc':'2.0','id':1,'method':'eth_syncing','params':[]}),('elBlock','http://127.0.0.1:18645',{'jsonrpc':'2.0','id':2,'method':'eth_blockNumber','params':[]}),('clSync','http://127.0.0.1:15052/eth/v1/node/syncing',None)]:
 try:
  req=urllib.request.Request(url,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=1) as r: print(json.dumps({name:json.loads(r.read(65536))}))
 except Exception as e: print(json.dumps({name:type(e).__name__+': '+str(e)}))

for side in ['el','cl']:
 cg=pathlib.Path('/sys/fs/cgroup/enclave-rpc-clients.slice/enclave-rpc-'+side+'.service')
 print(json.dumps({'side':side,'metrics':{n:(cg/n).read_text() if (cg/n).exists() else None for n in ['memory.stat','memory.events','memory.pressure','io.pressure','cpu.stat']}}))
folder=pathlib.Path('/srv/enclave-l1-pair/data/logs/mainnet');files=sorted(folder.iterdir(),key=lambda p:p.stat().st_mtime)[-2:]
for f in files:
 if f.is_file():
  with f.open('rb') as stream:stream.seek(max(0,f.stat().st_size-24000));data=stream.read(24000).decode(errors='replace')
  print(json.dumps({'logfile':f.name,'size':f.stat().st_size,'tail':data[-18000:]}))
