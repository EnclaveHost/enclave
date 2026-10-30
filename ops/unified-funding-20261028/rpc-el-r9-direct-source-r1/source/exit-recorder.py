"""Public exit evidence, called only by the owned unit's bounded ExecStopPost.

Root credentials come from systemd's ! prefix, not a second signer or client
privilege change. The client retains its sandbox. /run survives unit GC, not
power loss. No environment or arbitrary argument list is emitted.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


def private_json(path, maximum=4096):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1
        raw=os.read(fd,maximum+1)
        assert len(raw)<=maximum
        return json.loads(raw)
    finally:os.close(fd)


def validate_exit(binding,info,parent,boot):
    assert binding['boot']==boot,'exit-boot'
    assert info['InvocationID']==binding['invocation'],'exit-invocation'
    assert info['Description']==binding['description'] and info['User']==binding['user'],'exit-owner'
    assert info['ControlGroup']==binding['cgroup'] and info['Transient']=='yes','exit-cgroup'
    assert info['ExecMainPID']==str(binding['pid']),'exit-main-pid'
    assert info['ExecMainStartTimestampMonotonic']==binding['mainStartMonotonic'],'exit-start'
    assert info['ControlPID']==str(parent['pid']) and parent['cgroup']=='0::'+binding['cgroup'],'exit-control-parent'
    assert parent['isTimeout'] and parent['argvMatches'],'exit-timeout-parent'
    assert info['ActiveState']=='deactivating' and info['SubState']=='stop-post','exit-manager-phase'
    assert info['Result'] in ('success','exit-code','signal','core-dump','watchdog','timeout','oom-kill','resources','protocol','start-limit-hit'),'exit-result'
    assert info['ExecMainCode'] in ('1','2','3'),'exit-code'
    assert info['ExecMainStatus'].isascii() and info['ExecMainStatus'].isdecimal() and int(info['ExecMainStatus'])<=255,'exit-status'
    return {'boot':boot,'nonce':binding['nonce'],'unit':binding['unit'],
            'invocation':binding['invocation'],'pid':binding['pid'],
            'startTicks':binding['startTicks'],'mainStartMonotonic':binding['mainStartMonotonic'],
            'cgroup':binding['cgroup'],'cgroupIdentity':binding['cgroupIdentity'],
            'Result':info['Result'],'ExecMainCode':info['ExecMainCode'],'ExecMainStatus':info['ExecMainStatus'],
            'controlPid':parent['pid'],'controlStartTicks':parent['startTicks'],
            'managerStopPostVerified':True,'at':time.time()}


def main():
    assert os.geteuid()==0 and len(sys.argv)==2 and sys.argv[1]=='el'
    root=Path(__file__).resolve().parent
    assert root==Path('/run/enclave-rpc-l1-client-r9')
    for path in (root,root/'exit-receipts'):
        st=path.lstat()
        assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
    binding=private_json(root/'exit-receipts/el-binding.json')
    assert binding['unit']=='enclave-rpc-l1-el-trial-r9.service'
    pp=os.getppid();proc=Path('/proc')/str(pp)
    raw=(proc/'stat').read_text();start=raw[raw.rfind(')')+2:].split()[19]
    expected=['/usr/bin/timeout','--signal=TERM','--kill-after=1','3','/usr/bin/python3','-I','-B',str(root/'exit-recorder.py'),'el']
    argv=(proc/'cmdline').read_bytes()
    assert len(argv)<=4096
    parent={'pid':pp,'startTicks':start,'cgroup':(proc/'cgroup').read_text().strip(),
            'isTimeout':os.stat(proc/'exe').st_ino==os.stat('/usr/bin/timeout').st_ino and os.stat(proc/'exe').st_dev==os.stat('/usr/bin/timeout').st_dev,
            'argvMatches':argv.split(b'\0')[:-1]==[x.encode() for x in expected]}
    fields=['InvocationID','Description','User','ControlGroup','Transient','ExecMainPID','ExecMainStartTimestampMonotonic',
            'ControlPID','ActiveState','SubState','Result','ExecMainCode','ExecMainStatus']
    result=subprocess.run(['/usr/bin/systemctl','show',binding['unit'],'--no-pager','--property='+','.join(fields)],
                          capture_output=True,timeout=1,text=True,check=True)
    assert len(result.stdout)<=8192 and not result.stderr
    info=dict(line.split('=',1) for line in result.stdout.splitlines())
    receipt=validate_exit(binding,info,parent,Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    raw=(proc/'stat').read_text()
    assert os.getppid()==pp and raw[raw.rfind(')')+2:].split()[19]==start
    st=(Path('/sys/fs/cgroup')/binding['cgroup'].lstrip('/')).stat()
    assert [st.st_dev,st.st_ino]==binding['cgroupIdentity']
    data=(json.dumps(receipt,sort_keys=True)+'\n').encode();assert len(data)<=4096
    fd=os.open(root/'exit-receipts/el-exit.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    fd=os.open(root/'exit-receipts',os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


if __name__=='__main__':main()
