#!/usr/bin/env python3
"""Watch one foreground RPC-guest build. Host-floor/cancellation stops only its named guest unit.
The guest independently applies memory, disk, CPU and runtime bounds. No retry or deletion.
"""
import argparse,datetime,json,pathlib,signal,subprocess,time
SSH=['ssh','-F','/home/steven/.local/state/enclave-rpc-production/ssh_config','-o','BatchMode=yes','-o','ConnectTimeout=10','enclave-rpc']
def available():
 return next(int(s.split()[1])//1024 for s in pathlib.Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:'))
def monitor(command,stop_command,output,*,read_memory=available,floor=16384,interval=1):
 cancelled=[None]; old={}; child=None; stop_result=None; minimum=None
 def request(sig,_): cancelled[0]=sig
 for sig in (signal.SIGTERM,signal.SIGINT):old[sig]=signal.signal(sig,request)
 reason=None; rc=None
 try:
  first=read_memory();minimum=first
  if first<floor:return {'exit':98,'reason':'host floor before start','minimumAvailableMiB':first,'started':False}
  with open(output,'x') as log:
   child=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   while child.poll() is None:
    mem=read_memory();minimum=min(minimum,mem)
    if cancelled[0]:reason='cancelled';rc=128+cancelled[0];break
    if mem<floor:reason='host floor';rc=99;break
    time.sleep(interval)
   if rc is None:
    rc=child.wait();rc=128-rc if rc<0 else rc
    if rc:reason='remote command failed or disconnected'
   if reason:
    # Contact the guest before terminating the transport. systemd's cgroup stop also kills detached descendants.
    try:
     stop=subprocess.run(stop_command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=45)
     stop_result={'exit':stop.returncode,'output':stop.stdout[-4000:]}
    except Exception as e:stop_result={'error':str(e)}
    if child.poll() is None:
     child.terminate()
     try:child.wait(5)
     except subprocess.TimeoutExpired:child.kill();child.wait()
   return {'exit':rc,'reason':reason,'minimumAvailableMiB':minimum,'started':True,'stop':stop_result}
 except BaseException:
  if child is not None and child.poll() is None:
   try: subprocess.run(stop_command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
   finally:
    child.terminate()
    try: child.wait(5)
    except subprocess.TimeoutExpired: child.kill();child.wait()
  raise
 finally:
  for sig,handler in old.items():signal.signal(sig,handler)

def main():
 a=argparse.ArgumentParser();a.add_argument('attempt',type=int,choices=range(1,10));a.add_argument('manifest');a.add_argument('run2_receipt');a.add_argument('run2_out');a.add_argument('run2_rc');a.add_argument('output');p=a.parse_args()
 for h in (p.manifest,p.run2_receipt,p.run2_out,p.run2_rc):
  if len(h)!=64 or any(c not in '0123456789abcdef' for c in h):a.error('expected SHA256')
 out=pathlib.Path(p.output);out.mkdir(exist_ok=False)
 n=p.attempt;unit=f'm7-m10-release-{n}.service';base='/srv/m10-guest-validation'
 # Refuse a previous/active attempt before assuming cleanup ownership. Only this coordinator launches these units.
 check=f'sudo test ! -e {base}/release/run-{n} && sudo test ! -e {base}/receipts/release-{n}.rc && ! sudo systemctl is-active --quiet {unit} && sudo test -s {base}/receipts/run-2.rc && sudo test -s {base}/receipts/run-2.receipt.json && ! sudo systemctl is-active --quiet m10-guest-validation-2.service'
 r=subprocess.run(SSH+[check],capture_output=True,text=True,timeout=30)
 (out/'precheck.out').write_text(r.stdout+r.stderr)
 if r.returncode:raise SystemExit('prior attempt exists or guest unavailable; nothing launched or stopped')
 started=datetime.datetime.now(datetime.timezone.utc).isoformat()
 cmd=SSH+[f'sudo bash {base}/stage-release-1/runner/run-release.sh {n} {p.manifest} {p.run2_receipt} {p.run2_out} {p.run2_rc}']
 result=monitor(cmd,SSH+[f'sudo systemctl stop {unit}'],out/'remote.out')
 result.update(start=started,end=datetime.datetime.now(datetime.timezone.utc).isoformat(),unit=unit,manifest=p.manifest)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result),flush=True);raise SystemExit(result['exit'])
if __name__=='__main__':main()
