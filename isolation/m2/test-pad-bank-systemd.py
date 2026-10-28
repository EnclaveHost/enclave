# Opt-in integration fixture: creates short-lived user systemd services and
# reserves at most 1 GiB of scratch. Does not launch QEMU or use a GPU.
import sys
if __name__ != '__main__' or sys.argv[1:] != ['--run']:
    raise SystemExit('Run explicitly with --run; requires a user systemd manager and >2 GiB free.')
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

helper = Path(__file__).resolve().with_name('pad-bank.py')
units = []
results = []

def call(args, **kw):
    return subprocess.run(args, text=True, capture_output=True, timeout=30, **kw)

def wait_empty(directory):
    deadline = time.monotonic() + 15
    while list(directory.glob('*.padbank*')):
        if time.monotonic() > deadline:
            raise AssertionError('pad was not reclaimed')
        time.sleep(.1)

with tempfile.TemporaryDirectory(prefix='test-') as tmp:
    directory = Path(tmp)
    def start(label, command, expect=True):
        tag = f'padguard{label}{os.getpid()}'
        unit = f'm2-{tag}-1.service'
        units.append(unit)
        post = call(['python3', str(helper), 'stop-command', '--directory', tmp, '--unit', unit], check=True).stdout.strip()
        args = ['systemd-run', '--user', '--unit='+unit, '--collect', '-q',
                '-p', 'Type=notify', '-p', 'NotifyAccess=main', '-p', 'TimeoutStartSec=20',
                '-p', 'MemoryMax=128M', '-p', 'CPUQuota=50%', '-p', 'TasksMax=32',
                '-p', 'ExecStopPost='+post, 'python3', str(helper), 'run',
                '--directory', tmp, '--tag', tag, '--unit', unit,
                '--gib', '1', '--max-gib', '1', '--reserve-gib', '1', '--', *command]
        p = call(args)
        if expect and p.returncode:
            raise AssertionError(p.stderr + call(['journalctl','--user','-u',unit,'-n','15','--no-pager']).stdout)
        if not expect and not p.returncode:
            raise AssertionError('over-cap launch unexpectedly succeeded')
        return unit, directory / (tag+'.padbank')

    try:
        t = time.monotonic()
        unit, pad = start('normal', ['/usr/bin/sleep', '60'])
        assert pad.stat().st_size == 1024**3 and pad.stat().st_blocks*512 >= 1024**3
        results.append(dict(check='fully_reserved_before_service_ready', seconds=time.monotonic()-t, passed=True))
        call(['python3', str(helper), 'reap', '--directory', tmp], check=True)
        assert pad.exists()
        results.append(dict(check='active_vm_protected_from_reaper', passed=True))
        start('overcap', ['/usr/bin/sleep', '60'], expect=False)
        assert pad.exists()
        results.append(dict(check='second_service_rejected_by_shared_cap', passed=True))
        call(['systemctl','--user','stop',unit], check=True)
        wait_empty(directory)
        results.append(dict(check='normal_stop_reclaims_pad', passed=True))
        unit, pad = start('killed', ['/usr/bin/sleep', '60'])
        call(['systemctl','--user','kill','--kill-whom=main','--signal=KILL',unit], check=True)
        wait_empty(directory)
        results.append(dict(check='sigkill_reclaims_pad', passed=True))
        unit, pad = start('killall', ['/usr/bin/sleep', '60'])
        call(['systemctl','--user','kill','--signal=KILL',unit], check=True)
        # Killing an entire cgroup can also kill ExecStopPost. The periodic
        # reaper must recover that case after the failed unit is collected.
        time.sleep(.5)
        call(['python3', str(helper), 'reap', '--directory', tmp], check=True)
        wait_empty(directory)
        results.append(dict(check='reaper_recovers_killed_cleanup_process', passed=True))
        unit, pad = start('badexec', ['/no-such-pad-test-program'])
        wait_empty(directory)
        results.append(dict(check='exec_failure_reclaims_pad', passed=True))
    finally:
        for unit in units:
            call(['systemctl','--user','stop',unit])
        call(['python3', str(helper), 'reap', '--directory', tmp], check=True)
        wait_empty(directory)
    print(json.dumps(results, indent=2))
