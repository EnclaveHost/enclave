#!/usr/bin/env python3
"""Host run helper for the loader-only SNP A/B bench.

  plan     (default action) Read-only checks, then write a new plan directory
           holding plan.json (0444). Prints its sha256 for review. Runs no
           command.
  execute  Needs --plan and --approve-plan-sha256 matching the reviewed
           plan. Without --execute it re-runs the read-only checks and
           prints the commands (dry run). With --execute and
           --coordinated-slot it boots arm 1, then arm 2, serially. Each arm
           is one owned transient user unit, rechecked strictly before boot.

The helper never stops, signals or reads anything it did not start: no
production unit, guestd, control service or other app. It uses no QMP,
network, GPU, chain, lease or signing. The model is only stat()ed on the
host; its digest is verified inside the guest.
"""

import argparse
import hashlib
import json
import os
import secrets
import signal
import subprocess
import sys
import time

import benchlib as B
import resource_guard as RG
from build_initramfs import write_new

CGROUP_FS = "/sys/fs/cgroup"
STAT_KEYS = ("anon", "file", "shmem", "kernel", "pagetables", "sec_pagetables", "unevictable")


class Host:
    """All host interaction goes through this class; tests substitute a fake."""

    def guests(self, exclude_pid=None):
        return RG.snapshot(exclude_pid=exclude_pid)

    def run(self, argv, timeout=60):
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, p.stdout, p.stderr

    def read(self, path):
        with open(path) as f:
            return f.read()

    def read_bytes(self, path):
        with open(path, "rb") as f:
            return f.read()

    def exists(self, path):
        return os.path.lexists(path)

    def stat(self, path):
        return os.stat(path)

    def sha256(self, path):
        return B.sha256_file(path)

    def readlink(self, path):
        return os.readlink(path)

    def access_rw(self, path):
        return os.access(path, os.R_OK | os.W_OK)

    def euid(self):
        return os.geteuid()

    def kill(self, pid, sig):
        os.kill(pid, sig)

    def storage_check(self, path):
        return B.storage_check(path)

    def now(self):
        return time.monotonic()

    def wall(self):
        return time.time()

    def sleep(self, s):
        time.sleep(s)


# ---------------------------------------------------------------- argv checks

QEMU_FLAGS = {"-nodefaults", "-no-user-config", "-no-reboot"}
QEMU_ONCE = {"-display", "-monitor", "-parallel", "-nic", "-serial", "-machine", "-cpu", "-smp",
             "-m", "-bios", "-kernel", "-initrd", "-append", "-drive", "-device"}


def qemu_violations(q, initrd):
    """Independent invariants for the QEMU argv, so a bug in
    benchlib.qemu_argv cannot silently add a disk, NIC or control socket."""
    bad, opts, i = [], {}, 1
    while i < len(q):
        o = q[i]
        if o in QEMU_FLAGS:
            opts.setdefault(o, []).append(None)
            i += 1
        elif o in QEMU_ONCE or o == "-object":
            if i + 1 >= len(q):
                return [f"{o} without value"]
            opts.setdefault(o, []).append(q[i + 1])
            i += 2
        else:
            return [f"option not allowed: {o}"]
    for o in QEMU_FLAGS | QEMU_ONCE:
        if len(opts.get(o, [])) != 1:
            bad.append(f"{o} must appear exactly once")
    if bad:
        return bad
    one = {o: v[0] for o, v in opts.items()}
    for o in ("-display", "-monitor", "-parallel", "-nic"):
        if one[o] != "none":
            bad.append(f"{o} must be none")
    drive = one["-drive"].split(",")
    for want in ("if=none", "id=model", "file=" + B.MODEL_PATH, "format=raw", "readonly=on", "cache=none"):
        if want not in drive:
            bad.append(f"-drive lacks {want}")
    if not one["-device"].startswith("virtio-blk-pci,drive=model,"):
        bad.append("only device is the virtio-blk model disk")
    if one["-m"] != "48G" or one["-smp"] != "2":
        bad.append("guest must be 48G / 2 vCPU")
    if one["-initrd"] != initrd or one["-append"] != B.CMDLINE:
        bad.append("initrd/cmdline differ from plan")
    if not one["-serial"].startswith("file:"):
        bad.append("serial must go to a file")
    m = one["-machine"].split(",")
    for want in ("q35", "accel=kvm", "confidential-guest-support=sev0", "memory-backend=ram0"):
        if want not in m:
            bad.append(f"-machine lacks {want}")
    objs = sorted(opts.get("-object", []))
    if len(objs) != 2 or not objs[0].startswith("memory-backend-memfd,") or not objs[1].startswith("sev-snp-guest,"):
        bad.append("objects must be exactly memfd backend and sev-snp-guest")
    else:
        if not {"id=ram0", "size=48G", "share=true"} <= set(objs[0].split(",")):
            bad.append("memfd backend must be 48G share=true")
        if not {"id=sev0", "cbitpos=51", "reduced-phys-bits=1", "kernel-hashes=on"} <= set(objs[1].split(",")):
            bad.append("sev-snp-guest parameters differ")
    return bad


