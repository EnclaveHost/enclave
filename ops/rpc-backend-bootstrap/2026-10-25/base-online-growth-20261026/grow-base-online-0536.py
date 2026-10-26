#!/usr/bin/env python3
"""One-time Base virtual-disk growth; never stops the VM or downloader."""
import datetime,json,os,pathlib,socket,subprocess,sys,time
OUT=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-online-growth-0536')
OUT.mkdir(exist_ok=False)
VM_PID=3695222; OLD=3100000000000; NEW=4000000000000
IMAGE='/mnt/usb/enclave-rpc-production/base-origin.qcow2'
SSH=['ssh','-F','/home/steven/.local/state/enclave-rpc-production/ssh_config','enclave-rpc']
def guest(cmd):
 r=subprocess.run(SSH+[cmd],capture_output=True,text=True,timeout=120)
 if r.returncode:raise RuntimeError(r.stderr or r.stdout)
 return r.stdout
cmdline=pathlib.Path(f'/proc/{VM_PID}/cmdline').read_bytes(); start=pathlib.Path(f'/proc/{VM_PID}/stat').read_text().split(') ')[1].split()[19]
assert IMAGE.encode() in cmdline
v=os.statvfs('/mnt/usb');assert v.f_bavail*v.f_frsize>NEW-OLD+100000000000
before=guest('findmnt -no SOURCE,FSTYPE /srv/enclave-base-holder; lsblk -ndo SERIAL /dev/sdc; sudo -n blockdev --getsize64 /dev/sdc; systemctl show enclave-rpc-base-snapshot -p MainPID -p NRestarts; df -B1 /srv/enclave-base-holder')
assert before.splitlines()[:3]==['/dev/sdc ext4','ERPC-BASE-740457FE',str(OLD)],before
assert 'MainPID=4061' in before and 'NRestarts=0' in before
(OUT/'guest-before.txt').write_text(before)
s=socket.socket(socket.AF_UNIX);s.settimeout(15);s.connect('/run/user/1000/enclave-rpc-production/qmp.sock');f=s.makefile('rwb');greeting=json.loads(f.readline());seq=0

def qmp(cmd,args=None):
 global seq
 seq+=1;f.write((json.dumps({'execute':cmd,'arguments':args or {},'id':seq})+'\n').encode());f.flush()
 while True:
  line=f.readline()
  if not line:raise RuntimeError('QMP disconnected')
  r=json.loads(line)
  if r.get('id')==seq:
   if 'error' in r:raise RuntimeError(r['error'])
   return r['return']
qmp('qmp_capabilities');blocks=qmp('query-block');(OUT/'qmp-before.json').write_text(json.dumps(blocks,indent=2))
b=[b['inserted'] for b in blocks if b.get('inserted',{}).get('node-name')=='base0'];assert len(b)==1
assert b[0]['file']==IMAGE and b[0]['image']['virtual-size']==OLD and b[0]['drv']=='qcow2' and b[0]['ro'] is False
(OUT/'intent.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'vmPid':VM_PID,'vmStart':start,'node':'base0','image':IMAGE,'oldBytes':OLD,'newBytes':NEW,'restart':False},indent=2))
qmp('block_resize',{'node-name':'base0','size':NEW})
after=qmp('query-block');(OUT/'qmp-after.json').write_text(json.dumps(after,indent=2));assert next(b['inserted']['image']['virtual-size'] for b in after if b.get('inserted',{}).get('node-name')=='base0')==NEW
# Rescan only the identity-checked SCSI disk; filesystem growth is online and retains existing data.
r=guest("test \"$(lsblk -ndo SERIAL /dev/sdc)\" = ERPC-BASE-740457FE && printf '1\\n' | sudo -n tee /sys/class/block/sdc/device/rescan >/dev/null && sudo -n blockdev --getsize64 /dev/sdc")
assert int(r.strip())==NEW,r
resize=guest('sudo -n resize2fs /dev/sdc');(OUT/'resize.txt').write_text(resize)
a=guest('findmnt -no SOURCE,FSTYPE /srv/enclave-base-holder; lsblk -ndo SERIAL /dev/sdc; sudo -n blockdev --getsize64 /dev/sdc; systemctl show enclave-rpc-base-snapshot -p MainPID -p NRestarts; df -B1 /srv/enclave-base-holder; sudo -n journalctl -u enclave-rpc-base-snapshot -n 1 --no-pager')
(OUT/'guest-after.txt').write_text(a);assert 'MainPID=4061' in a and 'NRestarts=0' in a
assert pathlib.Path(f'/proc/{VM_PID}/cmdline').read_bytes()==cmdline
assert pathlib.Path(f'/proc/{VM_PID}/stat').read_text().split(') ')[1].split()[19]==start
(OUT/'result.json').write_text(json.dumps({'ok':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'virtualBytes':NEW,'vmUnchanged':True,'downloaderUnchanged':True,'filesystemGrown':True},indent=2));print(a)
