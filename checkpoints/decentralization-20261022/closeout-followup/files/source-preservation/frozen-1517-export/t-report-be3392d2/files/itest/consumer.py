#!/usr/bin/env python3
"""STAND-IN for a node process (NOT reth, Lighthouse or Base). It runs under the GENERATED node unit (drop-in replaces only
ExecStart), as that unit's User=, with its sandbox, Type=notify and dependencies.

Behaviour on I/O errors: it logs them and KEEPS RUNNING. It deliberately does not exit, so the test shows whether the
SUPERVISION (the bound watch unit) stops it. No claim is made here about how the real clients react to EIO.

  consumer.py <tag> <datadir>
    writes <datadir>/standin/<seq>.bin (512 KiB, content derived from seq), fsyncs it and the directory, then records seq
    in LAST (fsynced). After 30 files it keeps rewriting `tick` (4 KiB + fsync) every 0.5 s, so I/O is in flight when the
    export is lost.
"""
import hashlib
import os
import socket
import sys
import time

tag, datadir = sys.argv[1], sys.argv[2]
d = os.path.join(datadir, "standin")


def say(m):
    print(f"standin[{tag}] {m}", flush=True)


def notify(msg):
    a = os.environ.get("NOTIFY_SOCKET")
    if a:
        a = "\0" + a[1:] if a.startswith("@") else a
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.connect(a); s.sendall(msg.encode())


def content(n):
    return hashlib.sha256(f"{tag}:{n}".encode()).digest() * (512 * 1024 // 32)


def fsync_dir(p):
    fd = os.open(p, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


os.makedirs(d, exist_ok=True)
try:
    last = int(open(os.path.join(d, "LAST")).read())
except (OSError, ValueError):
    last = 0
say(f"start uid={os.getuid()} datadir={datadir} last={last}")
notify("READY=1")
n = last
while True:
    try:
        if n < last + 30 and n < 200:
            n += 1
            with open(os.path.join(d, f"{n:06d}.bin"), "wb") as f:
                f.write(content(n)); f.flush(); os.fsync(f.fileno())
            fsync_dir(d)
            with open(os.path.join(d, "LAST.tmp"), "w") as f:
                f.write(str(n)); f.flush(); os.fsync(f.fileno())
            os.replace(os.path.join(d, "LAST.tmp"), os.path.join(d, "LAST"))
            fsync_dir(d)
            say(f"synced {n}")
        else:
            with open(os.path.join(d, "tick"), "wb") as f:
                f.write(os.urandom(4096)); f.flush(); os.fsync(f.fileno())
    except OSError as e:
        say(f"IOERROR at seq {n}: {type(e).__name__} errno={e.errno} {e.strerror}; continuing (stand-in does not exit on EIO)")
    time.sleep(0.5)