def unit_violations(argv, unit):
    bad = []
    head = argv[:argv.index("--")] if "--" in argv else argv
    for want in ("--user", "--unit", unit, "--service-type=exec",
                 "--property=MemoryMax=" + B.UNIT_MEMORY_MAX, "--property=MemorySwapMax=0",
                 "--property=CPUQuota=" + B.UNIT_CPU_QUOTA,
                 "--property=RuntimeMaxSec=%d" % B.UNIT_RUNTIME_MAX_SEC,
                 "--property=KillMode=control-group"):
        if want not in head:
            bad.append(f"systemd-run lacks {want}")
    if head[:1] != ["systemd-run"] or "--system" in head or "--scope" in head:
        bad.append("must be a systemd-run --user service")
    return bad


# ---------------------------------------------------------------- checks

def show(host, unit):
    rc, out, _ = host.run(["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState,SubState,"
                           "Result,InvocationID,MainPID,ControlGroup,ExecMainCode,ExecMainStatus"], timeout=15)
    props = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    props["_rc"] = rc
    return props


def host_available(host):
    return B.meminfo_bytes(host.read("/proc/meminfo")).get("MemAvailable", 0)


def preflight(host, plan, arm=None, live=False):
    """Strict recheck before every boot. Returns problems; empty means go.
    live=True adds the unit and log checks that run only under --execute."""
    problems = []

    def check(fn, what):
        try:
            if not fn():
                problems.append(what)
        except (OSError, ValueError, KeyError) as e:
            problems.append(f"{what}: {e}")

    check(lambda: RG.check(plan["production_guests"], host.guests(), plan["pending_production_bytes"]) >= 0,
          "unchanged guests and full nominal production reservation")
    check(lambda: plan["required_available_bytes"] == B.required_available(plan["pending_production_bytes"]), "resource formula")
    p = plan["pins"]
    arms = [arm] if arm else plan["arms"]
    check(lambda: host.euid() != 0, "must run as the unprivileged owner, not root")
    check(lambda: host.sha256(p["kernel"]["path"]) == B.KERNEL_SHA256, "kernel digest pin")
    check(lambda: host.sha256(p["firmware"]["path"]) == B.FIRMWARE_SHA256, "firmware digest pin")
    check(lambda: host.sha256(plan["qemu"]["path"]) == plan["qemu"]["sha256"], "qemu binary identity")
    for a in arms:
        check(lambda a=a: host.sha256(a["initramfs"]) == a["initramfs_sha256"], f"arm {a['arm']} initramfs digest")
        q = a["argv"][a["argv"].index("--") + 1:]
        check(lambda q=q, a=a: not qemu_violations(q, a["initramfs"]), f"arm {a['arm']} qemu argv invariants")
        check(lambda a=a: not unit_violations(a["argv"], a["unit"]), f"arm {a['arm']} unit argv invariants")
    check(lambda: B.model_identity(B.MODEL_PATH, host.stat) == plan["model_identity"],
          "model stat identity (dev/ino/size/mtime/ctime)")
    paths = [B.MODEL_PATH, p["kernel"]["path"], p["firmware"]["path"], plan["qemu"]["path"], plan["out"]]
    for path in paths + [a["initramfs"] for a in arms]:
        check(lambda path=path: host.storage_check(path), f"storage backing of {path} (USB/removable refused)")
    for dev in ("/dev/kvm", "/dev/sev"):
        check(lambda dev=dev: host.access_rw(dev), f"{dev} read/write access")
    check(lambda: host_available(host) >= plan["required_available_bytes"],
          "host MemAvailable >= 48 GiB + 2 GiB + pending production + 18 GiB")
    if live:
        for a in arms:
            check(lambda a=a: not host.exists(a["serial_log"]), f"{a['serial_log']} must not exist")
            check(lambda a=a: show(host, a["unit"]).get("LoadState") == "not-found",
                  f"unit {a['unit']} must not exist yet")
    return problems


# ---------------------------------------------------------------- plan

