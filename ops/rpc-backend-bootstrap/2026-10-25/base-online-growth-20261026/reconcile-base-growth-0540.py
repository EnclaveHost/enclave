#!/usr/bin/env python3
"""Reconcile enlarged disk boot metadata without restarting the active VM/guard."""
import copy,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,tempfile
S=pathlib.Path('/home/steven/.local/state/enclave-rpc-production')
O=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-online-growth-0536')
assert json.loads((O/'result.json').read_text())['ok']
spec=importlib.util.spec_from_file_location('provision',S/'provision_vm.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
oldraw=(S/'manifest.json').read_text();old=json.loads(oldraw);new=copy.deepcopy(old)
assert old['disks']['base']['bytes']==3100000000000
new['disks']['base']['bytes']=4000000000000
oldsha=M.sha256_text(oldraw);paths=old['paths']
assert pathlib.Path(paths['unitPath']).read_text()==M.render_unit(old,oldsha)
assert pathlib.Path(paths['guardUnitPath']).read_text()==M.render_guard_unit(old,oldsha)
assert M.sha256_file(paths['launcher'])==old['files']['launcher']
assert M.qemu_argv(old)==M.qemu_argv(new)
backup=S/'backup-base-growth-20261026T0536';backup.mkdir(mode=0o700)
for label,path in [('manifest.json',S/'manifest.json'),('seed.iso',S/'seed.iso'),('user-data',S/'seed/user-data'),('vm.service',pathlib.Path(paths['unitPath'])),('guard.service',pathlib.Path(paths['guardUnitPath']))]:
 shutil.copy2(path,backup/label)
stage=backup/'prepared';stage.mkdir(mode=0o700)
for name,text in M.seed_files(new).items():
 (stage/name).write_text(text);os.chmod(stage/name,0o600);new['files']['seed/'+name]=M.sha256_text(text)
subprocess.run(['/usr/bin/xorriso','-as','mkisofs','-quiet','-V','cidata','-J','-r','-o',str(stage/'seed.iso'),str(stage/'user-data'),str(stage/'meta-data'),str(stage/'network-config')],check=True,capture_output=True)
os.chmod(stage/'seed.iso',0o600);new['files']['seedIso']=M.sha256_file(stage/'seed.iso')
newraw=M.canonical(new);newsha=M.sha256_text(newraw)
# Validate the new ISO against the same generated cloud-init inputs before installation.
check=copy.deepcopy(new);check['paths']['seedIso']=str(stage/'seed.iso');M.verify_seed(check)
ssh=['ssh','-F',str(S/'ssh_config'),'enclave-rpc']
guest_before=subprocess.check_output(ssh+['sudo -n cat /etc/enclave-rpc-vm/disks.json'],text=True)
assert json.loads(guest_before)==json.loads(M.guest_disk_config(old))
(O/'guest-disks-before.json').write_text(guest_before)
# Only the Base capacity field changes; UUID, serial, mount and all other disks retain their identities.
newguest=M.guest_disk_config(new)
script="""import json,os,pathlib,sys
p=pathlib.Path('/etc/enclave-rpc-vm/disks.json');old=json.loads(p.read_text());new=json.loads(sys.stdin.read())
expect=json.loads(json.dumps(old));base=[x for x in expect['disks'] if x['role']=='base'];assert len(base)==1 and base[0]['bytes']==3100000000000;base[0]['bytes']=4000000000000
assert new==expect
bak=p.with_name('disks.json.pre-base-growth-20261026');assert not bak.exists();bak.write_bytes(p.read_bytes());os.chmod(bak,0o600)
tmp=p.with_name('disks.json.growth-tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
with os.fdopen(fd,'w') as f:json.dump(new,f,sort_keys=True,indent=1);f.write('\\n');f.flush();os.fsync(f.fileno())
os.replace(tmp,p)
"""
import shlex
subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(script)],input=newguest,text=True,check=True,capture_output=True)
def put(path,b,mode):
 path=pathlib.Path(path);fd,name=tempfile.mkstemp(prefix='.base-growth-',dir=path.parent)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno());os.fchmod(f.fileno(),mode)
 os.replace(name,path)
for name,text in M.seed_files(new).items():put(S/'seed'/name,text.encode(),0o600)
put(S/'seed.iso',(stage/'seed.iso').read_bytes(),0o600)
put(S/'manifest.json',newraw.encode(),0o600)
put(paths['guardUnitPath'],M.render_guard_unit(new,newsha).encode(),0o644)
put(paths['unitPath'],M.render_unit(new,newsha).encode(),0o644)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
assert json.loads((S/'manifest.json').read_text())['disks']['base']['bytes']==4000000000000
assert pathlib.Path(paths['unitPath']).read_text()==M.render_unit(new,newsha)
assert pathlib.Path(paths['guardUnitPath']).read_text()==M.render_guard_unit(new,newsha)
assert M.sha256_file(S/'seed.iso')==new['files']['seedIso']
after=json.loads(subprocess.check_output(ssh+['sudo -n cat /etc/enclave-rpc-vm/disks.json'],text=True));assert after==json.loads(newguest)
state=subprocess.check_output(['systemctl','--user','show',pathlib.Path(paths['unitPath']).name,pathlib.Path(paths['guardUnitPath']).name,'-p','Id','-p','ActiveState','-p','MainPID'],text=True)
assert 'MainPID=3695222' in state
(O/'metadata-result.json').write_text(json.dumps({'ok':True,'oldManifestSha256':oldsha,'newManifestSha256':newsha,'backup':str(backup),'newVirtualBytes':4000000000000,'runningQemuUnchanged':True,'unitsReloadedNotRestarted':True,'note':'Running guard retains prior manifest in memory; NVMe policy unchanged. New manifest and pins apply on next normal coordinated boot. No guard restart was performed because BindsTo would stop the VM.'},indent=2))
(O/'units-after.txt').write_text(state);print(state)
