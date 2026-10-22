import subprocess,pathlib,json,datetime
remote='''import subprocess,json,os
out={}
def run(c,timeout=45,env=None):
 p=subprocess.run(c,capture_output=True,text=True,timeout=timeout,env=env);return {'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
cmd=['systemctl','show','enclave-public-directory','enclave-network-provider','enclave-wg-provider','-p','Id','-p','MainPID','-p','ActiveState']
out['before']=run(cmd)
avail=int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemAvailable:')))//1024
assert avail>=200,avail
out['availableMiB']=avail
out['simulation']=run(['apt-get','-s','--no-install-recommends','--no-upgrade','install','conntrack=1:1.4.8-1ubuntu1'])
s=out['simulation'];assert s['exit']==0 and '0 upgraded, 1 newly installed, 0 to remove' in s['stdout'] and [x.split()[1] for x in s['stdout'].splitlines() if x.startswith('Inst ')]==['conntrack'],s
env=dict(os.environ,DEBIAN_FRONTEND='noninteractive',NEEDRESTART_MODE='l')
out['install']=run(['apt-get','-y','-o','DPkg::Lock::Timeout=15','--no-install-recommends','--no-upgrade','install','conntrack=1:1.4.8-1ubuntu1'],timeout=180,env=env)
out['version']=run(['/usr/sbin/conntrack','--version']);out['package']=run(['dpkg-query','-W','-f=${Package} ${Version} ${Status}\\n','conntrack']);out['after']=run(cmd)
print(json.dumps(out));raise SystemExit(0 if out['install']['exit']==0 and out['version']['exit']==0 and out['before']==out['after'] else 1)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','ca-east','python3','-'],input=remote,text=True,capture_output=True,timeout=240);o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':'ca-east','exit':r.returncode,'result':json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout,'stderr':r.stderr};pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2));raise SystemExit(r.returncode)