def make_plan(host, args):
    out = os.path.abspath(args.out)
    if out.startswith(B.RELEASE + "/") or out == B.RELEASE:
        raise ValueError("plan directory may not be inside the production release")
    manifest = json.loads(host.read(os.path.join(os.path.abspath(args.build_dir), "build-manifest.json")))
    pending = args.pending_production_ram_mib * B.MiB
    required = B.required_available(pending)
    qemu = os.path.abspath(args.qemu)
    run_id = secrets.token_hex(16)
    plan = {
        "kind": "shield-loader-only-snp-ab-plan",
        "run_id": run_id,
        "out": out,
        "pins": {"kernel": {"path": manifest["inputs"]["kernel"]["path"], "sha256": B.KERNEL_SHA256},
                 "firmware": {"path": manifest["inputs"]["firmware"]["path"], "sha256": B.FIRMWARE_SHA256},
                 "model": {"path": B.MODEL_PATH, "size": B.MODEL_SIZE, "sha256": B.MODEL_SHA256,
                           "verified": "inside guest by shieldmodel; host stat only"},
                 "init": manifest["inputs"]["init"], "loader": manifest["inputs"]["loader"]},
        "build_manifest_sources": manifest["sources"],
        "qemu": {"path": qemu, "sha256": host.sha256(qemu)},
        "cpu_model": args.cpu_model,
        "model_identity": B.model_identity(B.MODEL_PATH, host.stat),
        "production_guests": host.guests(),
        "pending_production_bytes": pending,
        "required_available_bytes": required,
        "host_floor_bytes": B.HOST_FLOOR,
        "unit_limits": {"MemoryMax": B.UNIT_MEMORY_MAX, "MemorySwapMax": "0", "CPUQuota": B.UNIT_CPU_QUOTA,
                        "RuntimeMaxSec": B.UNIT_RUNTIME_MAX_SEC, "KillMode": "control-group"},
        "snp_claim": B.SNP_CLAIM,
        "arms": [],
    }
    for arm in args.order:
        m = manifest["arms"][arm]
        unit = f"shield-snp-ab-{run_id}-{arm}.service"
        serial = os.path.join(out, f"serial-{arm}.log")
        q = B.qemu_argv(qemu, args.cpu_model, plan["pins"]["kernel"]["path"], plan["pins"]["firmware"]["path"],
                        m["initramfs"], B.MODEL_PATH, serial)
        plan["arms"].append({"arm": arm, "unit": unit, "initramfs": m["initramfs"],
                             "initramfs_sha256": m["sha256"], "serial_log": serial,
                             "argv": B.systemd_run_argv(unit, q)})
    os.mkdir(out, 0o755)  # refuses an existing directory; readable for root review
    plan["plan_time_problems"] = preflight(host, plan)
    data = (json.dumps(plan, indent=2, sort_keys=True) + "\n").encode()
    write_new(os.path.join(out, "plan.json"), data)
    return plan, hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- one arm

def pid_starttime(host, pid):
    s = host.read(f"/proc/{pid}/stat")
    return s[s.rindex(")") + 2:].split()[19]


def same_process(host, pid, start):
    try:
        return pid > 0 and pid_starttime(host, pid) == start
    except (OSError, ValueError, IndexError):
        return False


def sample_cgroup(host, cg):
    s = {}
    for f in ("memory.current", "memory.peak"):
        try:
            s[f] = int(host.read(os.path.join(cg, f)).strip())
        except (OSError, ValueError):
            pass
    try:
        st = dict(l.split() for l in host.read(os.path.join(cg, "memory.stat")).splitlines() if len(l.split()) == 2)
        s["stat"] = {k: int(st[k]) for k in STAT_KEYS if k in st}
        s["_full_stat"] = st
    except (OSError, ValueError):
        pass
    return s


def stop_owned(host, h, why):
    """Stop only our unit, and only while it is still the invocation we started."""
    props = show(host, h["unit"])
    if props.get("LoadState") == "not-found":
        return
    if h.get("invocation_id") and props.get("InvocationID") not in ("", h["invocation_id"]):
        h["cleanup_error"] = f"{why}: invocation changed; refusing to stop"
        return
    h.setdefault("stops", []).append(why)
    host.run(["systemctl", "--user", "stop", h["unit"]], timeout=60)


