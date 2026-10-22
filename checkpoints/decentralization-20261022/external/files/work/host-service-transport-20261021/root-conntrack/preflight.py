import subprocess,pathlib,json,datetime
remote='''import subprocess,json
commands={'package': ['dpkg-query','-W','-f=${Package} ${Version} ${Status}\\n','conntrack','libnetfilter-conntrack3','libnfnetlink0'], 'simulation':['apt-get','-s','--no-install-recommends','--no-upgrade','install','conntrack'], 'memory':['free','-m'], 'directory':['systemctl','show','enclave-public-directory','-p','MainPID','-p','ActiveState']}
r={}
for k,c in commands.items():
 p=subprocess.run(c,capture_output=True,text=True,timeout=45);r[k]={'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
print(json.dumps(r))
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','ca-east','python3','-'],input=remote,text=True,capture_output=True,timeout=100);o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':'ca-east','exit':r.returncode,'result':json.loads(r.stdout) if r.returncode==0 else r.stdout,'stderr':r.stderr};pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2));raise SystemExit(r.returncode)
