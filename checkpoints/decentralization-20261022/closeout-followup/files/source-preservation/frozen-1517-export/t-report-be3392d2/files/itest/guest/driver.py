"""Guest driver (a oneshot unit under the guest's real systemd 262, PID 1). It drives the GENERATED units with systemctl
and records exactly what systemd, the kernel and the tools did. The host side stops/starts the exports on request.
Asserted expectations are listed per step; everything else is recorded as observed."""
import hashlib
import json
import os
import shutil
import subprocess
import time

RES = []
REQ = [0]
L1 = {"attach": "enclave-rpc-hdd-attach@l1.service", "storage": "enclave-l1-pair-storage.service", "watch": "enclave-l1-pair-watch.service",
      "consumers": ["enclave-l1-el.service", "enclave-l1-cl.service"], "mnt": "/srv/enclave-l1-pair", "dev": "/dev/nbd0",
      "tool": "/opt/enclave-l1-pair/vendor/holder/storage_nbd.py", "cfg": "/etc/enclave-l1-pair/l1pair-storage-nbd.json",
      "attachCfg": "/etc/enclave-rpc-hdd/attach-l1.json", "data": ["/srv/enclave-l1-pair/data/el", "/srv/enclave-l1-pair/data/cl"],
      "tags": ["l1-el", "l1-cl"]}
BASE = {"attach": "enclave-rpc-hdd-attach@base.service", "storage": "enclave-base-holder-storage.service",
        "watch": "enclave-base-holder-watch.service", "consumers": ["enclave-base-holder.service"], "mnt": "/srv/enclave-base-holder",
        "dev": "/dev/nbd1", "tool": "/opt/enclave-base-holder/storage_nbd.py", "cfg": "/etc/enclave-base-holder/holder-storage-nbd.json",
        "attachCfg": "/etc/enclave-rpc-hdd/attach-base.json", "data": ["/srv/enclave-base-holder/data"], "tags": ["base"]}


def mono():
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def rec(step, ok, **d):
    RES.append({"step": step, "ok": bool(ok), "t": round(mono(), 2), **d})
    print(json.dumps(RES[-1], sort_keys=True)[:3000], flush=True)
    with open("/out/results.json", "w") as f:
        json.dump(RES, f, indent=1)


def sh(*a, timeout=300):
    try:
        r = subprocess.run(list(a), capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr)[-3000:]
    except subprocess.TimeoutExpired:
        return "timeout", ""


def sc(*a, timeout=300):
    return sh("systemctl", *a, timeout=timeout)


def state(u):
    rc, out = sc("show", "-p", "ActiveState,SubState,Result,ExecMainStatus,InactiveEnterTimestampMonotonic,ActiveEnterTimestampMonotonic", u, timeout=30)
    return dict(l.split("=", 1) for l in out.splitlines() if "=" in l)


def active(u):
    return state(u).get("ActiveState") == "active"


def jl(u, n=40):
    return sh("journalctl", "-u", u, "-o", "short-monotonic", "--no-pager", "-n", str(n), timeout=60)[1].splitlines()[-n:]


def tool(r, cmd, *extra, cfg=None):
    rc, out = sh("/usr/bin/python3", "-I", r["tool"], cmd, cfg or r["cfg"], *extra, timeout=600)
    return rc, out


def set_uuid(r, u):
    c = json.load(open(r["cfg"])); c["fsUuid"] = u; json.dump(c, open(r["cfg"], "w"), indent=1)
    a = json.load(open(r["attachCfg"])); a["filesystem"]["uuid"] = u; json.dump(a, open(r["attachCfg"], "w"), indent=1)


def host(action, role):
    REQ[0] += 1
    n = REQ[0]
    open(f"/out/req-{n}.json", "w").write(json.dumps({"action": action, "role": role}))
    end = mono() + 180
    while mono() < end:
        if os.path.exists(f"/out/ack-{n}.json"):
            return json.load(open(f"/out/ack-{n}.json"))
        time.sleep(0.3)
    return {"ok": False, "why": "no ack"}


def mounts_of(dev):
    st = os.stat(dev)
    mm = f"{os.major(st.st_rdev)}:{os.minor(st.st_rdev)}"
    return [l.split()[4] for l in open("/proc/self/mountinfo") if l.split()[2] == mm]


def mount_line(mnt):
    return [l.strip() for l in open("/proc/self/mountinfo") if l.split()[4] == mnt]


