"""Host side of the integration test. Run ONLY via test/run.sh, which runs it inside `unshare --user --map-root-user --mount`
(an unprivileged user+mount namespace with the host network, so every listener is on 127.0.0.1).

What is real:
- qemu-nbd 11.1.2 servers with x509 mutual TLS and authz;
- qemu-io and qemu-img NBD clients;
- openssl/certtool certificates;
- a bind mount of an owned directory on the real ext4 root filesystem standing in for the HDD mount;
- the kernel's real sysfs rotational flags.

The KVM guest adds the real kernel nbd driver and ext4.

What is NOT real here: ntfs3 and the USB RAID. The positive fixture uses `requireRotational: false`, which the tool accepts
ONLY for a loopback-bound export.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = sys.argv[1]
OUT = os.path.join(RUN, "out")
CAP = 512 << 20
EXPORT = ["python3", "-I", f"{REPO}/transport/hddexport.py"]
PKI = ["python3", "-I", f"{REPO}/transport/pki.py"]
RES = []
QEMU_NBD = shutil.which("qemu-nbd")


def rec(step, ok, **d):
    RES.append({"step": step, "ok": bool(ok), **d})
    print(json.dumps(RES[-1], sort_keys=True), flush=True)
    with open(f"{OUT}/host-results.json", "w") as f:
        json.dump(RES, f, indent=1)


def run(argv, timeout=60, **kw):
    t = time.monotonic()
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout, **kw)
        return r.returncode, (r.stdout + r.stderr).decode(errors="replace")[-2000:], round(time.monotonic() - t, 2)
    except subprocess.TimeoutExpired:
        return "timeout", "", round(time.monotonic() - t, 2)


def alloc():
    return int(subprocess.run(["du", "-s", "--block-size=1", RUN], capture_output=True).stdout.split()[0])


def check_cap(tag):
    a = alloc()
    rec(f"cap-{tag}", a <= CAP, allocatedBytes=a, capBytes=CAP)
    if a > CAP:
        sys.exit(4)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def wjson(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)


def export_cfg(role, mp, img_name, nbytes, prt, tlsdir, state, devices, fstype="ext4", rot=False, addr="127.0.0.1", ident=None):
    return {"format": "enclave-rpc-hdd-export/v1", "role": role,
            "hdd": {"mountPoint": mp, "fsType": fstype, "devices": devices, "requireRotational": rot},
            "image": {"path": f"{mp}/enclave-rpc/{img_name}", "bytes": nbytes, "allocation": "sparse"},
            "listen": {"address": addr, "port": prt},
            "tls": {"dir": tlsdir, "serverName": f"enclave-rpc-hdd-{role}.test", "clientIdentity": ident[role]},
            "stateDir": state, "qemuNbd": QEMU_NBD}


def qio(creds, prt, export, host_name, *cmds, timeout=30, tls=True):
    opts = f"driver=nbd,server.type=inet,server.host=127.0.0.1,server.port={prt},export={export}"
    argv = ["qemu-io"]
    if tls:
        argv += ["--object", f"tls-creds-x509,id=tls0,endpoint=client,dir={creds},verify-peer=on"]
        opts += f",tls-creds=tls0,tls-hostname={host_name}"
    argv += ["--image-opts", opts]
    for c in cmds:
        argv += ["-c", c]
    return run(argv, timeout)


def ok_io(r):
    return r[0] == 0 and "Failed" not in r[1] and "error" not in r[1].lower()


def main():
    os.makedirs(OUT, exist_ok=True)
    rec("namespace", os.geteuid() == 0, uid=os.geteuid(), note="user-namespace root mapped to the invoking user; no host privilege")
    check_cap("start")

    # ---- the stand-in HDD mount: a REAL bind mount of an owned directory on the real root filesystem ----
    backing, mp = f"{RUN}/hdd-backing", f"{RUN}/mnt-hdd"
    os.makedirs(backing); os.makedirs(mp); os.makedirs(f"{RUN}/bare-dir")
    r = run(["mount", "--bind", backing, mp])
    src = os.path.realpath(next(m.split(" - ")[1].split()[1] for m in open("/proc/self/mountinfo") if m.split()[4] == mp))
    byuuid = next(f"/dev/disk/by-uuid/{n}" for n in sorted(os.listdir("/dev/disk/by-uuid")) if os.path.realpath(f"/dev/disk/by-uuid/{n}") == src)
    other = next(f"/dev/disk/by-uuid/{n}" for n in sorted(os.listdir("/dev/disk/by-uuid")) if os.path.realpath(f"/dev/disk/by-uuid/{n}") != src)
    rec("fixture-bind-mount", r[0] == 0, source=src, byUuid=byuuid)

    # ---- PKI through the real tool: one private CA per role, plus a rogue CA ----
    pki = f"{RUN}/pki"; os.makedirs(pki)
    ident = {}
    for role in ("l1", "base"):
        run(PKI + ["init-ca", "--role", role, "--ca", f"{pki}/ca-{role}"])
        run(PKI + ["issue-server", "--role", role, "--ca", f"{pki}/ca-{role}", "--name", f"enclave-rpc-hdd-{role}.test", "--ip", "127.0.0.1", "--out", f"{pki}/server-{role}"])
        run(PKI + ["client-key", "--role", role, "--out", f"{pki}/client-{role}"])
        r = run(PKI + ["sign-client", "--role", role, "--ca", f"{pki}/ca-{role}", "--csr", f"{pki}/client-{role}/client.csr", "--out", f"{pki}/client-{role}.crt"])
        ident[role] = r[1].split("clientIdentity (export config tls.clientIdentity): ")[-1].strip()
        if role == "base":   # the l1 CA must refuse to sign the base client's CSR (exact role subject)
            x = run(PKI + ["sign-client", "--role", "l1", "--ca", f"{pki}/ca-l1", "--csr", f"{pki}/client-base/client.csr", "--out", f"{pki}/x.crt"])
            rec("pki-sign-refuses-wrong-role-csr", x[0] != 0 and not os.path.exists(f"{pki}/x.crt"), out=x[1][-200:])
        run(PKI + ["install-client", "--role", role, "--cert", f"{pki}/client-{role}.crt", "--ca-cert", f"{pki}/ca-{role}/ca-cert.pem", "--dir", f"{pki}/client-{role}"])
    run(PKI + ["init-ca", "--role", "l1", "--ca", f"{pki}/ca-rogue"])
    rec("pki", all(os.path.isfile(f"{pki}/client-{x}/client-cert.pem") for x in ident), clientIdentity=ident)

    def client_dir(name, ca, key_from=None, subject=None):
        """Fixture clients that pki.py refuses to make: a rogue-CA client, a wrong-DN client, a cert-less client."""
        d = f"{pki}/{name}"; os.makedirs(d, mode=0o700)
        shutil.copyfile(f"{pki}/{ca}/ca-cert.pem" if ca else f"{pki}/ca-l1/ca-cert.pem", f"{d}/ca-cert.pem")
        if subject:
            signer = key_from
            run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", f"{d}/client-key.pem"])
            run(["openssl", "req", "-new", "-key", f"{d}/client-key.pem", "-subj", subject, "-out", f"{d}/c.csr"])
            ext = f"{d}/e.cnf"; open(ext, "w").write("[v3]\nextendedKeyUsage=clientAuth\n")
            run(["openssl", "x509", "-req", "-in", f"{d}/c.csr", "-CA", f"{pki}/{signer}/ca-cert.pem", "-CAkey", f"{pki}/{signer}/ca-key.pem",
                 "-CAcreateserial", "-days", "2", "-extfile", ext, "-extensions", "v3", "-out", f"{d}/client-cert.pem"])
            if ca is None:
                shutil.copyfile(f"{pki}/ca-l1/ca-cert.pem", f"{d}/ca-cert.pem")
        return d
    rogue_client = client_dir("client-rogue", None, "ca-rogue", "/O=Enclave RPC HDD/CN=enclave-rpc-l1-client")
    # qemu's client checks its OWN certificate against its CA file first, so give it both CAs: it then trusts the l1
    # server and presents a rogue-signed certificate, and the refusal under test is the SERVER's
    with open(f"{rogue_client}/ca-cert.pem", "w") as f:
        f.write(open(f"{pki}/ca-l1/ca-cert.pem").read() + open(f"{pki}/ca-rogue/ca-cert.pem").read())
    wrongdn_client = client_dir("client-wrongdn", "ca-l1", "ca-l1", "/O=Enclave RPC HDD/CN=enclave-rpc-l1-intruder")
    certless_client = client_dir("client-certless", "ca-l1")

    # ---- export configuration: fail-closed checks on real mounts/sysfs ----
    state = {}
    for role in ("l1", "base", "neg"):
        state[role] = f"{RUN}/state-{role}"; os.makedirs(state[role], mode=0o700)
    P = {"l1": free_port(), "base": free_port()}
    size = {"l1": 64 << 20, "base": 128 << 20}
    cfgp = {}
    for role in ("l1", "base"):
        cfgp[role] = f"{RUN}/export-{role}.json"
        wjson(cfgp[role], export_cfg(role, mp, f"{role}-origin.img", size[role], P[role], f"{pki}/server-{role}", state[role], [byuuid], ident=ident))

    def neg(name, mutate, needle, cmd="check"):
        c = export_cfg("l1", mp, "l1-origin.img", size["l1"], P["l1"], f"{pki}/server-l1", state["neg"], [byuuid], ident=ident)
        mutate(c)
        p = f"{RUN}/neg-{name}.json"; wjson(p, c)
        r = run(EXPORT + [cmd, p])
        rec(f"neg-{name}", r[0] == 2 and needle in r[1], needle=needle, out=r[1][-300:])

    r = run(EXPORT + ["start", cfgp["l1"]])
    rec("neg-missing-image-is-not-created", r[0] == 2 and "does not exist" in r[1] and not os.path.exists(f"{mp}/enclave-rpc/l1-origin.img"), out=r[1][-200:])
    r = run(EXPORT + ["create", cfgp["l1"]])
    rec("neg-create-needs-explicit-flag", r[0] == 2 and "--first-creation" in r[1])
    for role in ("l1", "base"):
        r = run(EXPORT + ["create", cfgp[role], "--first-creation"])
        rec(f"create-{role}", r[0] == 0, out=r[1][-300:])
    neg("bare-mountpoint", lambda c: (c["hdd"].update(mountPoint=f"{RUN}/bare-dir"), c["image"].update(path=f"{RUN}/bare-dir/enclave-rpc/l1-origin.img")), "is not a mount point")
    neg("fstype-mismatch", lambda c: c["hdd"].update(fsType="ntfs3"), "not the configured ntfs3")
    neg("device-mismatch", lambda c: c["hdd"].update(devices=[other]), "which is not")
    neg("rotational-required", lambda c: c["hdd"].update(requireRotational=True), "rotational")
    neg("rotational-waiver-off-loopback", lambda c: c["listen"].update(address="192.0.2.10"), "loopback-bound test fixture")
    neg("wildcard-bind", lambda c: c["listen"].update(address="0.0.0.0"), "wildcard")
    neg("size-mismatch", lambda c: c["image"].update(bytes=size["l1"] + 512), "not the configured")
    neg("role-crossed-image", lambda c: (c.update(role="base"), c["tls"].update(clientIdentity=ident["base"], serverName="enclave-rpc-hdd-base.test")), "base-origin.img")
    neg("role-crossed-identity", lambda c: c["tls"].update(clientIdentity=ident["base"]), "CN=enclave-rpc-l1-client")
    # wrong backing filesystem: a tmpfs mounted INSIDE the HDD mount, holding the image's directory
    os.makedirs(f"{mp}/shadow"); run(["mount", "-t", "tmpfs", "-o", "size=4m", "shadowfs", f"{mp}/shadow"])
    open(f"{mp}/shadow/l1-origin.img", "wb").truncate(size["l1"]); os.chmod(f"{mp}/shadow/l1-origin.img", 0o600)
    neg("image-on-other-filesystem", lambda c: c["image"].update(path=f"{mp}/shadow/l1-origin.img"), "is not on the")
    os.symlink(f"{mp}/enclave-rpc", f"{mp}/linked")
    neg("symlinked-path", lambda c: c["image"].update(path=f"{mp}/linked/l1-origin.img"), "symlink")
    os.chmod(f"{pki}/server-l1/server-key.pem", 0o644)
    neg("key-permissions", lambda c: None, "group/other permissions")
    os.chmod(f"{pki}/server-l1/server-key.pem", 0o600)
    r = run(EXPORT + ["check", cfgp["l1"]])
    placement = {role: None for role in ("l1", "base")}
    rec("check-l1-ok", r[0] == 0, out=r[1][-600:])
    for role in ("l1", "base"):
        placement[role] = json.load(open(f"{state[role]}/placement.json"))

    # ---- servers + protocol identity tests (userspace NBD clients) ----
    for role in ("l1", "base"):
        r = run(EXPORT + ["start", cfgp[role]], 30)
        rec(f"start-{role}", r[0] == 0, out=r[1][-300:])
    r = run(EXPORT + ["start", cfgp["l1"]])
    rec("start-twice-refused", r[0] == 2 and "exists" in r[1])
    cl = {role: f"{pki}/client-{role}" for role in ("l1", "base")}
    r = qio(cl["l1"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "write -P 0x5a 0 1M", "read -P 0x5a 0 1M")
    rec("proto-l1-mutual-tls-write-read", ok_io(r), out=r[1][-300:])
    r = run(EXPORT + ["create", cfgp["l1"], "--first-creation"])
    rec("create-again-refused-existing-data-kept", r[0] == 2 and "already exists" in r[1])
    r = qio(cl["l1"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read -P 0x5a 0 1M")
    rec("existing-data-unchanged-after-refused-create", ok_io(r), out=r[1][-200:])
    slog = {role: f"{state[role]}/qemu-nbd.log" for role in ("l1", "base")}

    def logged(role, fn):
        """(client result, the server log lines this one call added)."""
        n = os.path.getsize(slog[role])
        r = fn()
        time.sleep(0.3)
        with open(slog[role]) as f:
            f.seek(n)
            return r, f.read()
    cases = [
        ("no-tls-client", lambda: qio(None, P["l1"], "enclave-rpc-l1", "", "read 0 4k", tls=False)),
        ("rogue-ca-client", lambda: qio(rogue_client, P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k")),
        ("wrong-dn-client-same-ca", lambda: qio(wrongdn_client, P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k")),
        ("certless-client", lambda: qio(certless_client, P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k")),
        ("base-client-to-l1-export", lambda: qio(cl["base"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k")),
        ("l1-client-to-base-export", lambda: qio(cl["l1"], P["base"], "enclave-rpc-base", "enclave-rpc-hdd-base.test", "read 0 4k")),
        ("wrong-export-name", lambda: qio(cl["l1"], P["l1"], "enclave-rpc-base", "enclave-rpc-hdd-l1.test", "read 0 4k")),
        ("server-name-mismatch", lambda: qio(cl["l1"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.wrong", "read 0 4k")),
    ]
    # each refusal must name the reason it was meant to test (client error text or the server's own log line)
    # each refusal must name the reason it was meant to test, at the side that is supposed to refuse
    reason = {"no-tls-client": ("server", "not permitted before TLS"),
              "rogue-ca-client": ("server", "hasn't got a known issuer"),
              "wrong-dn-client-same-ca": ("server", "authz check for O=Enclave RPC HDD,CN=enclave-rpc-l1-intruder is denied"),
              "certless-client": ("server", "No certificate was found"),
              "base-client-to-l1-export": ("client", "hasn't got a known issuer"),
              "l1-client-to-base-export": ("client", "hasn't got a known issuer"),
              "wrong-export-name": ("server", "not present"),
              "server-name-mismatch": ("client", "does not match the hostname")}
    for name, fn in cases:
        srv = "base" if name == "l1-client-to-base-export" else "l1"
        r, lines = logged(srv, fn)
        side, why = reason[name]
        # a server-side reason is either in the server's log or reported by the server to the client ("server reported: ...")
        seen = (why in lines or f"server reported: " in r[1] and why in r[1]) if side == "server" else why in r[1]
        rec(f"proto-refused-{name}", not ok_io(r) and seen, rc=r[0], client=r[1][-400:], serverLog=lines[-400:], expected={"side": side, "reason": why})
    r, lines = logged("l1", lambda: qio(cl["l1"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read -P 0x5a 0 1M"))
    rec("proto-legit-client-still-served-after-refusals", ok_io(r) and "denied" not in lines and "failed" not in lines, client=r[1][-200:], serverLog=lines[-300:])

    # a server presenting a certificate from ANOTHER CA (rogue server for the l1 name): the l1 client must refuse it
    rs = f"{pki}/server-rogue"
    run(PKI + ["issue-server", "--role", "l1", "--ca", f"{pki}/ca-rogue", "--name", "enclave-rpc-hdd-l1.test", "--ip", "127.0.0.1", "--out", rs])
    rogue_img = f"{RUN}/rogue.img"; open(rogue_img, "wb").truncate(8 << 20)
    rp = free_port()
    rogue = subprocess.Popen([QEMU_NBD, "--object", f"tls-creds-x509,id=tls0,endpoint=server,dir={rs},verify-peer=off", "--tls-creds=tls0",
                              "--bind=127.0.0.1", f"--port={rp}", "--export-name=enclave-rpc-l1", "--persistent", "-f", "raw", rogue_img],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    r = qio(cl["l1"], rp, "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k")
    rec("proto-refused-rogue-server-identity", not ok_io(r) and "hasn't got a known issuer" in r[1], rc=r[0], out=r[1][-400:])
    rogue.terminate(); rogue.wait(10)

    # --shared=1: a second concurrent client is not served while the first holds the export
    holder = subprocess.Popen(["qemu-io", "--object", f"tls-creds-x509,id=tls0,endpoint=client,dir={cl['l1']}", "--image-opts",
                               f"driver=nbd,server.type=inet,server.host=127.0.0.1,server.port={P['l1']},export=enclave-rpc-l1,tls-creds=tls0,tls-hostname=enclave-rpc-hdd-l1.test",
                               "-c", "sleep 40000", "-c", "read -P 0x5a 0 64k"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(2)
    r = qio(cl["l1"], P["l1"], "enclave-rpc-l1", "enclave-rpc-hdd-l1.test", "read 0 4k", timeout=10)
    rec("proto-second-concurrent-client-not-served", not ok_io(r), rc=r[0], out=r[1][-300:])
    # export disconnect while a client is connected: owned stop of the l1 server, then the client's next read
    r = run(EXPORT + ["stop", cfgp["l1"]], 40)
    hout = holder.communicate(timeout=60)[0].decode(errors="replace")
    rec("disconnect-stop-owned-server", r[0] == 0, out=r[1][-200:], seconds=r[2])
    rec("disconnect-client-read-fails", holder.returncode != 0 or "error" in hout.lower() or "Failed" in hout, rc=holder.returncode, out=hout[-400:])
    try:
        socket.create_connection(("127.0.0.1", P["l1"]), timeout=2).close(); closed = False
    except OSError:
        closed = True
    rec("disconnect-port-closed", closed)

    # ---- owned-process lifecycle: never signal a process this tool did not start ----
    decoy = subprocess.Popen(["sleep", "300"])
    d = json.loads(json.dumps(json.load(open(f"{state['base']}/server.json"))))
    sp_dir = f"{RUN}/state-decoy"; os.makedirs(sp_dir, mode=0o700)
    dcfg = json.load(open(cfgp["base"])); dcfg["stateDir"] = sp_dir; wjson(f"{RUN}/decoy.json", dcfg)
    forged = dict(d, pid=decoy.pid)
    wjson(f"{sp_dir}/server.json", forged)
    r = run(EXPORT + ["stop", f"{RUN}/decoy.json"])
    rec("lifecycle-forged-record-not-signalled", r[0] == 2 and decoy.poll() is None, out=r[1][-200:])
    r = run(EXPORT + ["stop", f"{RUN}/decoy.json", "--clear-stale"])
    rec("lifecycle-clear-stale-drops-record-only", r[0] == 0 and decoy.poll() is None and not os.path.exists(f"{sp_dir}/server.json"), out=r[1][-200:])
    decoy.terminate(); decoy.wait(5)
    check_cap("before-guest")

    # ---- guest phase: the real kernel nbd driver and ext4, inside a throwaway KVM guest ----
    run(EXPORT + ["start", cfgp["l1"]], 30)
    gin = f"{RUN}/gin"; os.makedirs(f"{gin}/creds")
    for role, ip in (("l1", "10.0.2.100"), ("base", "10.0.2.101")):
        shutil.copytree(cl[role], f"{gin}/creds/{role}")
        pl = placement[role]
        wjson(f"{gin}/attach-{role}.json", {
            "format": "enclave-rpc-hdd-attach/v1", "role": role,
            "server": {"address": ip, "port": 10809, "serverName": f"enclave-rpc-hdd-{role}.test"},
            "tls": {"dir": f"/etc/enclave-rpc-hdd/{role}/client"},
            "placement": {"exportName": pl["exportName"], "imageBytes": pl["imageBytes"], "imagePath": pl["image"]["path"] if pl["image"] else None,
                          "mountTarget": pl["mount"]["target"], "fstype": pl["mount"]["fstype"], "requireRotational": pl["disks"]["requireRotational"],
                          "serverCertSha256": pl["serverCertSha256"], "caCertSha256": pl["caCertSha256"]},
            "device": "/dev/nbd0" if role == "l1" else "/dev/nbd1",
            "filesystem": {"label": f"enc-rpc-{role}", "uuid": None},
            "mountPoint": f"/srv/rpc-hdd/{role}", "stateDir": f"/run/enclave-rpc-hdd/{role}",
            "qemuNbd": "/usr/bin/qemu-nbd", "qemuImg": "/usr/bin/qemu-img"})
    r = run(["bash", f"{REPO}/test/guest/build-initramfs.sh", f"{RUN}/initramfs.cpio.gz", "7.2.11-arch1-1"], 120)
    rec("guest-initramfs", r[0] == 0, out=r[1][-200:])
    relay = f"python3 -I {REPO}/test/fwd_relay.py 127.0.0.1"
    qemu = ["qemu-system-x86_64", "-name", "enc-rpchdd-test", "-enable-kvm", "-cpu", "host", "-m", "512", "-smp", "2",
            "-nodefaults", "-display", "none", "-no-reboot", "-serial", f"file:{OUT}/console.log",
            "-kernel", "/boot/vmlinuz-linux", "-initrd", f"{RUN}/initramfs.cpio.gz", "-append", "console=ttyS0 panic=-1 quiet",
            "-netdev", f"user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:10809-cmd:{relay} {P['l1']},guestfwd=tcp:10.0.2.101:10809-cmd:{relay} {P['base']}",
            "-device", "virtio-net-pci,netdev=n0",
            "-virtfs", "local,path=/usr,mount_tag=usr,security_model=none,readonly=on",
            "-virtfs", f"local,path={REPO},mount_tag=src,security_model=none,readonly=on",
            "-virtfs", f"local,path={gin},mount_tag=gin,security_model=none,readonly=on",
            "-virtfs", f"local,path={OUT},mount_tag=out,security_model=none"]
    vm = subprocess.Popen(qemu, stdout=subprocess.DEVNULL, stderr=open(f"{OUT}/qemu.stderr", "wb"))
    end = time.monotonic() + 900
    stage = 0
    while vm.poll() is None and time.monotonic() < end:
        if stage == 0 and os.path.exists(f"{OUT}/ready-disconnect"):
            r = run(EXPORT + ["stop", cfgp["base"]], 40)
            rec("guest-disconnect-host-stop", r[0] == 0, out=r[1][-200:])
            open(f"{OUT}/disconnected", "w").write("1"); stage = 1
        if stage == 1 and os.path.exists(f"{OUT}/ready-restart"):
            r = run(EXPORT + ["start", cfgp["base"]], 40)
            rec("guest-restart-host-start", r[0] == 0, out=r[1][-200:])
            open(f"{OUT}/restarted", "w").write("1"); stage = 2
        time.sleep(0.5)
    if vm.poll() is None:
        vm.kill(); vm.wait(10)
        rec("guest-timeout", False)
    rec("guest-exit", vm.returncode is not None, rc=vm.returncode)
    try:
        g = json.load(open(f"{OUT}/results.json"))
    except (OSError, ValueError):
        g = []
    rec("guest-results", bool(g) and all(x["ok"] for x in g), steps=len(g), failed=[x["step"] for x in g if not x["ok"]])
    check_cap("after-guest")

    # ---- teardown: only owned servers; then the fixtures this run created ----
    for role in ("l1", "base"):
        r = run(EXPORT + ["stop", cfgp[role]], 40)
        rec(f"teardown-stop-{role}", r[0] == 0, out=r[1][-200:])
    left = run(["pgrep", "-af", f"qemu-nbd.*{RUN}"])[1].strip()
    rec("teardown-no-leftover-qemu-nbd", left == "", leftover=left)
    for f in (f"{mp}/enclave-rpc/l1-origin.img", f"{mp}/enclave-rpc/base-origin.img", rogue_img):
        if os.path.exists(f):
            os.unlink(f)
    run(["umount", f"{mp}/shadow"]); run(["umount", mp])
    for k in ("ca-l1", "ca-base", "ca-rogue"):
        shutil.rmtree(f"{pki}/{k}", ignore_errors=True)
    for dpath in [f"{pki}/{x}" for x in os.listdir(pki)] + [gin]:
        if os.path.isdir(dpath):
            for root, _, files in os.walk(dpath):
                for fn in files:
                    if fn.endswith("key.pem"):
                        os.unlink(os.path.join(root, fn))
    for s in state.values():
        p = f"{s}/server.json"
        if os.path.exists(p):
            rec("teardown-state-left", False, path=p)
    os.unlink(f"{RUN}/initramfs.cpio.gz") if os.path.exists(f"{RUN}/initramfs.cpio.gz") else None
    rec("summary", all(x["ok"] for x in RES), total=len(RES), failed=[x["step"] for x in RES if not x["ok"]])
    return 0 if all(x["ok"] for x in RES) else 1


if __name__ == "__main__":
    sys.exit(main())
