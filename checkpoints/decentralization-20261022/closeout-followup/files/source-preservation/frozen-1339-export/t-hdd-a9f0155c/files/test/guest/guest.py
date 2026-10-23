"""Inside the throwaway KVM guest (guest root, no host privilege): the REAL kernel nbd driver, the REAL qemu-nbd -c client
over TLS through the test's relay, real ext4. Every outcome is recorded as observed; only the listed expectations are asserted."""
import hashlib
import json
import os
import shutil
import subprocess
import time

RES = []
ATTACH = ["python3", "-I", "/src/transport/hddattach.py"]


def rec(step, ok, **detail):
    RES.append({"step": step, "ok": bool(ok), **detail})
    print(json.dumps(RES[-1], sort_keys=True), flush=True)
    with open("/out/results.json", "w") as f:
        json.dump(RES, f, indent=1)


def run(argv, timeout=120):
    t = time.monotonic()
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).decode(errors="replace")[-1500:], round(time.monotonic() - t, 2)
    except subprocess.TimeoutExpired as e:
        return "timeout", str(e)[-300:], round(time.monotonic() - t, 2)


def tool(cmd, role, *extra, timeout=180):
    return run(ATTACH + [cmd, f"/etc/enclave-rpc-hdd/attach-{role}.json", *extra], timeout)


def refused(r, needle):
    return r[0] == 2 and needle in r[1]


def install(role):
    d = f"/etc/enclave-rpc-hdd/{role}/client"
    os.makedirs(d, mode=0o700)
    for f in ("ca-cert.pem", "client-cert.pem", "client-key.pem"):
        shutil.copyfile(f"/gin/creds/{role}/{f}", f"{d}/{f}")
        os.chmod(f"{d}/{f}", 0o600 if f.endswith("key.pem") else 0o644)
    shutil.copyfile(f"/gin/attach-{role}.json", f"/etc/enclave-rpc-hdd/attach-{role}.json")
    os.makedirs(f"/srv/rpc-hdd/{role}", exist_ok=True)


def set_uuid(role, u):
    p = f"/etc/enclave-rpc-hdd/attach-{role}.json"
    c = json.load(open(p))
    c["filesystem"]["uuid"] = u
    json.dump(c, open(p, "w"), indent=1)


def wait_file(name, limit):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if os.path.exists(f"/out/{name}"):
            return True
        time.sleep(0.5)
    return False


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def dmesg_tail():
    r = run(["dmesg"], 20)
    return [l for l in r[1].splitlines() if any(k in l for k in ("nbd", "EXT4", "I/O error", "Buffer I/O", "blk_update", "remount"))][-25:]