def bare_empty(mnt):
    """The mount point is NOT a mount and holds nothing (no fallback writes on the VM's own disk)."""
    if mount_line(mnt):
        return False, "mounted"
    if not os.path.exists(mnt):
        return True, "absent"
    return os.listdir(mnt) == [], sorted(os.listdir(mnt))


def verify_standin(r):
    """Every file the stand-in recorded as synced (seq <= LAST) is present with the expected content."""
    out = {}
    for tag, d in zip(r["tags"], r["data"]):
        sd = os.path.join(d, "standin")
        try:
            last = int(open(os.path.join(sd, "LAST")).read())
        except (OSError, ValueError):
            out[tag] = {"last": None, "bad": ["no LAST"]}
            continue
        bad = []
        for n in range(1, last + 1):
            want = hashlib.sha256(f"{tag}:{n}".encode()).digest() * (512 * 1024 // 32)
            try:
                if open(os.path.join(sd, f"{n:06d}.bin"), "rb").read() != want:
                    bad.append(n)
            except OSError as e:
                bad.append(f"{n}:{e.errno}")
        out[tag] = {"last": last, "bad": bad}
    return out


def wait_down(r, t0, limit=60):
    """After the export stops: when the watch leaves active, and when every consumer is inactive (systemd states)."""
    seen = {}
    end = mono() + limit
    while mono() < end and len(seen) < 1 + len(r["consumers"]):
        for u in [r["watch"]] + r["consumers"]:
            if u not in seen and state(u).get("ActiveState") in ("inactive", "failed"):
                seen[u] = round(mono() - t0, 2)
        time.sleep(0.2)
    return seen


def scenario_disconnect(r, label):
    """Export lost while the consumers write. Asserted: the watch exits, systemd stops EVERY consumer (they do not exit by
    themselves on EIO), nothing is written to the VM disk, and nothing is auto-recovered."""
    before = {u: state(u).get("ActiveState") for u in [r["watch"]] + r["consumers"]}
    t0 = mono()
    ack = host("stop", label)
    seen = wait_down(r, t0)
    ws = state(r["watch"])
    ok = ack.get("ok") and set(seen) == {r["watch"], *r["consumers"]} and ws.get("Result") not in ("success",)
    ioerr = {u: [l for l in jl(u, 200) if "IOERROR" in l][:3] for u in r["consumers"]}
    rec(f"{label}-disconnect-supervision-stops-consumers", ok, before=before, stoppedAfterSec=seen, watch=ws,
        watchJournal=jl(r["watch"], 8), consumerIOErrorsBeforeStop=ioerr, storage=state(r["storage"]),
        attach=state(r["attach"]), mountStillListed=mount_line(r["mnt"]))
    time.sleep(5)
    again = {u: state(u).get("ActiveState") for u in r["consumers"]}
    rec(f"{label}-no-automatic-restart-or-resync", all(v != "active" for v in again.values()), consumers=again)
    t1 = mono()
    s = sc("stop", r["storage"], timeout=600)
    rec(f"{label}-operator-stops-storage", state(r["storage"]).get("ActiveState") == "inactive", rc=s[0], seconds=round(mono() - t1, 2),
        journal=jl(r["storage"], 12))
    t1 = mono()
    a = sc("stop", r["attach"], timeout=600)
    rec(f"{label}-operator-stops-attach", state(r["attach"]).get("ActiveState") == "inactive" and not os.path.exists(f"/sys/block/{os.path.basename(r['dev'])}/pid"),
        rc=a[0], seconds=round(mono() - t1, 2), journal=jl(r["attach"], 8))
    be = bare_empty(r["mnt"])
    rec(f"{label}-mount-point-bare-and-empty-after", be[0], detail=be[1])
    s = sc("start", r["consumers"][0], timeout=300)
    be = bare_empty(r["mnt"])
    rec(f"{label}-consumer-refused-while-export-down-no-fallback", not active(r["consumers"][0]) and be[0], rc=s[0],
        consumer=state(r["consumers"][0]), attach=state(r["attach"]), attachJournal=jl(r["attach"], 6), mountPoint=be[1])
    sc("reset-failed")


def main():
    rec("pid1-is-systemd", os.readlink("/proc/1/exe").endswith("systemd"), pid1=os.readlink("/proc/1/exe"),
        version=sh("systemctl", "--version")[1].splitlines()[0], kernel=os.uname().release)
    nic = sorted(n for n in os.listdir("/sys/class/net") if n != "lo")[0]
    outs = [sh(*c)[0] for c in (["ip", "link", "set", "lo", "up"], ["ip", "link", "set", nic, "up"], ["ip", "addr", "add", "10.0.2.15/24", "dev", nic])]
    rec("guest-net", all(o == 0 for o in outs), nic=nic)
    disk = next(d for d in sorted(os.listdir("/sys/block")) if d.startswith("sd") and open(f"/sys/block/{d}/device/model").read().strip())
    rot = open(f"/sys/block/{disk}/queue/rotational").read().strip()
    r1 = sh("mkfs.ext4", "-q", "-b", "4096", "-L", "vmnvme", f"/dev/{disk}")
    r2 = sh("mount", "-o", "noatime", f"/dev/{disk}", "/vm")
    os.makedirs("/vm/rpc-cache", mode=0o755, exist_ok=True)
    rec("nvme-fixture-disk", r1[0] == 0 and r2[0] == 0 and rot == "0", disk=disk, rotational=rot)

    # ---------------- A: L1 pair, network origin, NO cache ----------------
    s = sc("start", L1["consumers"][0], timeout=300)
    be = bare_empty(L1["mnt"])
    rec("A0-unformatted-export-consumer-refused-no-fallback", not active(L1["consumers"][0]) and be[0], rc=s[0],
        storage=state(L1["storage"]), storageJournal=jl(L1["storage"], 6), attach=state(L1["attach"]), mountPoint=be[1])
    sc("reset-failed")
    rc, out = tool(L1, "create")
    rec("A1a-create-needs-explicit-first-format", rc == 2 and "--first-format" in out, out=out[-200:])
    rc, out = tool(L1, "create", "--first-format")
    u = json.loads(out.strip().splitlines()[-1]).get("fsUuid") if rc == 0 else None
    rec("A1b-first-format-of-the-blank-export", rc == 0 and bool(u), out=out[-300:])
    rc, out = tool(L1, "create", "--first-format")
    rec("A1c-second-create-refused", rc == 2, out=out[-200:])
    set_uuid(L1, u)
    s = sc("start", *L1["consumers"], timeout=300)
    time.sleep(4)
    st = {x: state(x).get("ActiveState") for x in [L1["attach"], L1["storage"], L1["watch"]] + L1["consumers"]}
    rec("A2-generated-units-start-in-order", s[0] == 0 and all(v == "active" for v in st.values()) and mounts_of(L1["dev"]) == [L1["mnt"]],
        states=st, mount=mount_line(L1["mnt"]), consumerJournal=jl(L1["consumers"][0], 4))
    scenario_disconnect(L1, "l1")
    ack = host("start", "l1")
    s = sc("start", *L1["consumers"], timeout=300)
    time.sleep(3)
    v = verify_standin(L1)
    rec("A6-recovered-synced-data-intact", ack.get("ok") and s[0] == 0 and all(x["last"] and not x["bad"] for x in v.values()),
        standin=v, states={x: state(x).get("ActiveState") for x in [L1["watch"]] + L1["consumers"]})
    s = sc("stop", L1["attach"], timeout=600)
    st = {x: state(x).get("ActiveState") for x in [L1["attach"], L1["storage"], L1["watch"]] + L1["consumers"]}
    rec("A7-stopping-the-attach-stops-everything-above-it", all(x == "inactive" for x in st.values()) and not os.path.exists("/sys/block/nbd0/pid"),
        states=st, storageJournal=jl(L1["storage"], 4))

    # ---------------- B: Base holder, network origin WITH writethrough dm-cache ----------------
    sc("start", BASE["attach"], timeout=300)
    rc, out = tool(BASE, "create", "--first-format")
    u = json.loads(out.strip().splitlines()[-1]).get("fsUuid") if rc == 0 else None
    cache_files = {f: os.stat(f).st_blocks * 512 for f in ("/vm/rpc-cache/base-data.img", "/vm/rpc-cache/base-meta.img") if os.path.exists(f)}
    rec("B0-create-formats-blank-export-and-allocates-cache-through-ledger", rc == 0 and bool(u) and len(cache_files) == 2, out=out[-400:],
        cacheAllocatedBytes=cache_files, ledgerVerify=sh("/usr/bin/python3", "-I", "/opt/enclave-base-holder/budget.py", "verify",
                                                          "/etc/enclave-rpc-cache/nvme-cache-budget.json", "base-holder-dm-cache")[1][-300:])
    set_uuid(BASE, u)
    s = sc("start", BASE["consumers"][0], timeout=300)
    time.sleep(3)
    hold = sorted(os.listdir("/sys/block/nbd1/holders"))
    os.makedirs("/mnt/raw", exist_ok=True)
    direct = sh("mount", "-o", "ro", "/dev/nbd1", "/mnt/raw")
    if direct[0] == 0:
        sh("umount", "/mnt/raw")
    rec("B1-cache-under-the-one-mount-and-no-second-view", s[0] == 0 and active(BASE["consumers"][0]) and len(hold) == 1
        and mount_line(BASE["mnt"]) and "/dev/mapper/enclave-base-holder" in mount_line(BASE["mnt"])[0] and direct[0] != 0,
        holders=hold, mount=mount_line(BASE["mnt"]), directMountOfOrigin={"rc": direct[0], "out": direct[1][-200:]},
        dmStatus=sh("dmsetup", "status", "enclave-base-holder")[1].strip(), storageJournal=jl(BASE["storage"], 4))
    s = sc("stop", BASE["storage"], timeout=600)
    j = jl(BASE["storage"], 6)
    rec("B2a-clean-stop-writes-cache-reuse-marker", s[0] == 0 and any('"cacheReuseMarker": true' in l for l in j), journal=j)
    s = sc("start", BASE["consumers"][0], timeout=300)
    time.sleep(2)
    rec("B2b-clean-restart-reuses-the-cache", s[0] == 0 and active(BASE["consumers"][0]), dmStatus=sh("dmsetup", "status", "enclave-base-holder")[1].strip(),
        standin=verify_standin(BASE))
    # uncached access between sessions: detected through the origin superblock, refused until cache-loss
    sc("stop", BASE["storage"], timeout=600)
    m = sh("mount", "/dev/nbd1", "/mnt/raw")
    open("/mnt/raw/data/uncached-write.txt", "w").write("written WITHOUT the cache\n") if m[0] == 0 else None
    sh("umount", "/mnt/raw")
    s = sc("start", BASE["consumers"][0], timeout=300)
    be = bare_empty(BASE["mnt"])
    rec("B3a-uncached-write-detected-assemble-refused", m[0] == 0 and not active(BASE["consumers"][0]) and be[0],
        rc=s[0], storageJournal=jl(BASE["storage"], 6), mountPoint=be[1])
    sc("reset-failed")
    rc, out = tool(BASE, "cache-loss")
    rec("B3b-cache-loss-invalidates-before-uncached-check", rc == 0 and '"originFsckRc": 0' in out, out=out[-500:])
    s = sc("start", BASE["consumers"][0], timeout=300)
    time.sleep(2)
    seen = os.path.exists("/srv/enclave-base-holder/data/uncached-write.txt")
    rec("B3c-after-cache-loss-the-uncached-write-is-visible", s[0] == 0 and active(BASE["consumers"][0]) and seen, visible=seen)
    time.sleep(3)
    scenario_disconnect(BASE, "base")
    ack = host("start", "base")
    s = sc("start", BASE["consumers"][0], timeout=300)
    be = bare_empty(BASE["mnt"])
    rec("B5a-after-transport-loss-cache-reuse-refused", ack.get("ok") and not active(BASE["consumers"][0]) and be[0],
        storageJournal=jl(BASE["storage"], 6), mountPoint=be[1])
    sc("reset-failed")
    rc, out = tool(BASE, "cache-loss")
    s = sc("start", BASE["consumers"][0], timeout=300)
    time.sleep(2)
    v = verify_standin(BASE)
    rec("B5b-cache-loss-then-recovered-synced-data-intact", rc == 0 and s[0] == 0 and all(x["last"] and not x["bad"] for x in v.values()),
        cacheLoss=out[-400:], standin=v)

    # ---------------- C: foreign devices/mounts, role binding, false placement ----------------
    c = json.load(open(L1["cfg"])); c["attachConfig"] = BASE["attachCfg"]; json.dump(c, open("/run/x-role.json", "w"))
    rc, out = sh("/usr/bin/python3", "-I", L1["tool"], "assemble", "/run/x-role.json")
    rec("C1-l1-storage-refuses-the-base-attach", rc == 2 and "role" in out, out=out[-200:])
    a = json.load(open(BASE["attachCfg"])); a["placement"]["serverCertSha256"] = "0" * 64
    json.dump(a, open("/etc/enclave-rpc-hdd/attach-tampered.json", "w"))
    c = json.load(open(BASE["cfg"])); c["attachConfig"] = "/etc/enclave-rpc-hdd/attach-tampered.json"; json.dump(c, open("/run/x-pin.json", "w"))
    rc, out = sh("/usr/bin/python3", "-I", BASE["tool"], "assemble", "/run/x-pin.json")
    rec("C2-unpinned-placement-statement-refused", rc == 2 and "pinned" in out, out=out[-250:])
    sc("stop", BASE["storage"], timeout=600)
    sh("mount", "-t", "tmpfs", "-o", "size=1m", "foreign", BASE["mnt"])
    s = sc("start", BASE["consumers"][0], timeout=300)
    j = jl(BASE["storage"], 5)
    rec("C3-foreign-mount-at-the-mount-point-refused", not active(BASE["consumers"][0]) and any("another device" in l for l in j), journal=j)
    sh("umount", BASE["mnt"]); sc("reset-failed")
    open(f"{BASE['mnt']}/stray", "w").write("x")
    s = sc("start", BASE["consumers"][0], timeout=300)
    j = jl(BASE["storage"], 5)
    rec("C4-stray-file-in-bare-mount-point-refused", not active(BASE["consumers"][0]) and any("not empty" in l for l in j), journal=j)
    os.unlink(f"{BASE['mnt']}/stray"); sc("reset-failed")
    with open("/vm/foreign.img", "wb") as f:
        f.truncate(8 << 20)
    fq = sh("qemu-nbd", "--fork", "--socket=/run/foreign-nbd.sock", "-c", "/dev/nbd2", "-f", "raw", "/vm/foreign.img")
    end = mono() + 10
    while mono() < end and not os.path.exists("/sys/block/nbd2/pid"):
        time.sleep(0.1)
    a = json.load(open(BASE["attachCfg"])); a["device"] = "/dev/nbd2"; a["stateDir"] = "/run/enclave-rpc-hdd/foreign"
    json.dump(a, open("/etc/enclave-rpc-hdd/attach-foreign.json", "w"))
    v1 = sh("/usr/bin/python3", "-I", "/opt/enclave-rpc-hdd/transport/hddattach.py", "verify-attached", "/etc/enclave-rpc-hdd/attach-foreign.json")
    d1 = sh("/usr/bin/python3", "-I", "/opt/enclave-rpc-hdd/transport/hddattach.py", "detach", "/etc/enclave-rpc-hdd/attach-foreign.json")
    still = os.path.exists("/sys/block/nbd2/pid")
    rec("C5-foreign-nbd-not-verified-and-never-detached", fq[0] == 0 and v1[0] == 2 and d1[0] == 2 and still,
        foreignConnect=fq, verify=v1[1][-200:], detach=d1[1][-200:], foreignStillConnected=still)
    sh("qemu-nbd", "-d", "/dev/nbd2"); os.unlink("/vm/foreign.img")

    # the transport never disconnects a device the storage layer still holds (cached: dm mapping; uncached: the mount)
    sc("start", BASE["consumers"][0], timeout=300)
    sc("start", L1["consumers"][0], timeout=300)
    db = sh("/usr/bin/python3", "-I", "/opt/enclave-rpc-hdd/transport/hddattach.py", "detach", BASE["attachCfg"])
    dl = sh("/usr/bin/python3", "-I", "/opt/enclave-rpc-hdd/transport/hddattach.py", "detach", L1["attachCfg"])
    rec("C6-transport-detach-refused-while-storage-holds-the-device",
        db[0] == 2 and "still held" in db[1] and dl[0] == 2 and "mounted at" in dl[1]
        and active(BASE["consumers"][0]) and active(L1["consumers"][0]) and os.path.exists("/sys/block/nbd1/pid") and os.path.exists("/sys/block/nbd0/pid"),
        base=db[1][-200:], l1=dl[1][-200:])

    # ---------------- teardown: everything this test started ----------------
    sc("stop", BASE["attach"], L1["attach"], timeout=600)
    left = {"nbdPids": [d for d in os.listdir("/sys/block") if d.startswith("nbd") and os.path.exists(f"/sys/block/{d}/pid")],
            "dm": sh("dmsetup", "ls")[1].strip(), "loops": sh("losetup", "-a")[1].strip(),
            "srvMounts": [l for l in open("/proc/self/mountinfo") if " /srv/" in l]}
    rec("teardown-clean", not left["nbdPids"] and "enclave" not in left["dm"] and not left["loops"] and not left["srvMounts"], left=left)
    rec("done", all(x["ok"] for x in RES), failed=[x["step"] for x in RES if not x["ok"]])


try:
    main()
except Exception as e:
    import traceback
    rec("driver-exception", False, error=repr(e), tb=traceback.format_exc()[-1500:])
finally:
    sh("sh", "-c", "journalctl --no-pager -o short-monotonic > /out/journal.txt 2>&1", timeout=120)
    os.sync()
    open("/proc/sysrq-trigger", "w").write("o")
