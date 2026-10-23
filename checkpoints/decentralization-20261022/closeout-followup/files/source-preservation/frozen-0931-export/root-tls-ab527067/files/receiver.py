"""Scoped receiver liveness repair; no firewall, auth or host/VM restart. Default read-only."""
import subprocess,pathlib,json,os,time,pwd,re,signal,sys
USERLIST=('enclave-control-tunnel','enclave-storage-tunnel','root')
CONF=pathlib.Path('/etc/ssh/sshd_config.d/69-enclave-tunnel-liveness.conf')
TEXT='# Close abandoned reverse-tunnel sessions after a crashed client.\nMatch User enclave-control-tunnel,enclave-storage-tunnel\n    ClientAliveInterval 15\n    ClientAliveCountMax 3\nMatch all\n'
def command(*a):return subprocess.check_output(a,text=True,timeout=10)
def effective(user):
 return dict(l.split(' ',1)for l in command('/usr/sbin/sshd','-T','-C','user='+user+',host=localhost,addr=4.15.13.178').splitlines()if' 'in l)
def stale(pid,boot):
 out=command('ss','-lntp','( sport = :29443 or sport = :29080 )')
 ids=set(int(x)for x in re.findall(r'pid=(\d+)',out))
 assert ids=={pid},'storage listener ownership changed'
 p=pathlib.Path('/proc')/str(pid);stat=(p/'stat').read_text();tail=stat[stat.rfind(')')+2:].split();ticks=int(tail[19]);start=time.time()-float(pathlib.Path('/proc/uptime').read_text().split()[0])+ticks/os.sysconf('SC_CLK_TCK')
 assert pwd.getpwuid(p.stat().st_uid).pw_name=='enclave-storage-tunnel','unexpected listener owner'
 assert (p/'cmdline').read_bytes().replace(b'\0',b' ').strip()==b'sshd: enclave-storage-tunnel','unexpected process'
 assert start < boot-60,'listener does not predate crashed storage VM'
 return {'pid':pid,'startEpoch':start,'ticks':ticks}
pid=int(sys.argv[1]);boot=int(sys.argv[2]);before={u:effective(u)for u in USERLIST}
assert not CONF.exists() or CONF.read_text()==TEXT,'conflicting SSH liveness drop-in'
s=stale(pid,boot)if pid else None
print(json.dumps({'phase':'preflight','staleSession':s,'clientAliveBefore':{u:{k:v for k,v in e.items()if k.startswith('clientalive')}for u,e in before.items()}}),flush=True)
if '--apply'not in sys.argv:raise SystemExit(0)
created=False
try:
 if not CONF.exists():
  with CONF.open('x')as f:f.write(TEXT)
  CONF.chmod(0o644);created=True
 command('/usr/sbin/sshd','-t');after={u:effective(u)for u in USERLIST}
 for u in USERLIST:
  a,b=dict(before[u]),dict(after[u])
  if u!='root':
   assert b['clientaliveinterval']=='15' and b['clientalivecountmax']=='3'
   for k in ['clientaliveinterval','clientalivecountmax']:a.pop(k,None);b.pop(k,None)
  assert a==b,(u,'non-liveness SSH settings changed')
except:
 if created:CONF.unlink()
 raise
command('systemctl','reload','ssh')
if pid:
 again=stale(pid,boot);assert again['ticks']==s['ticks'],'PID changed'
 # pidfd prevents signalling a recycled PID between validation and delivery.
 fd=os.pidfd_open(pid)
 try:
  assert stale(pid,boot)['ticks']==s['ticks']
  signal.pidfd_send_signal(fd,signal.SIGTERM)
 finally:os.close(fd)
print(json.dumps({'phase':'applied','stalePidTerminated':pid or None,'authAndForwardingUnchanged':True,'rootSshUnchanged':True}),flush=True)