def main():
    # Fixture artifact: the HOST /usr is shared over 9p (security_model=none), so the setuid mount/umount appear owned by
    # the host user and would drop euid to it. Root-owned copies stand in for a normal VM's root-owned binaries.
    os.makedirs("/run/sbin", mode=0o755)
    for b in ("mount", "umount"):
        shutil.copyfile(f"/usr/bin/{b}", f"/run/sbin/{b}"); os.chmod(f"/run/sbin/{b}", 0o755)
    os.environ["PATH"] = "/run/sbin:/usr/bin"
    os.makedirs("/etc/enclave-rpc-hdd", mode=0o700)
    for role in ("l1", "base"):
        install(role)

    r = tool("check", "l1")
    rec("s01-nbd-module-absent-is-a-privilege-gate", refused(r, "privilege gate"), out=r[1][-300:])

    r = run(["insmod", "/mod/nbd.ko", "nbds_max=4"], 30)
    rec("s02-load-nbd-in-guest", r[0] == 0 and os.path.exists("/sys/block/nbd1"), out=r[1][-200:])
    nic = sorted(n for n in os.listdir("/sys/class/net") if n != "lo")[0]
    outs = [run(c, 20)[:2] for c in (["ip", "link", "set", "lo", "up"], ["ip", "link", "set", nic, "up"], ["ip", "addr", "add", "10.0.2.15/24", "dev", nic])]
    time.sleep(1)
    rec("s03-guest-net", all(o[0] == 0 for o in outs), nic=nic, cmds=outs, addr=run(["ip", "-br", "addr"], 10)[1])

    # l1: the host wrote a pattern at offset 0 through NBD, so this export is NOT blank and must never be formatted
    r = tool("attach", "l1")
    st = json.loads(r[1].strip().splitlines()[-1]) if r[0] == 0 else {}
    rec("s04a-l1-attach-real-kernel-nbd-over-tls", r[0] == 0, out=r[1][-600:])
    rec("s04b-guest-sees-rotational", "attached" in st, rotationalSeenByGuest=st.get("attached", {}).get("rotationalSeenByGuest"),
        note="what the guest kernel reports for the nbd device after attach; the backing is NVMe-hosted ext4 in this fixture")
    r = tool("first-format", "l1", "--i-am-formatting-a-new-export")
    rec("s04c-existing-data-is-never-formatted", refused(r, "not blank"), out=r[1][-300:])
    r = tool("detach", "l1")
    rec("s04d-l1-detach", r[0] == 0 and not os.path.exists("/sys/block/nbd0/pid"), out=r[1][-300:])

    # base: a fresh export: explicit first format, exact-UUID mount, persistence through detach/reattach
    r = tool("attach", "base")
    rec("s05a-base-attach", r[0] == 0, out=r[1][-400:])
    r = tool("first-format", "base")
    rec("s05b-format-needs-explicit-flag", refused(r, "--i-am-formatting-a-new-export"), out=r[1][-200:])
    r = tool("first-format", "base", "--i-am-formatting-a-new-export", timeout=300)
    fsuuid = json.loads(r[1].strip().splitlines()[-1]).get("uuid") if r[0] == 0 else None
    rec("s05c-first-format", r[0] == 0 and bool(fsuuid), out=r[1][-300:])
    r = tool("first-format", "base", "--i-am-formatting-a-new-export")
    rec("s05d-second-format-refused-signature", refused(r, "signature"), out=r[1][-300:])
    r = tool("mount", "base")
    rec("s06a-mount-needs-configured-uuid", refused(r, "not configured"), out=r[1][-200:])
    set_uuid("base", fsuuid)
    open("/srv/rpc-hdd/base/stray", "w").write("written into the bare mount point\n")
    r = tool("mount", "base")
    rec("s06b-bare-mountpoint-write-is-detected", refused(r, "not empty"), out=r[1][-200:])
    os.unlink("/srv/rpc-hdd/base/stray")
    r = tool("mount", "base")
    rec("s06c-mount-exact-uuid", r[0] == 0, out=r[1][-400:])
    r = tool("verify-mounted", "base")
    rec("s06d-verify-mounted", r[0] == 0, out=r[1][-300:])
    data = "/srv/rpc-hdd/base/data.bin"
    if tool("verify-mounted", "base")[0] != 0:
        rec("s07-write-16MiB-fsync", False, why="not writing: verify-mounted refused (a consumer must not write either)")
        return
    with open(data, "wb") as f:
        f.write(os.urandom(16 << 20)); f.flush(); os.fsync(f.fileno())
    digest = sha(data)
    rec("s07-write-16MiB-fsync", True, sha256=digest)
    r = tool("detach", "base")
    rec("s08a-detach-unmounts-and-disconnects", r[0] == 0 and not os.path.exists("/sys/block/nbd1/pid"), out=r[1][-300:])
    r = tool("verify-mounted", "base")
    rec("s08b-verify-mounted-refuses-when-detached", r[0] == 2, out=r[1][-200:])
    r1, r2 = tool("attach", "base"), tool("mount", "base")
    ok = r1[0] == 0 and r2[0] == 0 and sha(data) == digest
    rec("s09-reattach-data-persisted", ok, attach=r1[1][-200:], mount=r2[1][-200:])

    # export disconnect: the host stops the base export (owned stop) while the filesystem is mounted
    open("/out/ready-disconnect", "w").write("1")
    got = wait_file("disconnected", 120)
    rec("s10a-host-stopped-export", got)
    t = time.monotonic()
    w = run(["python3", "-c", "import os\nf=open('/srv/rpc-hdd/base/after.bin','wb')\nf.write(os.urandom(4<<20))\nf.flush()\nos.fsync(f.fileno())"], 120)
    rd = run(["dd", "if=/dev/nbd1", "of=/dev/null", "bs=1M", "count=1", "skip=64", "iflag=direct"], 120)
    mi = [l for l in open("/proc/self/mountinfo") if " /srv/rpc-hdd/base " in l]
    rec("s10b-io-after-disconnect-observed", w[0] != 0 or rd[0] != 0,
        fsyncWrite={"rc": w[0], "seconds": w[2], "tail": w[1][-300:]}, directRead={"rc": rd[0], "seconds": rd[2], "tail": rd[1][-300:]},
        mountinfo=mi, dmesg=dmesg_tail(), daemonAlive=os.path.exists("/sys/block/nbd1/pid"), elapsed=round(time.monotonic() - t, 2))
    r = tool("detach", "base", timeout=300)
    rec("s11a-detach-after-disconnect", r[0] == 0, rc=r[0], seconds=r[2], out=r[1][-500:],
        stillConnected=os.path.exists("/sys/block/nbd1/pid"), mounted=any(" /srv/rpc-hdd/base " in l for l in open("/proc/self/mountinfo")))
    if r[0] != 0:
        u = run(["umount", "/srv/rpc-hdd/base"], 120)
        d = tool("detach", "base", "--clear-stale", timeout=120)
        rec("s11b-second-cleanup-attempt", d[0] == 0, umount=u[:1] + u[2:], out=d[1][-400:])

    open("/out/ready-restart", "w").write("1")
    got = wait_file("restarted", 120)
    rec("s12a-host-restarted-export", got)
    r = tool("attach", "base")
    fsck = run(["e2fsck", "-n", "-f", "/dev/nbd1"], 300)
    rec("s12b-fsck-readonly-after-disconnect", r[0] == 0, attach=r[1][-200:], fsckRc=fsck[0], fsck=fsck[1][-700:])
    r = tool("mount", "base")
    ok = r[0] == 0 and os.path.exists(data) and sha(data) == digest
    rec("s12c-data-before-disconnect-intact", ok, mount=r[1][-300:], afterExists=os.path.exists("/srv/rpc-hdd/base/after.bin"),
        dmesg=dmesg_tail())
    r = tool("detach", "base")
    rec("s12d-final-detach", r[0] == 0 and not os.path.exists("/sys/block/nbd1/pid"), out=r[1][-300:])
    rec("done", all(x["ok"] for x in RES))


try:
    main()
except Exception as e:
    rec("guest-exception", False, error=repr(e))
