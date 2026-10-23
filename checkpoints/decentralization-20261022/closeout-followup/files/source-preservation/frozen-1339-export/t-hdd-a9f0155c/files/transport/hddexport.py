#!/usr/bin/env python3
"""Export side (the desktop that holds the HDD array): ONE new image file on the HDD mount, served by qemu-nbd over mutual TLS.

  hddexport.py check  <export.json>                       every check below; writes <stateDir>/placement.json
  hddexport.py create <export.json> --first-creation      create the image (O_EXCL: never overwrites); nothing else
  hddexport.py serve  <export.json>                       checks, then exec qemu-nbd in the foreground (systemd ExecStart)
  hddexport.py start  <export.json>                       checks, then launch qemu-nbd detached and record it as OWNED
  hddexport.py stop   <export.json> [--clear-stale]       signal ONLY the recorded process, and only if it is still it
  hddexport.py status <export.json>

Every command needs an explicit operator invocation. Nothing here formats a device, creates a filesystem or writes into
an existing file. Any check that fails refuses (exit 2) before qemu-nbd starts.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Refused, refuse, load_json, want, abspath_plain, no_symlink_components, mount_at, mount_containing,
                    whole_disk_of, read_sys, literal_ip, port, private_file, public_file, cert_facts, verify_chain,
                    authz_identity, opt_value, owned_record, is_owned, write_state_exclusive, read_state, emit)

FORMAT = "enclave-rpc-hdd-export/v1"
FIELDS = {"format": False, "role": False, "hdd": False, "image": False, "listen": False, "tls": False, "stateDir": False,
          "qemuNbd": False}
MAX_BYTES = 64 * 10**12


def validate(path, need_image=True):
    cfg = load_json(path, FORMAT, FIELDS)
    role = cfg["role"]
    w = f"{path}"
    hdd, img, listen, tls = (want(cfg, k, dict, w) for k in ("hdd", "image", "listen", "tls"))
    for obj, keys, name in ((hdd, {"mountPoint", "fsType", "devices", "requireRotational"}, "hdd"),
                            (img, {"path", "bytes", "allocation"}, "image"), (listen, {"address", "port"}, "listen"),
                            (tls, {"dir", "serverName", "clientIdentity"}, "tls")):
        if set(obj) != keys:
            refuse(f"{w}.{name} must have exactly {sorted(keys)}")

    # ---- role separation: the L1 and Base exports can never share an image, an export name or a client identity ----
    export_name = f"enclave-rpc-{role}"
    if os.path.basename(img["path"]) != f"{role}-origin.img":
        refuse(f"{w}.image.path: the {role} image must be named {role}-origin.img")
    # qemu 11.1.2 compares the DN in certificate order (observed: "authz check for O=Enclave RPC HDD,CN=... is denied")
    if tls["clientIdentity"] != f"O=Enclave RPC HDD,CN=enclave-rpc-{role}-client":
        refuse(f"{w}.tls.clientIdentity must be exactly O=Enclave RPC HDD,CN=enclave-rpc-{role}-client")
    if not str(tls["serverName"]).startswith(f"enclave-rpc-hdd-{role}."):
        refuse(f"{w}.tls.serverName must start with enclave-rpc-hdd-{role}.")
    authz_identity(tls["clientIdentity"])

    # ---- listen: one literal address, never a wildcard ----
    ip = literal_ip(listen["address"], f"{w}.listen.address")
    port(listen["port"], f"{w}.listen.port")

    # ---- the HDD mount: exact mount point, filesystem type and device identity ----
    mp = abspath_plain(hdd["mountPoint"], f"{w}.hdd.mountPoint")
    if mp == "/":
        refuse(f"{w}.hdd.mountPoint must not be /")
    no_symlink_components(mp, f"{w}.hdd.mountPoint")
    m = mount_at(mp)
    if m is None:
        refuse(f"{mp} is not a mount point right now: the HDD is not mounted, and a bare directory on the OS disk is never used")
    if m["fstype"] != hdd["fsType"]:
        refuse(f"{mp} is mounted as {m['fstype']}, not the configured {hdd['fsType']}")
    devs = hdd["devices"]
    if not isinstance(devs, list) or not devs or not all(isinstance(d, str) and (d.startswith("/dev/disk/by-uuid/") or d.startswith("/dev/disk/by-id/")) for d in devs):
        refuse(f"{w}.hdd.devices: one or more /dev/disk/by-uuid/... or /dev/disk/by-id/... names of the HDD filesystem")
    src = os.path.realpath(m["source"]) if m["source"].startswith("/dev/") else None
    for d in devs:
        if not os.path.exists(d) or os.path.realpath(d) != src:
            refuse(f"{mp} is mounted from {m['source']}, which is not {d}")
    disks = whole_disk_of(os.path.basename(src))
    rot = {dsk: read_sys(f"/sys/block/{dsk}/queue/rotational") for dsk in disks}
    models = {dsk: " ".join(filter(None, (read_sys(f"/sys/block/{dsk}/device/vendor"), read_sys(f"/sys/block/{dsk}/device/model")))) for dsk in disks}
    if hdd["requireRotational"] is not True:
        if not ip.is_loopback:
            refuse(f"{w}.hdd.requireRotational may be false only for a loopback-bound test fixture")
    elif not all(v == "1" for v in rot.values()):
        refuse(f"{mp} sits on {rot}: the kernel does not report rotational media for every backing disk")

    # ---- the image: a regular file on THAT mount, exactly the configured size ----
    ip_path = abspath_plain(img["path"], f"{w}.image.path")
    if not ip_path.startswith(mp.rstrip("/") + "/"):
        refuse(f"{w}.image.path must be under {mp}")
    opt_value(ip_path, f"{w}.image.path")
    nbytes = img["bytes"]
    if not isinstance(nbytes, int) or isinstance(nbytes, bool) or not (1 << 20) <= nbytes <= MAX_BYTES or nbytes % 512:
        refuse(f"{w}.image.bytes must be an integer multiple of 512 between 1 MiB and {MAX_BYTES}")
    if img["allocation"] not in ("sparse", "full"):
        refuse(f"{w}.image.allocation must be sparse or full")
    parent = os.path.dirname(ip_path)
    no_symlink_components(ip_path, f"{w}.image.path")
    mst = os.stat(mp)
    image = None
    if os.path.lexists(ip_path):
        st = os.lstat(ip_path)
        if not os.path.isfile(ip_path) or os.path.islink(ip_path):
            refuse(f"{ip_path} is not a regular file")
        if st.st_dev != mst.st_dev or mount_containing(ip_path)["id"] != m["id"]:
            refuse(f"{ip_path} is not on the {mp} filesystem")
        if st.st_size != nbytes:
            refuse(f"{ip_path} is {st.st_size} bytes, not the configured {nbytes}")
        # ntfs3 maps every file to its mount's uid= and fmask=, so group/other READ may be unavoidable there; WRITE never is
        if st.st_nlink != 1 or st.st_uid != os.geteuid() or st.st_mode & 0o022:
            refuse(f"{ip_path} must have one link, be owned by this service user and not be group/other writable")
        image = {"path": ip_path, "inode": st.st_ino, "dev": st.st_dev, "bytes": st.st_size, "allocatedBytes": st.st_blocks * 512}
    elif need_image:
        refuse(f"{ip_path} does not exist; it is created only by an explicit `create --first-creation`")
    if os.path.lexists(parent):
        pst = os.stat(parent)
        if pst.st_dev != mst.st_dev or mount_containing(parent)["id"] != m["id"]:
            refuse(f"{parent} is not on the {mp} filesystem")

    # ---- TLS: the server's own key and its CA; never a client or CA key ----
    d = abspath_plain(tls["dir"], f"{w}.tls.dir")
    opt_value(d, f"{w}.tls.dir")
    for f in ("ca-cert.pem", "server-cert.pem"):
        public_file(os.path.join(d, f), f"{w}.tls.dir")
    if os.path.lexists(os.path.join(d, "dh-params.pem")):
        refuse(f"{d}/dh-params.pem: qemu 11.1.2 deprecates external DH parameters; remove it")
    private_file(os.path.join(d, "server-key.pem"), f"{w}.tls.dir")
    if os.path.lexists(os.path.join(d, "client-key.pem")) or os.path.lexists(os.path.join(d, "ca-key.pem")):
        refuse(f"{d} must hold only the server's credentials (found a client or CA key)")
    verify_chain(os.path.join(d, "ca-cert.pem"), os.path.join(d, "server-cert.pem"), "sslserver")
    sf, cf = cert_facts(os.path.join(d, "server-cert.pem")), cert_facts(os.path.join(d, "ca-cert.pem"))
    if f"DNS:{tls['serverName']}" not in sf["text"]:
        refuse(f"server certificate does not name {tls['serverName']} in its subjectAltName")
    if "Certificate will not expire" not in sf["text"]:
        refuse("server certificate is expired")

    sd = abspath_plain(cfg["stateDir"], f"{w}.stateDir")
    sst = os.lstat(sd) if os.path.lexists(sd) else None
    if sst is None or not os.path.isdir(sd) or os.path.islink(sd) or sst.st_uid != os.geteuid() or sst.st_mode & 0o077:
        refuse(f"{w}.stateDir {sd} must be an existing 0700 directory owned by this service user")
    q = abspath_plain(cfg["qemuNbd"], f"{w}.qemuNbd")
    if not os.access(q, os.X_OK):
        refuse(f"{q} is not executable")

    placement = {
        "format": "enclave-rpc-hdd-placement/v1", "role": role, "exportName": export_name, "image": image,
        "imageBytes": nbytes, "mount": {"target": mp, "fstype": m["fstype"], "source": m["source"], "devices": devs, "mountId": m["id"]},
        "disks": {"wholeDisks": disks, "rotational": rot, "models": models, "requireRotational": hdd["requireRotational"]},
        "serverName": tls["serverName"], "serverCertSha256": sf["sha256"], "caCertSha256": cf["sha256"],
        "clientIdentity": tls["clientIdentity"], "listen": {"address": str(ip), "port": listen["port"]},
        "note": "a statement made by this export host from its own mount table and sysfs; not cryptographic proof of physical media",
    }
    return cfg, placement


def qemu_argv(cfg):
    tls, listen, img = cfg["tls"], cfg["listen"], cfg["image"]
    return [cfg["qemuNbd"],
            "--object", f"tls-creds-x509,id=tls0,endpoint=server,dir={tls['dir']},verify-peer=on",
            "--object", f"authz-simple,id=authz0,identity={authz_identity(tls['clientIdentity'])}",
            "--tls-creds=tls0", "--tls-authz=authz0",
            f"--bind={listen['address']}", f"--port={listen['port']}", f"--export-name=enclave-rpc-{cfg['role']}",
            "--shared=1", "--persistent", "--handshake-limit=10",
            "--cache=writeback", "--aio=threads", "--discard=unmap", "--detect-zeroes=off",
            "--image-opts", f"driver=raw,file.driver=file,file.filename={img['path']},file.locking=on"]


def write_placement(cfg, placement):
    p = os.path.join(cfg["stateDir"], "placement.json")
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(placement, f, indent=1, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)
    return p


def cmd_create(path, argv):
    if "--first-creation" not in argv:
        refuse("create needs --first-creation: it is the one explicit step that allocates the image")
    cfg, _ = validate(path, need_image=False)
    img = cfg["image"]
    if os.path.lexists(img["path"]):
        refuse(f"{img['path']} already exists; existing backing data is never overwritten")
    mp = cfg["hdd"]["mountPoint"]
    parent = os.path.dirname(img["path"])
    if not os.path.isdir(parent):
        if os.path.dirname(parent) != mp.rstrip("/"):
            refuse(f"{parent} does not exist; only one directory level directly under {mp} is created")
        os.mkdir(parent, 0o700)
    if os.stat(parent).st_dev != os.stat(mp).st_dev:
        refuse(f"{parent} is not on {mp}")
    vfs = os.statvfs(parent)
    if vfs.f_bavail * vfs.f_frsize < img["bytes"]:
        refuse(f"{mp} has {vfs.f_bavail * vfs.f_frsize} bytes available, less than the image's {img['bytes']}")
    fd = os.open(img["path"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    st = os.fstat(fd)
    try:
        if img["allocation"] == "sparse":
            os.ftruncate(fd, img["bytes"])
        else:
            os.close(fd); fd = None
            r = subprocess.run(["fallocate", "-l", str(img["bytes"]), img["path"]], capture_output=True, timeout=3600)
            if r.returncode != 0:
                raise OSError(r.stderr.decode().strip())
        if fd is not None:
            os.fsync(fd)
    except OSError as e:
        # only the file THIS call created (same inode) is removed
        if os.lstat(img["path"]).st_ino == st.st_ino:
            os.unlink(img["path"])
        refuse(f"could not allocate {img['path']}: {e}")
    finally:
        if fd is not None:
            os.close(fd)
    cfg, placement = validate(path, need_image=True)
    write_state_exclusive(os.path.join(cfg["stateDir"], f"created-{placement['image']['inode']}.json"),
                          {"created": placement["image"], "allocation": img["allocation"], "at": time.time()})
    emit({"created": placement["image"], "placement": write_placement(cfg, placement)})


def wait_port(addr, prt, proc, limit=15):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if proc.poll() is not None:
            return False
        try:
            with socket.create_connection((addr, prt), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def cmd_start(path):
    cfg, placement = validate(path)
    write_placement(cfg, placement)
    sp = os.path.join(cfg["stateDir"], "server.json")
    rec = read_state(sp)
    if rec is not None:
        refuse(f"{sp} exists ({'running' if is_owned(rec) else 'stale'}); stop it first (stop --clear-stale for a dead record)")
    argv = qemu_argv(cfg)
    log = open(os.path.join(cfg["stateDir"], "qemu-nbd.log"), "ab")
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    rec = owned_record(proc.pid, cfg["role"], "qemu-nbd export", argv)
    write_state_exclusive(sp, rec)
    if not wait_port(cfg["listen"]["address"], cfg["listen"]["port"], proc):
        code = proc.poll()
        if code is None and is_owned(rec):
            os.kill(proc.pid, signal.SIGTERM)
            proc.wait(10)
        os.unlink(sp)
        refuse(f"qemu-nbd did not start listening (exit {proc.poll()}); see {cfg['stateDir']}/qemu-nbd.log")
    emit({"started": rec, "listen": placement["listen"], "exportName": placement["exportName"]})


def stop_owned(rec, sp, timeout=10.0):
    """SIGTERM, then SIGKILL, and each signal only after re-checking that the pid is still the recorded process."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not is_owned(rec):
            break
        os.kill(rec["pid"], sig)
        end = time.monotonic() + timeout
        while time.monotonic() < end and is_owned(rec):
            time.sleep(0.1)
    if is_owned(rec):
        refuse(f"pid {rec['pid']} survived SIGKILL; state kept at {sp}")
    os.unlink(sp)