def watch(host, plan, h, cg):
    deadline = host.now() + B.UNIT_RUNTIME_MAX_SEC + 20
    h["samples"] = samples = []
    while True:
        avail = host_available(host)
        props = show(host, h["unit"])
        s = {"t": host.wall(), "host_available": avail, "state": props.get("ActiveState", "") + "/" + props.get("SubState", "")}
        s.update(sample_cgroup(host, cg))
        full = s.pop("_full_stat", None)
        if full:
            h["last_memory_stat"] = full
        samples.append(s)
        if "memory.peak" in s:
            h["unit_memory_peak_last_sample"] = s["memory.peak"]
        h["unit_memory_current_max"] = max(h.get("unit_memory_current_max", 0), s.get("memory.current", 0))
        if props.get("InvocationID") not in ("", h["invocation_id"]):
            h["identity_error"] = "unit invocation changed while running"
            return
        try:
            RG.check(plan["production_guests"], host.guests(exclude_pid=h["main_pid"]), plan["pending_production_bytes"])
        except (OSError, ValueError) as e:
            h["identity_error"] = "production guests changed: " + str(e)
            stop_owned(host, h, "production_guests_changed")
            return
        if avail < B.HOST_FLOOR + plan["pending_production_bytes"]:
            h["watchdog_stop"] = "low_host_memory"
            stop_owned(host, h, "low_host_memory")
            return
        if props.get("ActiveState") in ("failed", "inactive") or props.get("SubState") == "exited":
            for k in ("Result", "ExecMainCode", "ExecMainStatus"):
                h[k.lower().replace("execmain", "exec_main_")] = props.get(k)
            return
        if host.now() > deadline:
            h["watchdog_stop"] = "host_deadline"
            stop_owned(host, h, "host_deadline")
            return
        host.sleep(1)


def cleanup(host, h):
    props = show(host, h["unit"])
    if props.get("LoadState") != "not-found":
        if h.get("invocation_id") and props.get("InvocationID") not in ("", h["invocation_id"]):
            h["cleanup_error"] = "unit invocation changed; not touching it"
            return
        if props.get("ActiveState") != "inactive":
            host.run(["systemctl", "--user", "stop", h["unit"]], timeout=60)
        if show(host, h["unit"]).get("ActiveState") == "failed":
            host.run(["systemctl", "--user", "reset-failed", h["unit"]], timeout=15)
    pid, start = h.get("main_pid", 0), h.get("main_pid_start")
    if pid and same_process(host, pid, start):
        # Same PID and start time as the QEMU we launched: ours, still alive.
        host.kill(pid, signal.SIGKILL)
        host.sleep(1)
    final = show(host, h["unit"])
    if final.get("LoadState") != "not-found" and final.get("ActiveState") != "inactive":
        h["cleanup_error"] = f"unit still {final.get('ActiveState')}"
    elif pid and same_process(host, pid, start):
        h["cleanup_error"] = f"qemu pid {pid} still alive"
    else:
        h["cleanup"] = "clean"


class ArmEnded(Exception):
    pass


def run_arm(host, plan, a):
    h = {"arm": a["arm"], "unit": a["unit"], "started_at": host.wall()}
    started = False
    try:
        problems = preflight(host, plan, a, live=True)
        if problems:
            h["preflight_error"] = problems
            raise ArmEnded()
        started = True
        rc, _, err = host.run(a["argv"], timeout=60)
        if rc != 0:
            h["start_error"] = (err or "").strip()[-2000:] or f"systemd-run exit {rc}"
            raise ArmEnded()
        props = show(host, a["unit"])
        h["invocation_id"] = props.get("InvocationID", "")
        h["control_group"] = props.get("ControlGroup", "")
        h["main_pid"] = int(props.get("MainPID") or 0)
        if not h["invocation_id"] or not h["control_group"] or not h["main_pid"]:
            h["start_error"] = "unit identity unavailable after start"
            raise ArmEnded()
        h["main_pid_start"] = pid_starttime(host, h["main_pid"])
        exe = host.readlink(f"/proc/{h['main_pid']}/exe")
        if os.path.realpath(exe) != os.path.realpath(plan["qemu"]["path"]):
            h["identity_error"] = f"main pid runs {exe}"
            stop_owned(host, h, "identity")
            raise ArmEnded()
        cg = CGROUP_FS + h["control_group"]
        limits = {f: host.read(os.path.join(cg, f)).strip() for f in ("memory.max", "memory.swap.max", "cpu.max")}
        h["unit_limits_observed"] = limits
        if limits != {"memory.max": str(50 * B.GiB), "memory.swap.max": "0", "cpu.max": "200000 100000"}:
            h["limits_error"] = "cgroup limits not as planned"
            stop_owned(host, h, "limits")
            raise ArmEnded()
        watch(host, plan, h, cg)
    except ArmEnded:
        pass
    except Exception as e:  # noqa: BLE001 - recorded, and cleanup still runs
        h["helper_error"] = repr(e)
    finally:
        if started:
            cleanup(host, h)
    return finish(host, plan, a, h)


