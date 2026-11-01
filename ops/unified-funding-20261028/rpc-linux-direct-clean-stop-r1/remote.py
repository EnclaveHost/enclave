import pathlib,subprocess,json,time
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()=='31145670-b569-45d9-953d-51dab8368096'
print(json.dumps({'at':time.time(),'bootVerified':True}),flush=True)
r=subprocess.run(['systemctl','stop','enclave-rpc-el.service','enclave-rpc-cl.service'],capture_output=True,text=True,timeout=32)
print(json.dumps({'stopRC':r.returncode,'stdout':r.stdout,'stderr':r.stderr}),flush=True)
r=subprocess.run(['systemctl','show','enclave-rpc-el.service','enclave-rpc-cl.service','-p','ActiveState','-p','SubState','-p','MainPID','-p','ExecMainStatus','-p','Result'],capture_output=True,text=True,timeout=3)
print(json.dumps({'services':r.stdout}),flush=True)
assert 'MainPID=0' in r.stdout and r.stdout.count('MainPID=0')==2
subprocess.run(['sync'],check=True,timeout=8)
print(json.dumps({'syncComplete':True}),flush=True)
subprocess.run(['systemctl','--no-block','poweroff'],check=True,timeout=3)
