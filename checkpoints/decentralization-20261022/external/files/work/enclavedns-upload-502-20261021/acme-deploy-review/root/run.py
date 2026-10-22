import pathlib,hashlib,subprocess,sys,json,datetime,shlex
base=pathlib.Path('work/enclavedns-upload-502-20261021/acme-deploy-review');root=base/'root'
candidate=pathlib.Path('work/acme-retention/tree/relay/certs.js');helper=base/'activate_certs.py'
cpin='237834d8eed6e0f38caca1007170233690167e42c4f606adfaa11693bb6da8a4';hpin='59c71b126507d4f9aaaac58a94301b8a06453b8179326ab1787261c2664a9b2f'
assert hashlib.sha256(candidate.read_bytes()).hexdigest()==cpin
assert hashlib.sha256(helper.read_bytes()).hexdigest()==hpin
mode=sys.argv[1];assert mode in ('stage','preflight','execute')
opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc']
target='controladmin@127.0.0.1';remote='/home/controladmin/certs-retention-237834d8'
if mode=='stage':
 for f,suffix in [(candidate,'.candidate'),(helper,'.py')]:
  subprocess.run(['scp','-P','32423',*opts,str(f),target+':'+remote+suffix],check=True,timeout=40)
 print('Staged pinned candidate and reviewed helper; service unchanged.');sys.exit(0)
code="import hashlib,runpy,sys; p="+repr(remote+'.py')+"; assert hashlib.sha256(open(p,'rb').read()).hexdigest()=="+repr(hpin)+"; sys.argv=[p,'--candidate',"+repr(remote+'.candidate')+",'--candidate-sha',"+repr(cpin)+"]"+("+['--execute']" if mode=='execute' else '')+"; runpy.run_path(p,run_name='__main__')"
if mode=='execute':
 (root/'attempt.json').open('x').write(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':cpin,'helper':hpin})+'\n')
r=subprocess.run(['ssh','-p','32423',*opts,target,'sudo python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=360)
(root/(mode+'.out')).write_text(r.stdout+'\n'+r.stderr);print(r.stdout);print(r.stderr[:500]);sys.exit(r.returncode)
