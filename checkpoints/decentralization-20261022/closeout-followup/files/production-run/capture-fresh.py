"""Root-reviewed fresh backup using the validated foreground-timeout runner."""
import datetime, hashlib, json, pathlib, secrets, shlex, subprocess, sys

root = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
out = root / 'work/resume-after-checkpoint-20261022/production-run'
runner = root / 'work/resume-after-checkpoint-20261022/controller-bounds-validation/b2/vm_fresh_backup.foreground.py'
sha = '62f4369029f6f66d1811ce25f9358a326b030913f67e1592df0f367600c67eb4'
assert hashlib.sha256(runner.read_bytes()).hexdigest() == sha
assert json.loads((out/'preflight-evaluated.json').read_text())['verdict'] == 'READY_FOR_FRESH_BACKUP'
facts = dict(line.split('=',1) for line in (out/'preflight.out').read_text().splitlines() if '=' in line)
started = datetime.datetime.fromisoformat(facts['preflight.started'].replace('Z','+00:00'))
assert (datetime.datetime.now(datetime.timezone.utc)-started).total_seconds() < 900
rid = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(4)
vmrunner = '/root/fresh-backup/vm_fresh_backup-62f43690.py'
ssh = ['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15',
       '-o','ServerAliveCountMax=4','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
def remote(command, **kw):
    return subprocess.run(ssh+[command], cwd=root, **kw)
with (out/'fresh-run.json').open('x') as f:
    json.dump({'runId':rid,'vmRunner':vmrunner,'runnerSha256':sha},f,indent=2)
check = remote('sudo test -f '+shlex.quote(vmrunner),timeout=30)
if check.returncode == 1:
    command = 'sudo install -d -o root -g root -m 0700 /root/fresh-backup && sudo sh -c '+shlex.quote('set -C; umask 077; cat > '+vmrunner)
    remote(command,input=runner.read_bytes(),check=True,timeout=30)
elif check.returncode != 0:
    raise SystemExit('Cannot determine staged runner state')
actual = remote('sudo sha256sum '+shlex.quote(vmrunner),capture_output=True,text=True,check=True,timeout=30).stdout.split()[0]
assert actual == sha
unit = 'enclave-indexd-fresh-backup-'+rid
command = ['sudo','systemd-run','--unit='+unit,'--collect','--wait','--quiet',
           '--property=RuntimeMaxSec=1500','--property=TimeoutStopSec=300','--property=KillMode=mixed',
           '/usr/bin/python3',vmrunner,'capture','--run-id',rid,'--confirm','fresh-backup','--expect-db-version','26',
           '--expect-binary-sha256','2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc',
           '--expect-geoip-sha256','18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933',
           '--quiesce-budget','600','--dump-timeout','300']
print(json.dumps({'runId':rid,'unit':unit,'action':'capture'}),flush=True)
with (out/'fresh-capture.out').open('x') as f:
    rc = remote(shlex.join(command),stdout=f,stderr=subprocess.STDOUT,timeout=1850).returncode
with (out/'fresh-status.out').open('x') as f:
    status_rc = remote(shlex.join(['sudo','python3',vmrunner,'status','--run-id',rid]),stdout=f,stderr=subprocess.STDOUT,timeout=60).returncode
with (out/'fresh-journal.out').open('x') as f:
    remote(shlex.join(['sudo','journalctl','-u',unit,'-o','cat','--no-pager']),stdout=f,stderr=subprocess.STDOUT,timeout=60)
print(json.dumps({'captureRc':rc,'statusRc':status_rc,'runId':rid}),flush=True)
sys.exit(rc or status_rc)
