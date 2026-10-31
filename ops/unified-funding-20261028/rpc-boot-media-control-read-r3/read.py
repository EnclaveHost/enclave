import os,json,pathlib,subprocess,time,shutil,hashlib
p=pathlib.Path
mem={line.split(':')[0]:int(line.split()[1])*1024 for line in p('/proc/meminfo').read_text().splitlines() if line.split(':')[0] in ['MemTotal','MemAvailable','SwapTotal','SwapFree']}
def call(argv):
 r=subprocess.run(argv,capture_output=True,text=True,timeout=5);assert len(r.stdout)<65536 and len(r.stderr)<4096;return {'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
processes=[]
for f in p('/proc').iterdir():
 if not f.name.isdigit():continue
 try:
  stat=(f/'stat').read_text().rsplit(')',1)[1].split();processes.append({'pid':int(f.name),'comm':(f/'comm').read_text().strip(),'start':int(stat[19]),'rss':int(stat[21])*os.sysconf('SC_PAGE_SIZE'),'exe':str((f/'exe').resolve())})
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
assert len(processes)<256
v=os.statvfs('/home/controladmin');bins={}
for name in ['qemu-img','xorriso','systemd-run','timeout','python3']:
 f=shutil.which(name);bins[name]={'path':f,'sha256':hashlib.file_digest(open(f,'rb'),'sha256').hexdigest() if f else None}
print(json.dumps({'at':time.time(),'invocation':os.environ.get('INVOCATION_ID'),'pid':os.getpid(),'boot':p('/proc/sys/kernel/random/boot_id').read_text().strip(),'memory':mem,'diskFreeBytes':v.f_bavail*v.f_frsize,'processes':processes,'jobs':call(['systemctl','list-jobs','--no-pager','--no-legend']),'timers':call(['systemctl','list-timers','--all','--no-pager']),'binaries':bins,'qemuVersion':call(['qemu-img','--version']) if bins['qemu-img']['path'] else {'missing':True},'packageSimulation':call(['apt-get','--simulate','--no-install-recommends','--no-upgrade','install','qemu-utils','xorriso']),'readOnly':True,'admitted':False}))
