#!/usr/bin/env python3
"""Attach side: the NucBox Linux VM. It joins ONE authenticated export to ONE kernel NBD device and mounts its own filesystem.

  hddattach.py check          <attach.json>                              configuration, credentials, nbd device present
  hddattach.py attach         <attach.json>                              probe the export over TLS, then qemu-nbd -c, record OWNED
  hddattach.py first-format   <attach.json> --i-am-formatting-a-new-export   mkfs.ext4 ONLY on a device with no signature and zero ends
  hddattach.py mount          <attach.json>                              mount only the configured filesystem UUID on an empty mount point
  hddattach.py verify-mounted <attach.json>                              exit 0 only if the configured filesystem is mounted from the owned device
  hddattach.py verify-attached <attach.json>                             exit 0 only if the owned qemu-nbd connects the device at the stated size
  hddattach.py detach         <attach.json> [--clear-stale]              umount (never lazily), qemu-nbd -d, only for the owned device
  hddattach.py status         <attach.json>

Production runs this as root, because nbd needs CAP_SYS_ADMIN and the nbd kernel module. A missing /sys/block/nbdN is
refused as a privilege/module gate; this tool never loads modules itself.
"""
import json
import os
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Refused, refuse, load_json, want, abspath_plain, no_symlink_components, mount_at, mountinfo, literal_ip, port,
                    private_file, public_file, cert_facts, verify_chain, opt_value, owned_record, is_owned,
                    write_state_exclusive, read_state, emit, proc_identity)

FORMAT = "enclave-rpc-hdd-attach/v1"
FIELDS = {"format": False, "role": False, "server": False, "tls": False, "placement": False, "device": False,
          "filesystem": False, "mountPoint": False, "stateDir": False, "qemuNbd": False, "qemuImg": False}
PLACEMENT_KEYS = {"exportName", "imageBytes", "imagePath", "mountTarget", "fstype", "requireRotational",
                  "serverCertSha256", "caCertSha256"}


