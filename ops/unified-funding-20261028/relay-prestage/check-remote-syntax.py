import subprocess,json,pathlib
p=pathlib.Path('/opt/enclave-funding-staged/activation-r1-20261028')
files=['sessions.mjs','funding-route.mjs','funding-abi.mjs','fee-policy.mjs','funding-activation.mjs']
r={'kind':'SYNTAX_AND_STATIC_PACKAGE_RESOLUTION_ONLY','node':subprocess.check_output(['node','--version'],text=True).strip(),'syntax':{}}
for f in files:
 x=subprocess.run(['node','--check',str(p/f)],capture_output=True,text=True,timeout=15);r['syntax'][f]={'exitCode':x.returncode,'stderr':x.stderr}
x=subprocess.run(['node','--input-type=module','-e','console.log(JSON.stringify(["viem","viem/accounts","viem/chains"].map(x=>({name:x,resolved:import.meta.resolve(x)}))))'],cwd='/opt/nan-relay',capture_output=True,text=True,timeout=15)
r['resolutionExitCode']=x.returncode;r['resolution']=json.loads(x.stdout) if x.returncode==0 else x.stderr
r['service']=subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','ActiveState'],text=True).strip()
print(json.dumps(r,indent=2))
