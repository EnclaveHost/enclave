#!/usr/bin/env python3
"""Actual private-namespace PID1 serving guard. No production boot/reboot.
An external controller preholds exact pidfds; it owns the test-only capability.
No inferred death from transport exit. Original guardian poweroff is unmocked.
"""
import array,json,os,select,signal,socket,struct,subprocess,sys,time
from pathlib import Path
from qualify_boot_guardian import dead,exact_pid

def frame(op,origin,deadline,observed,expiry=0,seq=0,digest=b'Q'*32):
    return b'ERPCSV01'+bytes([op])+b'\0'*7+struct.pack('<QQQQQ',origin,deadline,observed,expiry,seq)+digest

def case(binary,mode):
    a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);a.settimeout(2)
    cmd=['/usr/bin/bwrap','--unshare-all','--as-pid-1','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--cap-add','CAP_SYS_BOOT','--ro-bind',str(binary),'/fixture','--proc','/proc','--dev','/dev','/fixture','serving-'+mode,'600']
    start=time.monotonic_ns();proc=subprocess.Popen(cmd,stdin=b,stdout=subprocess.PIPE,stderr=subprocess.PIPE);b.close()
    held={};observations={};channel=None;origin=deadline=None
    try:
        while set(held)!={'G','W','D'} or channel is None or deadline is None:
            data,anc,flags,_=a.recvmsg(128,socket.CMSG_SPACE(4))
            assert data and not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC)
            if len(data)==16:
                assert not anc and deadline is None
                origin,deadline=struct.unpack('=QQ',data);continue
            assert len(data)==1 and len(anc)==1
            level,kind,raw=anc[0];assert (level,kind,len(raw))==(socket.SOL_SOCKET,socket.SCM_RIGHTS,4)
            v=array.array('i');v.frombytes(raw);fd=v[0];role=data.decode()
            if role=='H':
                assert channel is None;channel=socket.socket(fileno=fd);channel.settimeout(.3)
                assert channel.type==socket.SOCK_SEQPACKET
            else:
                assert role in {'G','W','D'} and role not in held
                held[role]=fd;observations[role]={'pid':exact_pid(fd),'atNs':time.monotonic_ns()}
        assert deadline==origin+900_000_000_000
        limits=Path(f"/proc/{observations['G']['pid']}/limits").read_text()
        cap=next(x for x in limits.splitlines() if x.startswith('Max address space')).split()
        assert int(cap[-3])<=32<<20 and int(cap[-2])<=32<<20
        observed=time.monotonic_ns();assert observed<deadline
        def exchange(raw):
            assert channel.send(raw)==88
            ack=channel.recv(89);assert ack==raw[:8]+bytes([raw[8]|0x80])+raw[9:]
        prepare=frame(1,origin,deadline,observed)
        exchange(prepare);until=deadline;signal_ns=None
        if mode=='prepare-only': pass
        elif mode=='wrong-digest':
            channel.send(frame(2,origin,deadline,observed,observed+1_200_000_000,1,b'X'*32))
        elif mode=='oversized':channel.send(prepare+b'!')
        elif mode=='queued-late-commit':
            signal.pidfd_send_signal(held['G'],signal.SIGSTOP)
            channel.send(frame(2,origin,deadline,observed,observed+1_200_000_000,1))
            time.sleep(max(0,(deadline-time.monotonic_ns())/1e9)+.02)
            signal.pidfd_send_signal(held['G'],signal.SIGCONT)
        elif mode=='late-commit':
            # Never submit a revival after the exact original guard has died.
            time.sleep(max(0,(deadline-time.monotonic_ns())/1e9)+.02)
        else:
            until=observed+1_200_000_000
            commit=frame(2,origin,deadline,observed,until,1);exchange(commit)
            if mode=='renew-expiry':
                until+=200_000_000;exchange(frame(3,origin,deadline,observed,until,2))
            elif mode=='queued-late-renew':
                signal.pidfd_send_signal(held['G'],signal.SIGSTOP)
                channel.send(frame(3,origin,deadline,observed,until+500_000_000,2))
                time.sleep(max(0,(until-time.monotonic_ns())/1e9)+.02)
                signal.pidfd_send_signal(held['G'],signal.SIGCONT)
            elif mode=='replay-commit':channel.send(commit)
            elif mode=='channel-loss':channel.close();channel=None
            elif mode=='guardian-loss':
                signal_ns=time.monotonic_ns();signal.pidfd_send_signal(held['G'],signal.SIGKILL)
            elif mode=='blocked-worker':signal.pidfd_send_signal(held['W'],signal.SIGSTOP)
            elif mode!='commit-expiry':raise AssertionError(mode)
        wait_by=time.monotonic()+2
        while not all(dead(fd) for fd in held.values()):
            assert time.monotonic()<wait_by,'exact actors still alive'
            time.sleep(.002)
        terminal=time.monotonic_ns();out,err=proc.communicate(timeout=1)
        assert proc.returncode==(137 if mode=='guardian-loss' else 130),(mode,proc.returncode,out,err)
        if mode in ('prepare-only','late-commit','commit-expiry','renew-expiry','blocked-worker','queued-late-commit','queued-late-renew'):
            assert until<=terminal<=until+300_000_000,(mode,terminal,until)
            if mode in ('commit-expiry','renew-expiry','blocked-worker','queued-late-commit','queued-late-renew'):assert terminal>deadline
        else:assert terminal<deadline,'refusal/loss waited for original cutoff'
        return {'mode':mode,'pass':True,'originNs':origin,'originalDeadlineNs':deadline,'observedNs':observed,'expiryNs':until,'allExactHandlesDeadNs':terminal,'actors':observations,'signalNs':signal_ns,'elapsedNs':terminal-start,'exit':proc.returncode,'rebootMocked':False,'production':False}
    finally:
        a.close()
        if channel is not None:channel.close()
        if proc.poll() is None:proc.kill();proc.wait(timeout=1)
        for fd in held.values():os.close(fd)

def main():
    with Path(sys.argv[2]).open('x') as out:
        modes=('prepare-only','commit-expiry','renew-expiry','wrong-digest','oversized','replay-commit','late-commit','channel-loss','guardian-loss','blocked-worker','queued-late-commit','queued-late-renew')
        selected=sys.argv[3].split(',') if len(sys.argv)>3 else modes
        assert selected and len(set(selected))==len(selected) and all(x in modes for x in selected)
        for mode in selected:
            row=case(Path(sys.argv[1]).resolve(),mode);out.write(json.dumps(row)+'\n');out.flush();os.fsync(out.fileno());print(json.dumps(row),flush=True)
if __name__=='__main__':main()