def finish(host, plan, a, h):
    guest = {"complete": False}
    if not h.get("preflight_error") and host.exists(a["serial_log"]):
        guest = B.guest_report(*B.parse_serial(host.read_bytes(a["serial_log"])))
    try:
        h["model_identity_changed"] = B.model_identity(B.MODEL_PATH, host.stat) != plan["model_identity"]
    except (OSError, ValueError):
        h["model_identity_changed"] = True
    samples = h.pop("samples", [])
    if samples:
        write_new(os.path.join(plan["out"], f"host-samples-{a['arm']}.jsonl"),
                  "".join(json.dumps(s, sort_keys=True) + "\n" for s in samples).encode())
    h["sample_count"] = len(samples)
    outcome = B.classify_arm(a["arm"], h, guest)
    killed = bool(h.get("watchdog_stop") or h.get("stops"))
    return {
        "arm": a["arm"],
        "outcome": outcome,
        "success": outcome == "success",
        "guest_poweroff": guest.get("poweroff_record", False) and not killed
                          and h.get("exec_main_code") == "1" and h.get("exec_main_status") == "0",
        "digest_verified": bool(guest.get("digest_verified")) and not killed,
        "metrics_available": bool(guest.get("metrics_available")),
        "error": None if outcome == "success" else outcome,
        "host": h,
        "guest": guest,
    }


# ---------------------------------------------------------------- execute

def execute(host, args):
    raw = host.read_bytes(os.path.abspath(args.plan))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.approve_plan_sha256:
        raise ValueError(f"plan sha256 {digest} != approved {args.approve_plan_sha256}")
    plan = json.loads(raw)
    receipt_path = os.path.join(plan["out"], "receipt.json")
    if not args.execute:
        print(json.dumps({"dry_run": True, "plan_sha256": digest,
                          "preflight_now": preflight(host, plan),
                          "would_run": [a["argv"] for a in plan["arms"]]}, indent=2))
        print("dry run only: add --execute --coordinated-slot <id> to boot", file=sys.stderr)
        return 0
    if not args.coordinated_slot:
        raise ValueError("--execute needs --coordinated-slot: a 48 GiB VM is not a small-queue job")
    if host.exists(receipt_path):
        raise ValueError(f"{receipt_path} exists")
    receipt = {"kind": "shield-loader-only-snp-ab-receipt", "plan_sha256": digest,
               "coordinated_slot": args.coordinated_slot, "snp_claim": B.SNP_CLAIM, "arms": []}
    try:
        for a in plan["arms"]:
            r = run_arm(host, plan, a)
            receipt["arms"].append(r)
            if not r["success"]:
                break
    finally:
        done = {r["arm"] for r in receipt["arms"]}
        receipt["arms"] += [{"arm": a["arm"], "outcome": "not_run", "success": False}
                            for a in plan["arms"] if a["arm"] not in done]
        receipt["success"] = len(receipt["arms"]) == 2 and all(r["success"] for r in receipt["arms"])
        write_new(receipt_path, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    print(json.dumps({"receipt": receipt_path, "success": receipt["success"],
                      "outcomes": {r["arm"]: r["outcome"] for r in receipt["arms"]}}))
    return 0 if receipt["success"] else 1


def main(argv=None, host=None):
    host = host or Host()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--build-dir", required=True)
    p.add_argument("--out", required=True, help="new directory for plan, serial logs, samples, receipt")
    p.add_argument("--qemu", required=True, help="absolute path of the SNP-capable qemu-system-x86_64")
    p.add_argument("--cpu-model", required=True, help="QEMU -cpu model, pinned in the plan (e.g. EPYC-v4)")
    p.add_argument("--pending-production-ram-mib", type=int, required=True,
                   help="RAM of the pending production image; refused below 1551")
    p.add_argument("--order", choices=["AB", "BA"], default="AB")
    e = sub.add_parser("execute")
    e.add_argument("--plan", required=True)
    e.add_argument("--approve-plan-sha256", required=True)
    e.add_argument("--execute", action="store_true", help="actually boot; default is a dry run")
    e.add_argument("--coordinated-slot", help="KVM coordinator slot id for the 48 GiB VM")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "plan":
            plan, digest = make_plan(host, args)
            print(json.dumps({"plan": os.path.join(plan["out"], "plan.json"), "plan_sha256": digest,
                              "plan_time_problems": plan["plan_time_problems"]}, indent=2))
            return 0
        return execute(host, args)
    except (OSError, ValueError, KeyError) as err:
        print(f"refused: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
