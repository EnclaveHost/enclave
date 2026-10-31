import pathlib,json,subprocess,time,hashlib,os
root=pathlib.Path('/home/controladmin/rpc-media-tools-20261031-r1');root.mkdir(mode=0o700)
start=time.monotonic();deadline=start+150
packages=['libburn4t64=1.5.6-1.1build1','libisofs6t64=1.5.6.pl01-1.1ubuntu2','libisoburn1t64=1:1.5.6-1.1ubuntu3','liburing2=2.5-1build1','qemu-utils=1:8.2.2+ds-0ubuntu1.18','xorriso=1:1.5.6-1.1ubuntu3']
def guard():
 m={a.split(':')[0]:int(a.split()[1])*1024 for a in pathlib.Path('/proc/meminfo').read_text().splitlines() if a.startswith('MemAvailable:')};v=os.statvfs(root)
 if m['MemAvailable']<2*1024**3 or v.f_bavail*v.f_frsize<16*1024**3 or time.monotonic()>=deadline:raise RuntimeError('Resource/deadline guard')
def run(argv,env=None):
 guard()
 with (root/'commands.log').open('ab') as log:
  p=subprocess.Popen(argv,cwd=root,stdout=log,stderr=log,env=env)
  try:
   while p.poll() is None:guard();time.sleep(.1)
   if p.returncode:raise RuntimeError('Command failed '+str(p.returncode))
  finally:
   if p.poll() is None:p.kill();p.wait()
guard();run(['apt-get','-o','Acquire::Retries=0','-o','Acquire::http::Timeout=15','download',*packages])
debs=sorted(root.glob('*.deb'));assert len(debs)==6
for f in debs:run(['dpkg-deb','-x',str(f),str(root/'tools')])
env={**os.environ,'LD_LIBRARY_PATH':str(root/'tools/usr/lib/x86_64-linux-gnu')}
for name in ['qemu-img','xorriso']:run([str(root/'tools/usr/bin'/name),'--version'],env)
result={'schema':'rpc-private-media-tools/1','invocation':os.environ.get('INVOCATION_ID'),'elapsed':time.monotonic()-start,'packages':packages,'debs':{f.name:hashlib.file_digest(f.open('rb'),'sha256').hexdigest() for f in debs},'binaries':{name:hashlib.file_digest((root/'tools/usr/bin'/name).open('rb'),'sha256').hexdigest() for name in ['qemu-img','xorriso']},'systemPackagesChanged':False,'servicesRestarted':False}
(root/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
