import subprocess,pathlib,json
pid=int(subprocess.check_output(['systemctl','--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],text=True).strip())
a=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode().split('\0')
print(json.dumps({'pid':pid,'program':pathlib.Path(a[0]).name,'scriptOrConfigPaths':[v for v in a[1:] if v.endswith(('.mjs','.json','.sh')) and not v.startswith('-')],'cwd':str(pathlib.Path(f'/proc/{pid}/cwd').resolve())}))
