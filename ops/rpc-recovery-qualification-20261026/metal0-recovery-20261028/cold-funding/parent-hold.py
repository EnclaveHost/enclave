#!/usr/bin/env python3
"""Pin and suspend ONLY the custodian host parent, never its QEMU child/cgroup.
Run a bounded child command. Restore parent only before signing or once journal is verified.
Any unresolved signed journal leaves parent held for explicit recovery; PID fd remains pinned.
"""
import os,sys,json,signal,subprocess,time
from pathlib import Path

def hold(pid):
 fd=os.pidfd_open(pid)
 signal.pidfd_send_signal(fd,signal.SIGSTOP)
 return fd

def release(fd):signal.pidfd_send_signal(fd,signal.SIGCONT)

def main():
 if len(sys.argv)<4:raise RuntimeError('usage: parent-hold.py JOURNAL_DIR HOLD_RECEIPT COMMAND...')
 journal=Path(sys.argv[1]);receipt=Path(sys.argv[2]);cmd=sys.argv[3:]
 if journal.exists() and list(journal.iterdir()):raise RuntimeError('existing journal: reconcile first')
 if receipt.exists():raise RuntimeError('hold receipt already exists')
 pid=int(subprocess.check_output(['systemctl','--user','show','enclave-custodian-v2.service','-p','MainPID','--value'],text=True))
 if pid<=1:raise RuntimeError('custodian parent absent')
 raw=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 if raw[:2]!=[b'/usr/bin/node',b'/home/steven/enclave-prod/custodian-v2/host.mjs']:raise RuntimeError('unexpected custodian parent')
 stat=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split();start=stat[19]
 children=Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
 qemus=[int(c) for c in children if b'qemu' in Path(f'/proc/{c}/comm').read_bytes()]
 if not qemus:raise RuntimeError('custodian QEMU child absent')
 fd=hold(pid);verified=False;begun=False
 try:
  deadline=time.monotonic()+3
  while Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0] not in ('T','t'):
   if time.monotonic()>deadline:raise RuntimeError('parent did not suspend')
   time.sleep(.05)
  for c in qemus:
   if Path(f'/proc/{c}/stat').read_text().rsplit(')',1)[1].split()[0] in ('T','t','Z'):raise RuntimeError('QEMU child not live')
  receipt.write_text(json.dumps({'pid':pid,'startTicks':start,'heldAt':time.time(),'qemuPids':qemus,'scope':'parent-only','sponsor':'0x29479bf04ed889d46a7afb7f292b9bb26e12647c'}))
  os.chmod(receipt,0o600)
  time.sleep(15) # drain any already-issued host HTTP submission; sender rechecks settled nonces after this
  r=subprocess.run(cmd,timeout=240)
  begun=True
  return r.returncode
 finally:
  records=list(journal.glob('*.json')) if journal.exists() else []
  verified=bool(records) and all(json.loads(p.read_text()).get('status')=='verified' for p in records)
  if not records or verified:
   release(fd);print(json.dumps({'parentResumed':True,'signedJournalVerified':verified,'qemuPids':qemus}),flush=True)
  else:
   print(json.dumps({'parentResumed':False,'recoveryRequired':True,'parentPid':pid,'journalDir':str(journal)}),flush=True)
  os.close(fd)
if __name__=='__main__':sys.exit(main())
