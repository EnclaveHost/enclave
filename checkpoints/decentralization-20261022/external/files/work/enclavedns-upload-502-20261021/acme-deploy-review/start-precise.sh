#!/usr/bin/env bash
# READ-ONLY: sub-second start of the relay MainPID vs mtimes of api-relay.js/secrets.js/certs.js (ns). No mutation.
cd /home/steven/Documents/Codex/2026-10-18/wo
ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 'sudo python3 -' <<'R'
import os,time
pid=int(open('/sys/fs/cgroup/system.slice/enclave-api-relay.service/cgroup.procs').read().split()[0]) if os.path.exists('/sys/fs/cgroup/system.slice/enclave-api-relay.service/cgroup.procs') else None
import subprocess
pid=int(subprocess.run(['systemctl','show','enclave-api-relay.service','-p','MainPID','--value'],capture_output=True,text=True).stdout)
tick=os.sysconf('SC_CLK_TCK'); st=int(open(f'/proc/{pid}/stat').read().rsplit(')',1)[1].split()[19])
btime=[int(l.split()[1]) for l in open('/proc/stat') if l.startswith('btime')][0]
up=float(open('/proc/uptime').read().split()[0]); now=time.time()
start=now-up+st/tick  # boot-relative, precise to 1/tick
print('pid',pid,'start_epoch',f'{start:.3f}',time.strftime('%FT%T',time.gmtime(start))+f'.{int((start%1)*1000):03d}Z (btime-based {btime+st/tick:.2f})')
mono=subprocess.run(['systemctl','show','enclave-api-relay.service','-p','ExecMainStartTimestamp','-p','ExecMainStartTimestampMonotonic','-p','InactiveExitTimestampMonotonic'],capture_output=True,text=True).stdout.strip()
print(mono.replace('\n',' | '))
for f in ['api-relay.js','secrets.js','certs.js']:
    s=os.stat('/opt/nan-relay/'+f); print(f, f'mtime_epoch {s.st_mtime:.3f}', 'after_start' if s.st_mtime>start else 'before_start', f'delta {s.st_mtime-start:+.3f}s')
R
