"""Bounded pipes to one live signer; no keys, restart or death claim.

The caller persists the submission before construction. systemd independently
bounds the remote signer; closing/killing this local transport is NOT evidence
of signer death, export fencing, or permission to resubmit.
"""
import os
import select
import struct
import subprocess
import time


class LiveSigner:
    def __init__(self,args,deadline):
        self.deadline=deadline
        self.errors=0
        self.closed=False
        self.proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for pipe in (self.proc.stdin,self.proc.stdout,self.proc.stderr):os.set_blocking(pipe.fileno(),False)

    def _ready(self,reads,writes,deadline):
        if self.closed or self.proc.poll() is not None:raise ValueError('Original signer transport lost')
        left=min(deadline,self.deadline)-time.monotonic()
        if left<=0:raise TimeoutError('Original signer exchange expired; held')
        out=self.proc.stdout.fileno();err=self.proc.stderr.fileno()
        ready,writable,_=select.select(list(set(reads)|{out,err}),writes,[],min(.05,left))
        if err in ready:
            chunk=os.read(err,8193);self.errors+=len(chunk)
            if not chunk or self.errors>8192:raise ValueError('Signer error stream closed or exceeded bound')
            ready.remove(err)
        if out in ready and out not in reads:
            # Even one unsolicited byte or EOF ends the session while idle or
            # writing a new request. Never buffer a speculative next response.
            raise ValueError('Unsolicited signer output or signer loss')
        return ready,writable

    def check(self):
        self._ready([],[],time.monotonic()+.001)

    def _read(self,fd,size,deadline):
        data=bytearray()
        while len(data)<size:
            ready,_=self._ready([fd],[],deadline)
            if fd not in ready:continue
            try:chunk=os.read(fd,min(65536,size-len(data)))
            except (BlockingIOError,InterruptedError):continue
            if not chunk:raise ValueError('Original stream EOF; held')
            data.extend(chunk)
        return bytes(data)

    def read_peer(self,fd,maximum,deadline):
        first=self._read(fd,1,deadline)
        deadline=min(deadline,time.monotonic()+3)
        size=struct.unpack('!I',first+self._read(fd,3,deadline))[0]
        if not 0<size<=maximum:raise ValueError('Bounded continuation request required')
        # A partial header/body gets only the transaction window, not a new
        # idle allowance. The outer service also enforces originalD.
        return self._read(fd,size,min(deadline,time.monotonic()+3))

    def send_peer(self,fd,raw,deadline):
        if not 0<len(raw)<=65536:raise ValueError('Bounded peer response required')
        data=memoryview(struct.pack('!I',len(raw))+raw)
        while data:
            _,ready=self._ready([], [fd],deadline)
            if fd not in ready:continue
            try:n=os.write(fd,data)
            except (BlockingIOError,InterruptedError):continue
            if n<=0:raise ValueError('Peer response write lost; held')
            data=data[n:]

    def exchange(self,raw,maximum,deadline):
        if not isinstance(raw,bytes) or not 0<len(raw)<=4<<20:raise ValueError('Bounded original signer input required')
        data=memoryview(struct.pack('!I',len(raw))+raw);fd=self.proc.stdin.fileno()
        while data:
            _,ready=self._ready([], [fd],deadline)
            if fd not in ready:continue
            try:n=os.write(fd,data[:65536])
            except (BlockingIOError,InterruptedError):continue
            if n<=0:raise ValueError('Signer write lost; held')
            data=data[n:]
        out=self.proc.stdout.fileno()
        size=struct.unpack('!I',self._read(out,4,deadline))[0]
        if not 0<size<=maximum:raise ValueError('Bounded signer response required')
        return self._read(out,size,deadline)

    def close(self):
        if self.closed:return
        self.closed=True
        # Only this exact Popen child is touched. No unit scan or inferred remote
        # cancellation; the consumed attempt remains held even after local exit.
        for pipe in (self.proc.stdin,self.proc.stdout,self.proc.stderr):pipe.close()
        if self.proc.poll() is None:self.proc.kill()
        self.proc.wait(timeout=1)
