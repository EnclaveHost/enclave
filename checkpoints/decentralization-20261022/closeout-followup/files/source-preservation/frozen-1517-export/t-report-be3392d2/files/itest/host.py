"""Host side of the composition integration test. Run ONLY via itest/run.sh, which runs it inside
`unshare --user --map-root-user --mount`: an unprivileged namespace on the host network, every listener on 127.0.0.1.

What it does:
- builds a stand-in HDD mount (a real bind mount of an owned directory, ext4 on NVMe; NOT ntfs3, NOT the USB RAID);
- runs the composed transport (t/), with mutual TLS, to export l1 and base;
- renders the GENERATED units from production-shaped S/P network-layout configs;
- writes the fixture storage/watch configs, credentials and ledger;
- boots the KVM guest (systemd PID 1);
- serves its export stop/start requests;
- polls the run directory's allocation for the TRUE peak.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import time

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = sys.argv[1]
OUT = f"{RUN}/out"
CAP = 512 << 20
QNBD = shutil.which("qemu-nbd")
EXPORT = ["python3", "-I", f"{W}/t/transport/hddexport.py"]
PKI = ["python3", "-I", f"{W}/t/transport/pki.py"]
RES, PEAK = [], {"bytes": 0, "at": None}
MID = "1d0c0de0a1b2c3d4e5f60718293a4b5c"


def rec(step, ok, **d):
    RES.append({"step": step, "ok": bool(ok), **d})
    print(json.dumps(RES[-1], sort_keys=True)[:2000], flush=True)
    json.dump(RES, open(f"{OUT}/host-results.json", "w"), indent=1)


def run(argv, timeout=120, **kw):
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout, **kw)
        return r.returncode, (r.stdout + r.stderr).decode(errors="replace")[-2000:]
    except subprocess.TimeoutExpired:
        return "timeout", ""


def alloc(tag):
    a = int(subprocess.run(["du", "-s", "--block-size=1", RUN], capture_output=True).stdout.split()[0])
    if a > PEAK["bytes"]:
        PEAK.update(bytes=a, at=tag)
    return a


def load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    sys.path.insert(0, os.path.dirname(path))
    s.loader.exec_module(m)
    return m


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def main():
    os.makedirs(OUT, exist_ok=True)
    rec("namespace", os.geteuid() == 0)
    alloc("start")
    backing, mp = f"{RUN}/hdd-backing", f"{RUN}/mnt-hdd"
    os.makedirs(backing); os.makedirs(mp)
    run(["mount", "--bind", backing, mp])
    src = os.path.realpath(next(l.split(" - ")[1].split()[1] for l in open("/proc/self/mountinfo") if l.split()[4] == mp))
    byuuid = next(f"/dev/disk/by-uuid/{n}" for n in sorted(os.listdir("/dev/disk/by-uuid")) if os.path.realpath(f"/dev/disk/by-uuid/{n}") == src)
    pki = f"{RUN}/pki"; os.makedirs(pki)
    ident, size, port, cfgp, state = {}, {"l1": 96 << 20, "base": 160 << 20}, {}, {}, {}
    for role in ("l1", "base"):
        run(PKI + ["init-ca", "--role", role, "--ca", f"{pki}/ca-{role}"])
        run(PKI + ["issue-server", "--role", role, "--ca", f"{pki}/ca-{role}", "--name", f"enclave-rpc-hdd-{role}.test", "--ip", "127.0.0.1", "--out", f"{pki}/server-{role}"])
        run(PKI + ["client-key", "--role", role, "--out", f"{pki}/client-{role}"])
        r = run(PKI + ["sign-client", "--role", role, "--ca", f"{pki}/ca-{role}", "--csr", f"{pki}/client-{role}/client.csr", "--out", f"{pki}/client-{role}.crt"])
        ident[role] = r[1].split("clientIdentity (export config tls.clientIdentity): ")[-1].strip()
        run(PKI + ["install-client", "--role", role, "--cert", f"{pki}/client-{role}.crt", "--ca-cert", f"{pki}/ca-{role}/ca-cert.pem", "--dir", f"{pki}/client-{role}"])
        state[role] = f"{RUN}/state-{role}"; os.makedirs(state[role], mode=0o700)
        port[role] = free_port()
        cfgp[role] = f"{RUN}/export-{role}.json"
        json.dump({"format": "enclave-rpc-hdd-export/v1", "role": role,
                   "hdd": {"mountPoint": mp, "fsType": "ext4", "devices": [byuuid], "requireRotational": False},
                   "image": {"path": f"{mp}/enclave-rpc/{role}-origin.img", "bytes": size[role], "allocation": "sparse"},
                   "listen": {"address": "127.0.0.1", "port": port[role]},
                   "tls": {"dir": f"{pki}/server-{role}", "serverName": f"enclave-rpc-hdd-{role}.test", "clientIdentity": ident[role]},
                   "stateDir": state[role], "qemuNbd": QNBD}, open(cfgp[role], "w"), indent=1)
        a = run(EXPORT + ["create", cfgp[role], "--first-creation"])
        b = run(EXPORT + ["start", cfgp[role]], 30)
        rec(f"export-{role}", a[0] == 0 and b[0] == 0, create=a[1][-200:], start=b[1][-200:])

    gin = f"{RUN}/gin"; os.makedirs(f"{gin}/creds"); os.makedirs(f"{gin}/units")
    open(f"{gin}/machine-id", "w").write(MID + "\n")
    attach = {}
    for role, ip, dev in (("l1", "10.0.2.100", "/dev/nbd0"), ("base", "10.0.2.101", "/dev/nbd1")):
        shutil.copytree(f"{pki}/client-{role}", f"{gin}/creds/{role}")
        pl = json.load(open(f"{state[role]}/placement.json"))
        attach[role] = {"format": "enclave-rpc-hdd-attach/v1", "role": role,
                        "server": {"address": ip, "port": 10809, "serverName": f"enclave-rpc-hdd-{role}.test"},
                        "tls": {"dir": f"/etc/enclave-rpc-hdd/{role}/client"},
                        "placement": {"exportName": pl["exportName"], "imageBytes": pl["imageBytes"], "imagePath": pl["image"]["path"],
                                      "mountTarget": pl["mount"]["target"], "fstype": pl["mount"]["fstype"],
                                      "requireRotational": pl["disks"]["requireRotational"], "serverCertSha256": pl["serverCertSha256"],
                                      "caCertSha256": pl["caCertSha256"]},
                        "device": dev, "filesystem": {"label": f"enc-rpc-{role}", "uuid": None},
                        "mountPoint": f"/srv/rpc-hdd/{role}", "stateDir": f"/run/enclave-rpc-hdd/{role}",
                        "qemuNbd": "/usr/bin/qemu-nbd", "qemuImg": "/usr/bin/qemu-img"}
        json.dump(attach[role], open(f"{gin}/attach-{role}.json", "w"), indent=1)

    # ---- the GENERATED units: production-shaped S (base, cached) and P (l1, uncached) network-layout renders ----
    TS = load("s_tnl", f"{W}/s/holder/test/test_network_layout.py")
    H = TS.H
    TP = load("p_tnl", f"{W}/p/l1pair/test/test_network_layout.py")
    L = TP.L
    hc, pc = H.validate(TS.good(cached=True)), L.validate(TP.network(cached=False))
    H.render(hc, f"{RUN}/render-holder"); L.render(pc, f"{RUN}/render-pair")
    units = {}
    for d, names in ((f"{RUN}/render-holder", ("enclave-base-holder.service", "enclave-base-holder-storage.service", "enclave-base-holder-watch.service")),
                     (f"{RUN}/render-pair", ("enclave-l1-el.service", "enclave-l1-cl.service", "enclave-l1-pair-storage.service", "enclave-l1-pair-watch.service"))):
        for n in names:
            shutil.copyfile(f"{d}/{n}", f"{gin}/units/{n}")
            units[n] = hashlib.sha256(open(f"{d}/{n}", "rb").read()).hexdigest()
    shutil.copyfile(f"{W}/t/templates/enclave-rpc-hdd-attach@.service", f"{gin}/units/enclave-rpc-hdd-attach@.service")
    units["enclave-rpc-hdd-attach@.service"] = hashlib.sha256(open(f"{gin}/units/enclave-rpc-hdd-attach@.service", "rb").read()).hexdigest()
    rec("generated-units", True, sha256=units)
    json.dump({"enclave-base-holder.service": "[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I /opt/itest/consumer.py base /srv/enclave-base-holder/data\n",
               "enclave-l1-el.service": "[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I /opt/itest/consumer.py l1-el /srv/enclave-l1-pair/data/el\n",
               "enclave-l1-cl.service": "[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I /opt/itest/consumer.py l1-cl /srv/enclave-l1-pair/data/cl\n"},
              open(f"{gin}/dropins.json", "w"), indent=1)

    # ---- fixture storage/watch configs (the SAME renderer functions; fixture sizes, paths and pins) ----
    B = H.BUDGET
    files = [{"path": "/vm/rpc-cache/base-data.img", "bytes": 32 << 20}, {"path": "/vm/rpc-cache/base-meta.img", "bytes": 8 << 20}]
    slack = B.required_headroom({"blockBytes": 4096, "files": files})
    fixture = {}
    for role, name, mnt, cache in (("base", "enclave-base-holder", "/srv/enclave-base-holder",
                                    {"mechanism": "dm-cache", "mode": "writethrough", "dataImagePath": files[0]["path"], "dataBytes": files[0]["bytes"],
                                     "metadataImagePath": files[1]["path"], "metadataBytes": files[1]["bytes"], "blockBytes": 65536, "slackBytes": slack}),
                                   ("l1", "enclave-l1-pair", "/srv/enclave-l1-pair", {"mechanism": "none"})):
        c = {"serviceUser": "enclave-holder" if role == "base" else "enclave-l1", "datadir": f"{mnt}/data",
             "storage": {"layout": H.NETWORK_LAYOUT, "mountPoint": mnt, "nvmeFreeMarginBytes": 0, "cache": cache,
                         "origin": {"role": role, "attachConfig": f"/etc/enclave-rpc-hdd/attach-{role}.json", "device": attach[role]["device"],
                                    "placementSha256": hashlib.sha256(H.canonical_json(attach[role]["placement"])).hexdigest(),
                                    "bytes": size[role], "filesystemUuid": None}}}
        if cache["mechanism"] == "dm-cache":
            c["storage"]["nvmeBudget"] = {"ledgerPath": B.CANONICAL_PATH, "reservationId": "base-holder-dm-cache"}
        dirs = [f"{mnt}/data", f"{mnt}/tmp"]
        tool_budget = "/opt/enclave-base-holder/budget.py" if role == "base" else "/opt/enclave-l1-pair/vendor/holder/budget.py"
        fixture[role] = (H.network_storage_config(c, name, dirs, tool_budget), H.watch_config(c, name))
    json.dump(fixture["base"][0], open(f"{gin}/holder-storage-nbd.json", "w"), indent=1)
    json.dump(fixture["base"][1], open(f"{gin}/holder-watch.json", "w"), indent=1)
    json.dump(fixture["l1"][0], open(f"{gin}/l1pair-storage-nbd.json", "w"), indent=1)
    json.dump(fixture["l1"][1], open(f"{gin}/l1pair-watch.json", "w"), indent=1)
    rsv = {"id": "base-holder-dm-cache", "host": MID, "owner": "enclave-base-holder", "kind": "preallocated-files", "blockBytes": 4096,
           "maxBytes": files[0]["bytes"] + files[1]["bytes"] + slack, "slackBytes": slack, "files": files}
    ledger = {"format": B.FORMAT, "capBytes": B.CAP, "targetBytes": B.TARGET,
              "hosts": [{"machineId": MID, "label": "guest-fixture", "shareBytes": B.BOOKKEEPING_BYTES + rsv["maxBytes"]}], "reservations": [rsv]}
    B.validate(ledger)
    json.dump(ledger, open(f"{gin}/ledger.json", "w"), indent=1)
    rec("fixture-configs", True, ledgerShareBytes=ledger["hosts"][0]["shareBytes"], capBytes=B.CAP, targetBytes=B.TARGET)

    r = run(["bash", f"{W}/itest/guest/build-initramfs.sh", f"{RUN}/initramfs.cpio.gz", "7.2.11-arch1-1"], 120)
    rec("initramfs", r[0] == 0, out=r[1][-200:])
    open(f"{RUN}/nvme.img", "wb").truncate(192 << 20)
    alloc("before-guest")
    relay = f"python3 -I {W}/t/test/fwd_relay.py 127.0.0.1"
    qemu = ["qemu-system-x86_64", "-name", "enc-hddcompose-test", "-enable-kvm", "-cpu", "host", "-m", "768", "-smp", "2",
            "-nodefaults", "-display", "none", "-no-reboot", "-serial", f"file:{OUT}/console.log",
            "-kernel", "/boot/vmlinuz-linux", "-initrd", f"{RUN}/initramfs.cpio.gz",
            "-append", "console=ttyS0 panic=-1 systemd.unit=hddtest.target systemd.show_status=false",
            "-netdev", f"user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:10809-cmd:{relay} {port['l1']},guestfwd=tcp:10.0.2.101:10809-cmd:{relay} {port['base']}",
            "-device", "virtio-net-pci,netdev=n0", "-device", "virtio-scsi-pci,id=scsi0",
            "-drive", f"file={RUN}/nvme.img,format=raw,if=none,id=nv,cache=writeback",
            "-device", "scsi-hd,bus=scsi0.0,drive=nv,rotation_rate=1,serial=enc-nvme",
            "-virtfs", "local,path=/usr,mount_tag=usr,security_model=none,readonly=on",
            "-virtfs", f"local,path={W},mount_tag=src,security_model=none,readonly=on",
            "-virtfs", f"local,path={gin},mount_tag=gin,security_model=none,readonly=on",
            "-virtfs", f"local,path={OUT},mount_tag=out,security_model=none"]
    vm = subprocess.Popen(qemu, stdout=subprocess.DEVNULL, stderr=open(f"{OUT}/qemu.stderr", "wb"))
    end, n, last_du = time.monotonic() + 1500, 1, 0
    while vm.poll() is None and time.monotonic() < end:
        p = f"{OUT}/req-{n}.json"
        if os.path.exists(p):
            try:
                q = json.load(open(p))
            except ValueError:
                time.sleep(0.2); continue
            r = run(EXPORT + [q["action"], cfgp[q["role"]]], 60)
            rec(f"guest-request-{n}-{q['action']}-{q['role']}", r[0] == 0, out=r[1][-200:])
            json.dump({"ok": r[0] == 0}, open(f"{OUT}/ack-{n}.json", "w"))
            n += 1
        if time.monotonic() - last_du > 2:
            alloc("guest"); last_du = time.monotonic()
        time.sleep(0.2)
    if vm.poll() is None:
        vm.kill(); vm.wait(10)
        rec("guest-timeout", False)
    alloc("after-guest")
    rec("guest-exit", vm.returncode is not None, rc=vm.returncode)
    try:
        g = json.load(open(f"{OUT}/results.json"))
    except (OSError, ValueError):
        g = []
    rec("guest-results", bool(g) and all(x["ok"] for x in g), steps=len(g), failed=[x["step"] for x in g if not x["ok"]])

    # ---- teardown: only owned exports, then this run's own fixtures ----
    for role in ("l1", "base"):
        r = run(EXPORT + ["stop", cfgp[role]], 40)
        rec(f"teardown-stop-{role}", r[0] == 0, out=r[1][-200:])
    left = run(["pgrep", "-af", f"qemu-nbd.*{RUN}"])[1].strip()
    rec("teardown-no-leftover-qemu-nbd", left == "", leftover=left)
    for f in (f"{mp}/enclave-rpc/l1-origin.img", f"{mp}/enclave-rpc/base-origin.img", f"{RUN}/nvme.img", f"{RUN}/initramfs.cpio.gz"):
        if os.path.exists(f):
            os.unlink(f)
    run(["umount", mp])
    for root, _, fs in os.walk(RUN):
        for f in fs:
            if f.endswith("key.pem"):
                os.unlink(os.path.join(root, f))
    after = alloc("after-cleanup")
    rec("allocation", PEAK["bytes"] <= CAP, peakBytes=PEAK["bytes"], peakAt=PEAK["at"], afterCleanupBytes=after, capBytes=CAP,
        note="peak = largest du of the run directory sampled every ~2 s while the guest ran (sparse disk images count allocated blocks only)")
    rec("summary", all(x["ok"] for x in RES), total=len(RES), failed=[x["step"] for x in RES if not x["ok"]])
    return 0 if all(x["ok"] for x in RES) else 1


if __name__ == "__main__":
    sys.exit(main())