def cmd_stop(path, argv):
    cfg = load_json(path, FORMAT, FIELDS)
    sd = abspath_plain(cfg["stateDir"], "stateDir")
    sp = os.path.join(sd, "server.json")
    rec = read_state(sp)
    if rec is None:
        emit({"stopped": None, "why": "no recorded server"}); return
    if is_owned(rec):
        stop_owned(rec, sp)
        emit({"stopped": rec["pid"]}); return
    # not ours any more (dead, or the pid now belongs to another process): never signal it
    if "--clear-stale" in argv:
        os.unlink(sp)
        emit({"stopped": None, "clearedStaleRecord": rec["pid"], "signalled": False}); return
    refuse(f"recorded pid {rec.get('pid')} is not the recorded qemu-nbd (dead or reused); nothing signalled; use --clear-stale to drop the record")


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr); return 64
    cmd, path = argv[1], argv[2]
    try:
        if cmd == "check":
            cfg, placement = validate(path)
            emit({"ok": True, "placement": placement, "written": write_placement(cfg, placement)})
        elif cmd == "create":
            cmd_create(path, argv[3:])
        elif cmd == "serve":
            cfg, placement = validate(path)
            write_placement(cfg, placement)
            a = qemu_argv(cfg)
            os.execv(a[0], a)
        elif cmd == "start":
            cmd_start(path)
        elif cmd == "stop":
            cmd_stop(path, argv[3:])
        elif cmd == "status":
            cfg = load_json(path, FORMAT, FIELDS)
            rec = read_state(os.path.join(abspath_plain(cfg["stateDir"], "stateDir"), "server.json"))
            emit({"record": rec, "owned": bool(rec) and is_owned(rec)})
        else:
            print(__doc__, file=sys.stderr); return 64
    except Refused as e:
        emit({"ok": False, "refused": str(e)})
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