def validate(path):
    cfg = load_json(path, FORMAT, FIELDS)
    role, w = cfg["role"], path
    srv, tls, pl, fs = (want(cfg, k, dict, w) for k in ("server", "tls", "placement", "filesystem"))
    if set(srv) != {"address", "port", "serverName"} or set(tls) != {"dir"} or set(pl) != PLACEMENT_KEYS or set(fs) != {"label", "uuid"}:
        refuse(f"{w}: server{{address,port,serverName}}, tls{{dir}}, filesystem{{label,uuid}} and placement{sorted(PLACEMENT_KEYS)} exactly")
    literal_ip(srv["address"], f"{w}.server.address")
    port(srv["port"], f"{w}.server.port")
    opt_value(srv["serverName"], f"{w}.server.serverName")
    if not srv["serverName"].startswith(f"enclave-rpc-hdd-{role}."):
        refuse(f"{w}.server.serverName must start with enclave-rpc-hdd-{role}.")
    if pl["exportName"] != f"enclave-rpc-{role}" or fs["label"] != f"enc-rpc-{role}":
        refuse(f"{w}: a {role} attach must use export enclave-rpc-{role} and filesystem label enc-rpc-{role}")
    if not isinstance(pl["imageBytes"], int) or pl["imageBytes"] < (1 << 20) or pl["imageBytes"] % 512:
        refuse(f"{w}.placement.imageBytes must be the export's exact byte size")
    for k in ("serverCertSha256", "caCertSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(pl[k])):
            refuse(f"{w}.placement.{k} must be the 64-hex fingerprint from the export host's placement.json")
    if fs["uuid"] is not None and not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", str(fs["uuid"])):
        refuse(f"{w}.filesystem.uuid must be null (before first format) or the filesystem UUID")
    dev = cfg["device"]
    if not isinstance(dev, str) or not re.fullmatch(r"/dev/nbd[0-9]{1,2}", dev):
        refuse(f"{w}.device must be /dev/nbdN")
    mp = abspath_plain(cfg["mountPoint"], f"{w}.mountPoint")
    if not mp.endswith(f"/{role}") or mp.count("/") < 2:
        refuse(f"{w}.mountPoint must be a dedicated directory ending in /{role}")
    d = abspath_plain(tls["dir"], f"{w}.tls.dir")
    opt_value(d, f"{w}.tls.dir")
    for f in ("ca-cert.pem", "client-cert.pem"):
        public_file(os.path.join(d, f), f"{w}.tls.dir")
    private_file(os.path.join(d, "client-key.pem"), f"{w}.tls.dir")
    if os.path.lexists(os.path.join(d, "server-key.pem")) or os.path.lexists(os.path.join(d, "ca-key.pem")):
        refuse(f"{d} must hold only the client's credentials (found a server or CA key)")
    verify_chain(os.path.join(d, "ca-cert.pem"), os.path.join(d, "client-cert.pem"), "sslclient")
    ca = cert_facts(os.path.join(d, "ca-cert.pem"))
    if ca["sha256"] != pl["caCertSha256"]:
        refuse(f"{d}/ca-cert.pem is not the {role} export's CA recorded in the placement statement")
    cl = cert_facts(os.path.join(d, "client-cert.pem"))
    if f"CN=enclave-rpc-{role}-client" not in (cl["subject"] or ""):
        refuse(f"client certificate subject {cl['subject']} is not the {role} client identity")
    sd = abspath_plain(cfg["stateDir"], f"{w}.stateDir")
    for k in ("qemuNbd", "qemuImg"):
        if not os.access(abspath_plain(cfg[k], f"{w}.{k}"), os.X_OK):
            refuse(f"{cfg[k]} is not executable")
    return cfg


def nbd_opts(cfg):
    s, pl = cfg["server"], cfg["placement"]
    return (f"driver=nbd,server.type=inet,server.host={s['address']},server.port={s['port']},export={pl['exportName']},"
            f"tls-creds=tls0,tls-hostname={s['serverName']}")


def tls_object(cfg):
    return f"tls-creds-x509,id=tls0,endpoint=client,dir={cfg['tls']['dir']},verify-peer=on"


def sysblk(dev, leaf):
    try:
        with open(f"/sys/block/{os.path.basename(dev)}/{leaf}") as f:
            return f.read().strip()
    except OSError:
        return None


def need_nbd(dev):
    if not os.path.isdir(f"/sys/block/{os.path.basename(dev)}"):
        refuse(f"{dev} does not exist: the nbd kernel module is not loaded (privilege gate: root must `modprobe nbd`)")


def kernel_pid_in(dev, owner_pid):
    """The kernel records the pid/tid that runs NBD_DO_IT; it must belong to OUR qemu-nbd process."""
    kp = sysblk(dev, "pid")
    if kp is None:
        return None
    return int(kp) if (int(kp) == owner_pid or os.path.exists(f"/proc/{owner_pid}/task/{kp}")) else -int(kp)


def state_path(cfg):
    return os.path.join(cfg["stateDir"], "attach.json")


def owned_state(cfg, check_exe=True):
    st = read_state(state_path(cfg))
    if st is None:
        refuse("not attached by this tool (no state record)")
    if st.get("device") != cfg["device"] or not is_owned(st["proc"], check_exe):
        refuse(f"the recorded attachment is not live/owned (device {st.get('device')}, pid {st['proc'].get('pid')})")
    kp = kernel_pid_in(cfg["device"], st["proc"]["pid"])
    if kp is None or kp < 0:
        refuse(f"{cfg['device']} is not connected by the recorded qemu-nbd (kernel pid {kp})")
    return st


def probe_size(cfg):
    opts = nbd_opts(cfg)
    r = subprocess.run([cfg["qemuImg"], "info", "--output=json", "--object", tls_object(cfg), "--image-opts", opts],
                       capture_output=True, timeout=60)
    if r.returncode != 0:
        refuse(f"the export refused or failed TLS/authorization: {r.stderr.decode(errors='replace').strip()[:400]}")
    size = json.loads(r.stdout)["virtual-size"]
    if size != cfg["placement"]["imageBytes"]:
        refuse(f"the export is {size} bytes, not the placement statement's {cfg['placement']['imageBytes']}")
    return size


def cmd_attach(cfg):
    dev = cfg["device"]
    need_nbd(dev)
    if read_state(state_path(cfg)) is not None:
        refuse(f"{state_path(cfg)} exists; detach first (detach --clear-stale for a dead record)")
    if sysblk(dev, "pid") is not None or sysblk(dev, "size") not in ("0", None):
        refuse(f"{dev} is in use by another connection; this tool never takes over a device it did not attach")
    probe_size(cfg)
    os.makedirs(cfg["stateDir"], mode=0o700, exist_ok=True)
    pidf = os.path.join(cfg["stateDir"], "qemu-nbd.pid")
    if os.path.lexists(pidf):
        os.unlink(pidf)
    # qemu-nbd -c also listens on a control unix socket (default /var/lock/qemu-nbd-<dev>); keep it in OUR 0700 state dir
    sock = os.path.join(cfg["stateDir"], "qemu-nbd.sock")
    if len(sock) > 100:
        refuse(f"{sock} is longer than a unix socket path allows; use a shorter stateDir")
    if os.path.lexists(sock):
        refuse(f"{sock} exists: another attach may be live; nothing is replaced")
    opts = nbd_opts(cfg)
    argv = [cfg["qemuNbd"], "--object", tls_object(cfg), "--fork", f"--pid-file={pidf}", f"--socket={sock}",
            "--cache=none", "--aio=threads", "-c", dev, "--image-opts", opts]
    r = subprocess.run(argv, capture_output=True, timeout=60)
    if r.returncode != 0:
        refuse(f"qemu-nbd -c failed: {r.stderr.decode(errors='replace').strip()[:400]}")
    end = time.monotonic() + 15
    pid = None
    while time.monotonic() < end:
        try:
            pid = int(open(pidf).read().strip())
        except (OSError, ValueError):
            pid = None
        if pid and sysblk(dev, "pid"):
            break
        time.sleep(0.1)
    if not pid or proc_identity(pid) is None:
        refuse(f"qemu-nbd did not leave a running daemon for {dev}")
    rec = owned_record(pid, cfg["role"], f"qemu-nbd -c {dev}", argv)
    kp = kernel_pid_in(dev, pid)
    size = int(sysblk(dev, "size") or 0) * 512
    st = {"device": dev, "proc": rec, "kernelPid": kp, "bytes": size, "exportName": cfg["placement"]["exportName"],
          "server": cfg["server"], "rotationalSeenByGuest": sysblk(dev, "queue/rotational")}
    write_state_exclusive(state_path(cfg), st)
    if kp is None or kp < 0 or size != cfg["placement"]["imageBytes"]:
        refuse(f"{dev} attached but does not match (kernel pid {kp}, {size} bytes); run detach")
    emit({"attached": st})


def blkid(dev):
    r = subprocess.run(["blkid", "-p", "-o", "export", dev], capture_output=True, timeout=60)
    if r.returncode == 2:
        return {}
    if r.returncode != 0:
        refuse(f"blkid {dev} failed: {r.stderr.decode().strip()}")
    return dict(l.split("=", 1) for l in r.stdout.decode().splitlines() if "=" in l)


def cmd_first_format(cfg, argv):
    if "--i-am-formatting-a-new-export" not in argv:
        refuse("first-format needs --i-am-formatting-a-new-export")
    if cfg["filesystem"]["uuid"] is not None:
        refuse("the config already names a filesystem UUID: this export was formatted before and is never reformatted")
    st = owned_state(cfg)
    dev = st["device"]
    sig = blkid(dev)
    if sig:
        refuse(f"{dev} already carries a signature {sig}; existing data is never formatted")
    size = st["bytes"]
    with open(dev, "rb") as f:
        head = f.read(1 << 20)
        f.seek(size - (1 << 20))
        tail = f.read(1 << 20)
    if head.strip(b"\0") or tail.strip(b"\0"):
        refuse(f"{dev} is not blank at its first/last MiB; refusing to format")
    fsuuid = str(uuid.uuid4())
    r = subprocess.run(["mkfs.ext4", "-q", "-L", cfg["filesystem"]["label"], "-U", fsuuid, "-E", "nodiscard,lazy_itable_init=1", dev],
                       capture_output=True, timeout=3600)
    if r.returncode != 0:
        refuse(f"mkfs.ext4 failed: {r.stderr.decode().strip()[:300]}")
    emit({"formatted": dev, "uuid": fsuuid, "next": "set filesystem.uuid in the attach config to this value, then mount"})


def cmd_mount(cfg):
    st = owned_state(cfg)
    dev, mp, want_uuid = st["device"], cfg["mountPoint"], cfg["filesystem"]["uuid"]
    if want_uuid is None:
        refuse("filesystem.uuid is not configured; nothing is mounted by guesswork")
    sig = blkid(dev)
    if sig.get("TYPE") != "ext4" or sig.get("UUID") != want_uuid:
        refuse(f"{dev} holds {sig.get('TYPE')} {sig.get('UUID')}, not ext4 {want_uuid}")
    no_symlink_components(mp, "mountPoint")
    if not os.path.isdir(mp) or os.path.islink(mp):
        refuse(f"{mp} must be an existing directory")
    if mount_at(mp) is not None:
        refuse(f"{mp} is already a mount point")
    if os.listdir(mp):
        refuse(f"{mp} is not empty: something wrote into the bare mount point; investigate before mounting over it")
    r = subprocess.run(["mount", "-t", "ext4", "-o", "noatime,nodev,nosuid,errors=remount-ro", dev, mp], capture_output=True, timeout=120)
    if r.returncode != 0:
        refuse(f"mount failed: {r.stderr.decode().strip()[:300]}")
    emit({"mounted": verify(cfg)})


def verify(cfg):
    st = owned_state(cfg)
    m = mount_at(cfg["mountPoint"])
    if m is None:
        refuse(f"{cfg['mountPoint']} is not mounted")
    if m["fstype"] != "ext4" or os.path.realpath(m["source"]) != os.path.realpath(st["device"]):
        refuse(f"{cfg['mountPoint']} is {m['fstype']} from {m['source']}, not ext4 from {st['device']}")
    if blkid(st["device"]).get("UUID") != cfg["filesystem"]["uuid"]:
        refuse("mounted filesystem UUID is not the configured one")
    return {"mountPoint": cfg["mountPoint"], "device": st["device"], "uuid": cfg["filesystem"]["uuid"],
            "options": m["options"], "super": m["super"], "exportName": st["exportName"], "bytes": st["bytes"]}


def majmin_of(dev):
    st = os.stat(dev)
    return f"{os.major(st.st_rdev)}:{os.minor(st.st_rdev)}"


def holders(dev):
    try:
        return sorted(os.listdir(f"/sys/block/{os.path.basename(dev)}/holders"))
    except OSError:
        return []


def verify_attached(cfg, check_exe=True):
    """The RAW attachment only: this tool's live qemu-nbd connects the device, with the placement statement's exact size.
    Says nothing about mounts: in the composed storage layer the filesystem may be mounted through a cache mapping."""
    st = owned_state(cfg, check_exe)
    size = int(sysblk(st["device"], "size") or 0) * 512
    if size != cfg["placement"]["imageBytes"]:
        refuse(f"{st['device']} is {size} bytes, not the placement statement's {cfg['placement']['imageBytes']}")
    return {"device": st["device"], "bytes": size, "exportName": st["exportName"], "proc": st["proc"],
            "holders": holders(st["device"]), "role": cfg["role"]}


def cmd_detach(cfg, argv):
    sp = state_path(cfg)
    st = read_state(sp)
    dev = cfg["device"]
    if st is None:
        refuse(f"no attachment recorded in {sp}; nothing of someone else's is detached")
    if not is_owned(st["proc"]):
        if sysblk(dev, "pid") is not None:
            refuse(f"{dev} is connected by a process this tool did not record; not detached")
        if "--clear-stale" in argv:
            os.unlink(sp)
            sock = os.path.join(cfg["stateDir"], "qemu-nbd.sock")
            if os.path.lexists(sock):
                os.unlink(sock)
            emit({"detached": None, "clearedStaleRecord": st["proc"].get("pid")}); return
        refuse("recorded qemu-nbd is gone; use --clear-stale to drop the record")
    kp = kernel_pid_in(dev, st["proc"]["pid"])
    if kp is not None and kp < 0:
        refuse(f"{dev} is connected by kernel pid {-kp}, which is not the recorded qemu-nbd; not detached")
    held = holders(dev)
    if held:
        refuse(f"{dev} is still held by {held} (a cache mapping over it); stop the storage layer first; not detached")
    foreign = [x["target"] for x in mountinfo() if x["majmin"] == majmin_of(dev) and x["target"] != cfg["mountPoint"]]
    if foreign:
        refuse(f"{dev} is mounted at {foreign} (the storage layer's mount); stop the storage layer first; not detached")
    m = mount_at(cfg["mountPoint"])
    if m is not None and os.path.realpath(m["source"]) == os.path.realpath(dev):
        try:
            r = subprocess.run(["umount", cfg["mountPoint"]], capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            refuse(f"umount {cfg['mountPoint']} did not finish in 120 s; device left attached (no lazy unmount)")
        if r.returncode != 0:
            refuse(f"umount failed ({r.stderr.decode().strip()[:200]}); device left attached (no lazy unmount)")
    r = subprocess.run([cfg["qemuNbd"], "-d", dev], capture_output=True, timeout=60)
    end = time.monotonic() + 30
    while time.monotonic() < end and (is_owned(st["proc"]) or sysblk(dev, "pid") is not None):
        time.sleep(0.2)
    if sysblk(dev, "pid") is not None:
        refuse(f"{dev} still connected after qemu-nbd -d (rc {r.returncode}: {r.stderr.decode().strip()[:200]})")
    if is_owned(st["proc"]):
        os.kill(st["proc"]["pid"], 15)
        time.sleep(1)
    os.unlink(sp)
    sock = os.path.join(cfg["stateDir"], "qemu-nbd.sock")
    if os.path.lexists(sock) and not is_owned(st["proc"]):
        os.unlink(sock)      # our own daemon's control socket, left behind only after it exited
    emit({"detached": dev, "qemuNbdDisconnectRc": r.returncode, "daemonGone": not is_owned(st["proc"])})


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr); return 64
    cmd, path = argv[1], argv[2]
    try:
        cfg = validate(path)
        if cmd == "check":
            need_nbd(cfg["device"])
            emit({"ok": True, "device": cfg["device"], "export": cfg["placement"]["exportName"]})
        elif cmd == "attach":
            cmd_attach(cfg)
        elif cmd == "first-format":
            cmd_first_format(cfg, argv[3:])
        elif cmd == "mount":
            cmd_mount(cfg)
        elif cmd == "verify-mounted":
            emit({"ok": True, "verified": verify(cfg)})
        elif cmd == "verify-attached":
            emit({"ok": True, "attached": verify_attached(cfg)})
        elif cmd == "detach":
            cmd_detach(cfg, argv[3:])
        elif cmd == "status":
            st = read_state(state_path(cfg))
            emit({"record": st, "owned": bool(st) and is_owned(st["proc"]), "kernelPid": sysblk(cfg["device"], "pid")})
        else:
            print(__doc__, file=sys.stderr); return 64
    except Refused as e:
        emit({"ok": False, "refused": str(e)})
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
