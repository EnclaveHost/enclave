import pathlib,subprocess,hashlib,json,datetime
base=pathlib.Path('/home/steven/enclave-prod/custodian-v2-9d43e63e8')
manifest=json.loads((base/'manifest.json').read_text())
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
unit=subprocess.run(['systemctl','--user','show','enclave-custodian-v2.service','-p','MainPID','-p','ActiveState','-p','SubState','-p','ExecMainStartTimestamp','-p','FragmentPath'],capture_output=True,text=True,timeout=10)
vms=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit():continue
 try:
  if not (d/'comm').read_text().startswith('qemu'):continue
  args=(d/'cmdline').read_bytes().decode().split('\0')
  if not any(str(base) in a for a in args):continue
  fields={}
  for k in ['-name','-kernel','-initrd','-m','-smp']:
   if k in args and args.index(k)+1<len(args):fields[k]=args[args.index(k)+1]
  stat=(d/'stat').read_text();start=stat[stat.rfind(')')+2:].split()[19]
  vms.append({'pid':int(d.name),'startTicks':start,'selectedArguments':fields})
 except (OSError,UnicodeError):continue
files=[]
for name,key in [('vmlinuz','kernel'),('initramfs.cpio.gz','initramfs')]:
 p=base/name;actual=sha(p);files.append({'path':str(p),'bytes':p.stat().st_size,'sha256':actual,'matchesManifest':actual==manifest[key]['sha256']})
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'unitReturnCode':unit.returncode,'unit':dict(x.split('=',1) for x in unit.stdout.splitlines() if '=' in x),'unitError':unit.stderr[:1000],'vms':vms,'imageFiles':files,'manifestMeasurement':manifest['measurement'],'manifestCommit':manifest['commit'],'limits':['No sealed state or private configuration was read.','File pins and running VM arguments are host observations; separate fresh SNP quote binds the measured guest.']}
pathlib.Path('work/custody-v2-live-20261023/evidence/local-runtime.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
