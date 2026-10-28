#!/usr/bin/env python3
"""Full-model SNP A/B helper for the shieldmodel drop-cache marker (FULL.md, REVISION.md).

  stage    Copy the production release template once per arm, checking every
           file against release.json. B swaps in the candidate shieldmodel and
           adds the drop-cache marker; A1 swaps the loader only. Writes a
           manifest and asserts the arms differ only there. Runs no command.
  plan     Read-only checks; writes a new plan dir with plan.json (0444) and
           prints its sha256. Runs no command except read-only nvidia-smi
           queries at preflight. --reservations (root-reviewed) switches the
           RAM accounting to the guestd snapshot formula and/or the GPU policy
           to shared cards; without it both stay strict.
  execute  Needs --plan and --approve-plan-sha256. Without --execute it is a
           dry run. With --execute --coordinated-slot it runs the arms
           serially: bench rings, two bench workers, one SNP guest, the
           localhost forwarder, a bounded wait for the public serial's
           DOM started/serving lines (untrusted timing only), attested
           public-probe requests, cleanup.

It owns only units named fullbench-<run>-* that it saw absent before creating
and whose InvocationID/MainPID start it recorded after, its own ring dir and pad
banks. It never touches guestd, production units, production rings or GPU
workers, uses no QMP, wallet, signing, lease or ticket, and never reads the
model. The optional guestd probe reads the pairing key in its own process and
prints sanitized numbers only; this helper never opens the key file.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "bench-harness"))
import benchlib as B  # noqa: E402
import resource_guard as RG  # noqa: E402
from build_initramfs import write_new  # noqa: E402

MiB, GiB = 1 << 20, 1 << 30
RELEASE = B.RELEASE
GUEST_FLOOR_MIB = 51200          # installed contract minimum [user]; never lower
GUEST_MAX_SNAPSHOT_MIB = 57344   # 56 GiB: the largest guest the snapshot option may plan [user]
UNIT_OVERHEAD_MIB = 768          # run-domain.sh MemoryMax = mem + 768M
FIXED_RESERVE = 13 * GiB         # strict mode: resident custodian 3 + control 4 + image 6, counted again [user]
HOST_FLOOR = 18 * GiB            # canary floor [user]
VCPUS, CPU_QUOTA = 16, "1600%"   # guestd 27B policy (inference_test.go)
RING_BYTES = 67108864
CID_LO, CID_HI = 200000, 210000  # disjoint from guestd 131072-196607 and run-domain 65536-131071
DROP_MARKER = "rt/shield-model-drop-cache.enabled"
LOADER = "shieldmodel"
ARMS = ("A", "B", "A1")
SAFE = re.compile(r"^[A-Za-z0-9/._+-]+$")
GPU_UUID = re.compile(r"^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CPUSET = re.compile(r"^\d+(-\d+)?(,\d+(-\d+)?)*$")
FWD_LINE = re.compile(r"^FWD listening 127\.0\.0\.1:(\d+) ")
LOOPBACK_URL = re.compile(r"^https?://(127\.0\.0\.1|\[::1\]):\d{1,5}$")
CGROUP_PATH = re.compile(r"^/[A-Za-z0-9@._:+-]+(/[A-Za-z0-9@._:+-]+)*\.(service|scope)$")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

# public serial startup markers (STARTUP-READINESS.md): dominit.c prints SECCOMP then STARTED once spawn_app returns
# (the app has exec'd, dropped and filtered); the front prints SERVING. UNTRUSTED timing only, never attestation.
DOM_SECCOMP = re.compile(r"^DOM seccomp: app filter installed \(sha256 [0-9a-f]{64}, \d+ rules\)$")
DOM_STARTED = re.compile(r"^DOM started app=(\d+) front=(\d+) at_ms=(\d+)$")
DOM_SERVING = re.compile(r"^DOM serving vsock=\d+ spki_sha256=([0-9a-f]{64}) ready_ms=(\d+)$")
DOM_FATAL = re.compile(r"^DOM (ERROR\b|end$)")
DOM_DECLINED = re.compile(r"^DOM Shield model declined\b")   # FULL.md; the only evidence accepted for model_declined

# wasi-nn registry graph (GRAPH-SELECTION.md): installed dominit.c shield_profile passes -S nn-graph=ggml::/models/<model>
# and the runtime registers a preloaded dir under its basename. probe-bench otherwise asks for "model", which is not loaded.
SHIELD_GRAPH = "qwen3.8-27b-mtp-q4-vl-gguf"
GRAPH_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,62}")   # dominit reads the name with %63s; the probe never percent-decodes
LOAD_NOT_FOUND = re.compile(r"NotFound|\"not-found\"")
READINESS_SIGNAL = ("untrusted serial timing only: gates WHEN the first attested request is sent, never whether it is "
                    "trusted; every request still needs a fresh client.mjs VERDICT attested")

# explicit opt-in benchmark firmware (EXPERIMENTAL-FIRMWARE.md); never discovered, never the default
EXPERIMENTAL_FW_SCOPE = ("experimental benchmark firmware: a NEW build, not the installed original release firmware and "
                         "not production-qualified; arm --measurement predictions must be root-computed for this exact "
                         "binary and every arm still needs a fresh client.mjs VERDICT attested")

# shared-GPU option [user, FULL-ROOT-FACTS]
SHIELD_CARD_BYTES = 33285996544               # guestd /health cardBudgetBytes (31 GiB)
MANIFEST_CARD_BYTES = SHIELD_CARD_BYTES // 2  # 500 milli = 16642998272 B (15.5 GiB) per card
BENCH_VRAM_MAX_GB = 16
PRODUCTION_PORTS = {9501, 9502, 9611}         # v100-0, v100-1, the 3070 test worker; never reused even in a netns

# bounds: every wait is finite, every read is capped
START_TIMEOUT = 5
STOP_TIMEOUT = 15
STOP_SETTLE = 30
WORKER_SETTLE = 10
WORKER_START_SEC = 120
FWD_FIRST_LINE_SEC = 30
PROBE_TIMEOUT = 20
STARTUP_ALLOW_SEC = 900
CHILD_WAIT = 10
CLIENT_OUT_CAP = 1 << 20
FWD_OUT_CAP = 4096
PROBE_TAIL_CAP = 1 << 16
STARTUP_READY_SEC = 180          # after the fwd line: boot + model copy-verify + front + app start (smoke: ~37 s guest)
SERIAL_HEAD_CAP = 8 << 20


class Stop(Exception):
    """A watchdog or bounded-wait stop. Production always wins."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def release_manifest(release=RELEASE):
    with open(os.path.join(release, "release.json")) as f:
        return json.load(f)


def required_available(guest_mib, worker_max_mib, pending_extra_bytes):
    """Strict mode (FULL.md section 5). Every term explicit; nothing is shaved to fit."""
    if guest_mib < GUEST_FLOOR_MIB:
        raise ValueError(f"guest {guest_mib} MiB is below the installed floor {GUEST_FLOOR_MIB} MiB")
    if pending_extra_bytes < 0 or worker_max_mib <= 0:
        raise ValueError("pending_extra must be >= 0 and worker MemoryMax > 0")
    return (FIXED_RESERVE + (guest_mib + UNIT_OVERHEAD_MIB) * MiB + 2 * worker_max_mib * MiB
            + pending_extra_bytes + HOST_FLOOR)


def required_snapshot(guestd_pending_mib, other_mib, bench_mib, helper_cap_mib, extra_headroom_mib):
    """Snapshot mode (REVISION.md): what production may still draw, plus the bench's own remaining caps, plus 18 GiB."""
    for v in (guestd_pending_mib, other_mib, bench_mib, helper_cap_mib, extra_headroom_mib):
        if not isinstance(v, int) or v < 0:
            raise ValueError("every snapshot term must be an explicit integer >= 0")
    return HOST_FLOOR + (guestd_pending_mib + other_mib + bench_mib + helper_cap_mib + extra_headroom_mib) * MiB


# ---------------------------------------------------------------- pool.go accounting

def held_mib(current_text, stat_text):
    """pool.go readUnitMemMiB: memory.current less active_file + inactive_file, in MiB rounded DOWN."""
    n = int(current_text.strip())
    if n < 0:
        raise ValueError("memory.current is negative")
    cache, seen = 0, 0
    for l in stat_text.splitlines():
        f = l.split()
        if len(f) == 2 and f[0] in ("active_file", "inactive_file"):
            v = int(f[1])
            if v < 0:
                raise ValueError(f"memory.stat {f[0]} is negative")
            cache += v
            seen += 1
    if seen != 2:
        raise ValueError("memory.stat lacks active_file/inactive_file")
    return max(n - cache, 0) >> 20


def remaining_mib(host, cgroup, budget_mib):
    """pool.go pendingLocked for one unit: (what it may still draw, what it holds). Unreadable = whole budget."""
    if not cgroup:
        return budget_mib, None
    try:
        held = held_mib(host.read(f"/sys/fs/cgroup{cgroup}/memory.current"),
                        host.read(f"/sys/fs/cgroup{cgroup}/memory.stat"))
    except (OSError, ValueError):
        return budget_mib, None
    return max(budget_mib - held, 0), held


# ---------------------------------------------------------------- reservations (root-reviewed)

def _nat(v, what, lo=0):
    if not isinstance(v, int) or isinstance(v, bool) or v < lo:
        raise ValueError(f"{what} must be an integer >= {lo}")
    return v


def check_snapshot(s):
    """Schema of guestd_commitments_probe.mjs output. Anything else (including its error line) is refused."""
    if not isinstance(s, dict) or s.get("kind") != "guestd-commitments/1":
        raise ValueError("not a guestd-commitments/1 snapshot")
    if not re.fullmatch(r"[0-9a-f]{16}", str(s.get("instance", ""))):
        raise ValueError("snapshot instance identity")
    pool, inf = s["pool"], s["inference"]
    if _nat(pool["floorMiB"], "floorMiB") == 0:
        raise ValueError("guestd host floor is off, so pendingMiB is not computed")
    for k in ("allocatedMemMiB", "guests", "pendingMiB", "unreadUnits"):
        _nat(pool[k], k)
    for k in ("cardBudgetBytes", "cardAllocatedBytes", "cardFreeBytes"):
        _nat(inf[k], k)
    if inf["cards"] != 2:
        raise ValueError("guestd does not report two cards")
    held = s["held"]
    if not isinstance(held, list):
        raise ValueError("snapshot held must be a list")
    for g in held:
        if not re.fullmatch(r"[0-9a-f]{16}", str(g.get("idSha256", ""))) or not re.fullmatch(r"[a-z_-]{1,16}", str(g.get("status", ""))):
            raise ValueError("held guest identity/status")
        for k in ("memMiB", "cpuPct", "gpuCardBytes"):
            _nat(g[k], k)
    if len(held) != pool["guests"] or sum(g["memMiB"] for g in held) != pool["allocatedMemMiB"] or sum(g["gpuCardBytes"] for g in held) != inf["cardAllocatedBytes"]:
        raise ValueError("guestd health/vms reservations are inconsistent")
    _nat(s.get("seq", 0), "seq")
    return s


def snapshot_changes(pinned, live):
    """Production changed since root reviewed the plan: yield. pendingMiB may move; it is used, not pinned."""
    bad = []
    if live["instance"] != pinned["instance"]:
        bad.append("guestd instance changed")
    key = lambda g: (g["idSha256"], g["status"], g["memMiB"], g["cpuPct"], g["gpuCardBytes"])  # noqa: E731
    if sorted(map(key, live["held"])) != sorted(map(key, pinned["held"])):
        bad.append("guestd held/starting guests changed")
    for k in ("cardBudgetBytes", "cardAllocatedBytes"):
        if live["inference"][k] != pinned["inference"][k]:
            bad.append(f"guestd GPU {k} changed")
    if live["inference"].get("modelFloorsMiB") != pinned["inference"].get("modelFloorsMiB"):
        bad.append("guestd model floors changed")
    if any(live["pool"][k] != pinned["pool"][k] for k in ("allocatedMemMiB", "guests", "floorMiB")):
        bad.append("guestd pool allocation/floor changed")
    if live["pool"]["unreadUnits"] != pinned["pool"]["unreadUnits"]:
        bad.append("guestd unread units changed")
    return bad


def validate_reservations(r, gpu_uuids):
    """Returns (guestd, memory, gpu); memory/gpu are None when that section is absent (strict)."""
    if r.get("kind") != "fullbench-reservations/1":
        raise ValueError("unknown reservations kind")
    g = r["guestd"]
    if not LOOPBACK_URL.match(g["url"]):
        raise ValueError("guestd url must be the root-verified loopback address")
    for k in ("key_file", "client", "probe"):
        if not os.path.isabs(g[k]) or not SAFE.match(g[k]):
            raise ValueError(f"guestd {k} must be an absolute plain path")
    for k in ("client_sha256", "probe_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", g[k]):
            raise ValueError(f"guestd {k}")
    guestd = {k: g[k] for k in ("url", "key_file", "client", "client_sha256", "probe", "probe_sha256")}
    guestd["snapshot"] = check_snapshot(g["snapshot"])
    memory = gpu = None
    if r.get("memory") is not None:
        m = r["memory"]
        units = []
        for u in m["other_units"]:
            if not CGROUP_PATH.match(u["cgroup"]) or ".." in u["cgroup"]:
                raise ValueError(f"other unit cgroup {u['cgroup']!r}")
            units.append({"name": str(u["name"]), "cgroup": u["cgroup"], "budget_mib": _nat(u["budget_mib"], "budget_mib", 1)})
        if not units:
            raise ValueError("snapshot memory needs the reviewed control/custodian units (memory.max is max there)")
        memory = {"mode": "snapshot", "other_units": units,
                  "helper_cap_mib": _nat(m["helper_cap_mib"], "helper_cap_mib", 256),
                  "extra_headroom_mib": _nat(m["extra_headroom_mib"], "extra_headroom_mib", 512)}
    if r.get("gpu") is not None:
        cards = {}
        for u in gpu_uuids:
            c = r["gpu"]["cards"][u]
            allowed = [{"pid": _nat(a["pid"], "pid", 2), "start": str(a["start"]), "required": bool(a["required"]),
                        "used_mib_max": _nat(a["used_mib_max"], "used_mib_max")} for a in c["allowed"]]
            if not re.fullmatch(r"\d+", "".join(a["start"] for a in allowed) or "0"):
                raise ValueError("allowed start times are /proc/<pid>/stat field 22")
            cards[u] = {"allowed": allowed, "unlisted_mib_max": _nat(c["unlisted_mib_max"], "unlisted_mib_max")}
        gpu = {"mode": "shared", "cards": cards,
               "context_headroom_mib": _nat(r["gpu"]["context_headroom_mib"], "context_headroom_mib", 512)}
    if memory is None and gpu is None:
        raise ValueError("reservations name neither memory nor gpu; omit --reservations for strict mode")
    return guestd, memory, gpu


# ---------------------------------------------------------------- stage

def _copy_new(src, dst):
    with open(src, "rb") as f:
        write_new(dst, f.read(), mode=os.stat(src).st_mode & 0o755)


def stage(release, candidate_loader, out, arms=ARMS):
    rel = release_manifest(release)
    files = {k[len("template/"):]: v for k, v in rel["files"].items() if k.startswith("template/")}
    on_disk = set()
    for root, dirs, names in os.walk(os.path.join(release, "template")):
        for n in names:
            on_disk.add(os.path.relpath(os.path.join(root, n), os.path.join(release, "template")))
    if on_disk != set(files):
        raise ValueError(f"template differs from release.json: {sorted(on_disk ^ set(files))[:8]}")
    B.check_static_elf_amd64(candidate_loader)
    cand_sha = B.sha256_file(candidate_loader)
    if cand_sha == files[LOADER]["sha256"]:
        raise ValueError("candidate loader is byte-identical to production; nothing to compare")
    os.mkdir(out, 0o755)
    manifest = {"kind": "shield-full-bench-stage/1", "release_id_files_sha256": B.sha256_file(os.path.join(release, "release.json")),
                "candidate_loader_sha256": cand_sha, "arms": {}}
    for arm in arms:
        d = os.path.join(out, arm)
        os.mkdir(d, 0o755)
        for sub in rel["dirs"]:
            if sub.startswith("template/"):
                os.makedirs(os.path.join(d, sub[len("template/"):]), 0o755, exist_ok=True)
        digests = {}
        for rp, meta in sorted(files.items()):
            src = os.path.join(release, "template", rp)
            if B.sha256_file(src) != meta["sha256"] or os.path.getsize(src) != meta["size"]:
                raise ValueError(f"production file does not match release.json: {rp}")
            if rp == LOADER and arm in ("B", "A1"):
                _copy_new(candidate_loader, os.path.join(d, rp))
                digests[rp] = cand_sha
            else:
                _copy_new(src, os.path.join(d, rp))
                digests[rp] = meta["sha256"]
        if arm == "B":
            write_new(os.path.join(d, DROP_MARKER), b"1\n", mode=0o644)
            digests[DROP_MARKER] = hashlib.sha256(b"1\n").hexdigest()
        manifest["arms"][arm] = digests
    a = manifest["arms"]["A"]
    for arm, want in (("B", {LOADER, DROP_MARKER}), ("A1", {LOADER})):
        if arm in manifest["arms"]:
            got = {k for k in set(a) | set(manifest["arms"][arm]) if a.get(k) != manifest["arms"][arm].get(k)}
            if got != want:
                raise ValueError(f"arm {arm} differs from A in {sorted(got)}, expected {sorted(want)}")
    data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    write_new(os.path.join(out, "stage-manifest.json"), data)
    return manifest


# ---------------------------------------------------------------- firmware

def boot_firmware(p):
    """-bios for every arm: the original release pin unless the plan carries the explicit experimental pair."""
    x = p.get("experimental_firmware")
    return x["path"] if x else p["pins"]["firmware"]


def experimental_pair(path, sha):
    """Shape only, before anything is read: both flags or neither. None means the original release firmware."""
    if path is None and sha is None:
        return None
    if not path or not sha:
        raise ValueError("--experimental-firmware and --experimental-firmware-sha256 are required together")
    if not SHA256_HEX.match(sha):
        raise ValueError("--experimental-firmware-sha256 must be 64 lowercase hex")
    path = os.path.abspath(path)
    if not SAFE.match(path):
        raise ValueError(f"unsafe path for QEMU argv: {path}")
    return path, sha


def experimental_firmware_record(host, path, sha, release=RELEASE):
    """The hashed plan record for an opt-in firmware, or None. The file must already hash to the approved value."""
    pair = experimental_pair(path, sha)
    if pair is None:
        return None
    path, sha = pair
    if os.path.commonpath([path, os.path.abspath(release)]) == os.path.abspath(release):
        raise ValueError("experimental firmware may not live inside the production release")
    orig = release_manifest(release)["files"]["firmware.fd"]["sha256"]
    if sha == orig:
        raise ValueError("that sha256 is the original release firmware; omit the experimental flags")
    got = host.sha256(path)
    if got != sha:
        raise ValueError(f"experimental firmware sha256 {got} != approved {sha}")
    return {"path": path, "sha256": sha, "original_release_sha256": orig, "scope": EXPERIMENTAL_FW_SCOPE}


def firmware_problems(host, p, rel):
    """Preflight. The original release firmware must still match release.json whether or not a candidate is used;
    a candidate, when planned, must independently match its approved sha256."""
    bad = []

    def ident(path, want, what):
        try:
            if host.sha256(path) != want:
                bad.append(what)
        except OSError as e:
            bad.append(f"{what}: {e}")

    try:
        orig = rel["files"]["firmware.fd"]["sha256"]
    except KeyError:
        return ["firmware pin: release.json lacks firmware.fd"]
    pin = p["pins"]["firmware"]
    if pin != os.path.join(p["release"], "firmware.fd"):
        bad.append("firmware pin path is not the release firmware.fd")
    ident(pin, orig, "firmware pin")
    x = p.get("experimental_firmware")
    if x is None:
        return bad
    if not isinstance(x, dict) or x.get("scope") != EXPERIMENTAL_FW_SCOPE or not SHA256_HEX.match(str(x.get("sha256"))) \
            or not os.path.isabs(str(x.get("path"))) or not SAFE.match(str(x.get("path"))) or x["path"] == pin:
        return bad + ["experimental firmware record malformed"]
    if x.get("original_release_sha256") != orig:
        bad.append("experimental firmware: original release firmware.fd changed since plan")
    if x["sha256"] == orig:
        bad.append("experimental firmware is the original release firmware")
    ident(x["path"], x["sha256"], "experimental firmware identity")
    return bad


# ---------------------------------------------------------------- argv

def qemu_argv(p, arm):
    g = p["guest_mib"]
    return [p["qemu"]["path"],
            "-machine", "q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1",
            "-object", "sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on",
            "-object", f"memory-backend-memfd,id=ram1,size={g}M,share=true",
            "-cpu", "host", "-smp", str(VCPUS), "-m", f"{g}M",
            "-bios", boot_firmware(p), "-kernel", p["pins"]["kernel"], "-initrd", arm["image"],
            "-append", p["cmdline"], "-device", f"vhost-vsock-pci,guest-cid={arm['cid']}",
            "-object", f"memory-backend-file,id=sh0,mem-path={p['ring_dir']}/card-0,size=64M,share=on",
            "-device", "ivshmem-plain,memdev=sh0,addr=5",
            "-object", f"memory-backend-file,id=sh1,mem-path={p['ring_dir']}/card-1,size=64M,share=on",
            "-device", "ivshmem-plain,memdev=sh1,addr=6",
            "-drive", f"file={B.MODEL_PATH},format=raw,if=virtio,readonly=on,cache=none",
            "-drive", f"file={arm['bank']},format=raw,if=none,id=padbank,cache=none",
            "-device", "virtio-blk-pci,drive=padbank,addr=0x10,logical_block_size=4096,physical_block_size=4096",
            "-nodefaults", "-monitor", "none", "-display", "none",
            "-serial", f"file:{arm['serial_log']}", "-no-reboot"]


def qemu_violations(q, p, arm):
    """Independent of qemu_argv: exactly the planned devices, no control socket."""
    bad, i, opts = [], 1, {}
    flags = {"-nodefaults", "-no-reboot"}
    valued = {"-machine", "-object", "-cpu", "-smp", "-m", "-bios", "-kernel", "-initrd", "-append",
              "-device", "-drive", "-monitor", "-display", "-serial"}
    while i < len(q):
        o = q[i]
        if o in flags:
            opts.setdefault(o, []).append(None); i += 1
        elif o in valued and i + 1 < len(q):
            opts.setdefault(o, []).append(q[i + 1]); i += 2
        else:
            return [f"option not allowed: {o}"]   # -S, -qmp, -chardev, -netdev, -nic, ...
    want_n = {"-object": 4, "-device": 4, "-drive": 2}
    for o in flags | valued:
        if len(opts.get(o, [])) != want_n.get(o, 1):
            bad.append(f"{o} count {len(opts.get(o, []))}")
    if bad:
        return bad
    one = {o: v[0] for o, v in opts.items()}
    if one["-machine"] != "q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1":
        bad.append("machine must bind the SNP guest and planned memory")
    if one["-monitor"] != "none" or one["-display"] != "none":
        bad.append("monitor/display must be none")
    if one["-m"] != f"{p['guest_mib']}M" or one["-smp"] != str(VCPUS) or one["-cpu"] != "host":
        bad.append("guest shape differs from plan")
    if p["guest_mib"] < GUEST_FLOOR_MIB:
        bad.append("guest below floor")
    if one["-initrd"] != arm["image"] or one["-append"] != p["cmdline"]:
        bad.append("initrd/cmdline differ from plan")
    if one["-bios"] != boot_firmware(p) or one["-kernel"] != p["pins"]["kernel"]:
        bad.append("kernel/firmware differ from pins")
    if one["-serial"] != f"file:{arm['serial_log']}":
        bad.append("serial must be the planned file")
    objs = opts["-object"]
    if f"memory-backend-memfd,id=ram1,size={p['guest_mib']}M,share=true" not in objs:
        bad.append("memfd backend")
    if "sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on" not in objs:
        bad.append("sev-snp-guest must be exact (no host-data)")
    for c in (0, 1):
        if f"memory-backend-file,id=sh{c},mem-path={p['ring_dir']}/card-{c},size=64M,share=on" not in objs:
            bad.append(f"ring {c} must be the bench ring")
    devs = opts["-device"]
    if sorted(devs) != sorted([f"vhost-vsock-pci,guest-cid={arm['cid']}", "ivshmem-plain,memdev=sh0,addr=5",
                               "ivshmem-plain,memdev=sh1,addr=6",
                               "virtio-blk-pci,drive=padbank,addr=0x10,logical_block_size=4096,physical_block_size=4096"]):
        bad.append("devices differ from plan")
    if not CID_LO <= arm["cid"] < CID_HI:
        bad.append("cid outside bench band")
    if opts["-drive"] != [f"file={B.MODEL_PATH},format=raw,if=virtio,readonly=on,cache=none",
                          f"file={arm['bank']},format=raw,if=none,id=padbank,cache=none"]:
        bad.append("drives must be model (first, read-only) then the bench bank")
    if not arm["bank"].startswith(p["bank_dir"] + "/fullbench-" + p["run_id"] + "-"):
        bad.append("bank not owned by this run")
    if not p["ring_dir"].startswith("/dev/shm/fullbench-" + p["run_id"]):
        bad.append("ring dir not owned by this run")
    return bad


def unit_argv(p, arm):
    return ["systemd-run", "--user", "--unit", arm["unit"], "--service-type=exec",
            f"--property=MemoryMax={p['guest_mib'] + UNIT_OVERHEAD_MIB}M", "--property=MemorySwapMax=0",
            f"--property=CPUQuota={CPU_QUOTA}", "--property=TasksMax=256",
            f"--property=AllowedCPUs={p['allowed_cpus']}", f"--property=RuntimeMaxSec={p['runtime_max_sec']}",
            "--property=KillMode=control-group", "--property=TimeoutStopSec=10", "--"] + qemu_argv(p, arm)


def worker_unit(p, card):
    return f"fullbench-{p['run_id']}-w{card}.service"


def worker_argv(p, card):
    w = p["workers"]
    return ["systemd-run", "--user", "--unit", worker_unit(p, card), "--service-type=exec",
            f"--property=MemoryMax={w['memory_max_mib']}M", "--property=MemorySwapMax=0",
            "--property=PrivateNetwork=yes", f"--property=RuntimeMaxSec={p['runtime_max_sec'] + 300}",
            "--property=KillMode=control-group", "--property=TimeoutStopSec=10",
            f"--setenv=CUDA_VISIBLE_DEVICES={w['gpu_uuids'][card]}", "--",
            w["path"], "--host", "127.0.0.1", "--port", str(w["ports"][card]), "--vram-gb", str(w["vram_gb"]),
            "--shm", f"{p['ring_dir']}/card-{card}"]


def client_argv(p, arm, port, path):
    t = p["trust"]
    a = [p["node"], p["client"], f"https://127.0.0.1:{port}", "--measurement", arm["measurement"],
         "--app-sha", p["app_sha"], "--runtime", p["pins"]["runtime"], "--vcek", t["vcek"],
         "--min-tcb", "@" + t["min_tcb"], "--no-kds", "--path", path, "--answer-within", "600000"]
    if t.get("amd_chain"):
        a += ["--amd-chain", t["amd_chain"]]
    return a


def probe_argv(p, every=0):
    g = p["guestd"]
    a = [p["node"], g["probe"], "--client", g["client"], "--client-sha256", g["client_sha256"],
         "--key-file", g["key_file"], "--url", g["url"]]
    if every:
        a += ["--every", str(every), "--max-sec", str(p["arm_wall_max_sec"])]
    return a


def probe_path(query, i):
    """graph is a plain registry name sent verbatim; every other value is an integer or "<n>+i"."""
    q = {}
    for k, v in query.items():
        if k == "graph":
            if not isinstance(v, str) or not GRAPH_NAME.fullmatch(v) or urllib.parse.quote_plus(v) != v:
                raise ValueError(f"bad workload graph {v!r}")
            q[k] = v
            continue
        if isinstance(v, str):
            m = re.fullmatch(r"(\d+)\+i", v)
            if not m:
                raise ValueError(f"bad workload value {k}={v}")
            v = int(m.group(1)) + i
        q[k] = int(v)
    return "/?" + urllib.parse.urlencode(sorted(q.items()))


def graph_problems(w):
    """Every step must name the preloaded registry graph; a missing graph falls back to the probe's "model"."""
    return [f"step {s.get('name')} graph {s.get('query', {}).get('graph')!r} is not the preloaded registry graph "
            f"{SHIELD_GRAPH}" for s in w.get("steps", []) if s.get("query", {}).get("graph") != SHIELD_GRAPH]


def load_workload(path):
    with open(path) as f:
        return check_workload(json.load(f))


def check_workload(w):
    if w.get("kind") != "shield-full-bench-workload/1":
        raise ValueError("unknown workload kind")
    bad = graph_problems(w)
    if bad:
        raise ValueError("; ".join(bad))
    for s in w["steps"]:
        q = s["query"]
        total = int(q.get("prompt", 17)) + int(q.get("shared", 0))
        if not 1 <= s["concurrency"] <= w["max_sessions"] or total > w["max_total_tokens_per_request"]:
            raise ValueError(f"step {s['name']} exceeds sessions or token bound")
        if s["concurrency"] * (total + int(q["steps"])) > w["pooled_ctx"] and int(q.get("shared", 0)) == 0:
            raise ValueError(f"step {s['name']} exceeds the pooled context without a shared prefix")
        for i in range(s["concurrency"]):
            probe_path(q, i)
    return w


# ---------------------------------------------------------------- host

class Host:
    def run(self, argv, timeout=60):
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return r.returncode, r.stdout, r.stderr

    def popen(self, argv, out_path):
        """stdout goes to a new 0600 file, never a pipe the helper could fail to drain."""
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=fd, stderr=subprocess.DEVNULL)
        finally:
            os.close(fd)

    def read(self, path):
        with open(path) as f:
            return f.read()

    def read_bytes(self, path):
        with open(path, "rb") as f:
            return f.read()

    def read_head(self, path, cap):
        with open(path, "rb") as f:
            return f.read(cap + 1)

    def read_tail(self, path, cap):
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(f.tell() - cap, 0))
            return f.read(cap)

    def pid_start(self, pid):
        """/proc/<pid>/stat field 22 (start time), or None when no such process."""
        try:
            st = self.read(f"/proc/{pid}/stat")
        except (FileNotFoundError, ProcessLookupError):
            return None
        return st[st.rindex(")") + 2:].split()[19]

    def cgroup_procs(self, cgroup):
        try:
            return [int(x) for x in self.read(f"/sys/fs/cgroup{cgroup}/cgroup.procs").split()]
        except FileNotFoundError:
            return None

    def exists(self, path):
        return os.path.lexists(path)

    def sha256(self, path):
        return B.sha256_file(path)

    def stat(self, path):
        return os.stat(path)

    def statvfs_free(self, path):
        s = os.statvfs(path)
        return s.f_bavail * s.f_frsize

    def access_rw(self, path):
        return os.access(path, os.R_OK | os.W_OK)

    def euid(self):
        return os.geteuid()

    def guests(self, exclude_pid=None):
        return RG.snapshot(exclude_pid=exclude_pid)

    def storage_check(self, path):
        return B.storage_check(path)

    def mkdir(self, path, mode):
        os.mkdir(path, mode)

    def make_sparse(self, path, size):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            os.ftruncate(fd, size)
        finally:
            os.close(fd)

    def unlink(self, path):
        os.unlink(path)

    def rmdir(self, path):
        os.rmdir(path)

    def now(self):
        return time.monotonic()

    def wall(self):
        return time.time()

    def sleep(self, s):
        time.sleep(s)


def gpu_problems(host, p, owned_pids=frozenset(), preflight=False):
    """Read-only nvidia-smi queries. Strict (default): any process other than the bench's own refuses. Shared (reviewed
    reservations only): every other process must be a pinned PID/start within its reviewed VRAM, and the card must hold
    bench cap + context headroom + reviewed maxima + guestd's committed allocation, all counted separately."""
    w, g = p["workers"], p.get("gpu")
    try:
        rc, out, _ = host.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory",
                               "--format=csv,noheader,nounits"], timeout=5)
        if rc != 0:
            return ["nvidia-smi compute-apps query failed"]
        apps = []
        for l in out.splitlines():
            if not l.strip():
                continue
            f = [x.strip() for x in l.split(",")]
            if len(f) != 3:
                return ["unparsed nvidia-smi compute-apps line"]
            apps.append((f[0], int(f[1]), int(f[2]) if f[2].isdigit() else None))
        rc, out, _ = host.run(["nvidia-smi", "--query-gpu=uuid,memory.used,memory.total",
                               "--format=csv,noheader,nounits"], timeout=5)
        if rc != 0:
            return ["nvidia-smi gpu query failed"]
        mem = {}
        for l in out.splitlines():
            f = [x.strip() for x in l.split(",")]
            if len(f) == 3:
                mem[f[0]] = (int(f[1]), int(f[2]))
    except (ValueError, subprocess.TimeoutExpired) as e:
        return [f"nvidia-smi: {e!r}"]
    bad = []
    bench_mib = w["vram_gb"] * 1024 + (g["context_headroom_mib"] if g else 1024)
    for u in w["gpu_uuids"]:
        if u not in mem:
            bad.append(f"{u} not present")
            continue
        used, total = mem[u]
        others = [(pid, mib) for gu, pid, mib in apps if gu == u and pid not in owned_pids]
        if preflight and total - used < bench_mib:
            bad.append(f"{u} free {total - used} MiB < bench cap + context {bench_mib} MiB")
        if g is None:
            if others:
                bad.append(f"{u} has compute processes {sorted(x for x, _ in others)} "
                           "(strict GPU policy; sharing needs reviewed --reservations)")
            continue
        card = g["cards"][u]
        allowed = {a["pid"]: a for a in card["allowed"]}
        seen = set()
        for pid, mib in others:
            a = allowed.get(pid)
            if a is None:
                bad.append(f"{u}: unknown compute process {pid}")
                continue
            if host.pid_start(pid) != a["start"]:
                bad.append(f"{u}: pid {pid} is not the reviewed process (start time differs)")
                continue
            if mib is None or mib > a["used_mib_max"]:
                bad.append(f"{u}: pid {pid} uses {mib} MiB, reviewed max {a['used_mib_max']} MiB")
            seen.add(pid)
        for pid, a in allowed.items():
            if a["required"] and pid not in seen:
                bad.append(f"{u}: reviewed production process {pid} is gone (inventory changed)")
        reviewed = sum(a["used_mib_max"] for a in allowed.values()) + card["unlisted_mib_max"]
        committed = -(-p["guestd"]["snapshot"]["inference"]["cardAllocatedBytes"] // MiB)
        if total < bench_mib + reviewed + committed:
            bad.append(f"{u}: total {total} MiB < bench {bench_mib} + reviewed {reviewed} + guestd committed {committed} MiB")
        if used > reviewed + (bench_mib if owned_pids else 0):
            bad.append(f"{u}: used {used} MiB exceeds reviewed processes + bench (unknown VRAM growth)")
    return bad


def available(host):
    return B.meminfo_bytes(host.read("/proc/meminfo")).get("MemAvailable", 0)


def show(host, unit):
    rc, out, _ = host.run(["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState,SubState,"
                           "Result,InvocationID,MainPID,ControlGroup,ExecMainCode,ExecMainStatus,ExecStart"], timeout=15)
    props = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    props["_rc"] = rc
    return props


def owned_unit(p, unit):
    return unit.startswith(f"fullbench-{p['run_id']}-") and unit.endswith(".service")


def guestd_probe(host, p):
    """One-shot read-only probe (a single guestd-control session). Raises on anything unexpected."""
    rc, out, _ = host.run(probe_argv(p), timeout=PROBE_TIMEOUT)
    if rc != 0 or len(out) > PROBE_TAIL_CAP:
        raise ValueError(f"guestd probe exit {rc}")
    return check_snapshot(json.loads(out))


def bench_remaining_mib(host, p, h):
    caps = {"guest": p["guest_mib"] + UNIT_OVERHEAD_MIB, "w0": p["workers"]["memory_max_mib"],
            "w1": p["workers"]["memory_max_mib"]}
    return sum(remaining_mib(host, (h["owned"].get(k) or {}).get("cgroup"), cap)[0] for k, cap in caps.items())


def need_bytes(host, p, h, preflight=False):
    """MemAvailable needed now. Bench units not yet started count their whole cap, started ones what they may still
    draw (pool.go). Snapshot mode uses the same formula at preflight and in the watchdog."""
    m = p.get("memory") or {"mode": "strict"}
    bench = bench_remaining_mib(host, p, h)
    if m["mode"] == "strict":
        return (FIXED_RESERVE if preflight else 0) + bench * MiB + p["pending_extra_bytes"] + HOST_FLOOR
    other = 0
    for u in m["other_units"]:
        rem, held = remaining_mib(host, u["cgroup"], u["budget_mib"])
        if held is not None and held > u["budget_mib"]:
            raise ValueError(f"{u['name']} holds {held} MiB, above its reviewed budget {u['budget_mib']} MiB")
        other += rem
    return required_snapshot(h["guestd_pending_mib"], other, bench, m["helper_cap_mib"], m["extra_headroom_mib"])


def plan_required(p):
    m = p.get("memory") or {"mode": "strict"}
    if m["mode"] == "strict":
        return required_available(p["guest_mib"], p["workers"]["memory_max_mib"], p["pending_extra_bytes"])
    bench = p["guest_mib"] + UNIT_OVERHEAD_MIB + 2 * p["workers"]["memory_max_mib"]
    return required_snapshot(p["guestd"]["snapshot"]["pool"]["pendingMiB"], sum(u["budget_mib"] for u in m["other_units"]),
                             bench, m["helper_cap_mib"], m["extra_headroom_mib"])


def preflight(host, p, arm=None, live=False, h=None):
    problems = []
    h = h if h is not None else {"owned": {}}
    mode = (p.get("memory") or {"mode": "strict"})["mode"]

    def check(fn, what):
        try:
            if not fn():
                problems.append(what)
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as e:
            problems.append(f"{what}: {e}")

    if mode == "strict":
        check(lambda: RG.check(p["production_guests"], host.guests(), FIXED_RESERVE + p["pending_extra_bytes"]) >= 0,
              "qemu inventory unchanged and covered by the fixed reserve")
    else:
        check(lambda: host.guests() == p["production_guests"], "qemu inventory unchanged")
        if not GUEST_FLOOR_MIB <= p["guest_mib"] <= GUEST_MAX_SNAPSHOT_MIB:
            problems.append(f"snapshot guest must be {GUEST_FLOOR_MIB}-{GUEST_MAX_SNAPSHOT_MIB} MiB")
    check(lambda: p["required_available_bytes"] == plan_required(p), "resource formula")
    problems += graph_problems(p["workload"])
    if p.get("guestd"):
        g = p["guestd"]
        check(lambda: host.sha256(g["probe"]) == g["probe_sha256"], "guestd probe identity")
        check(lambda: host.sha256(g["client"]) == g["client_sha256"], "guestd control-client identity")
        h["guestd_pending_mib"] = g["snapshot"]["pool"]["pendingMiB"]
        if live:
            def fresh():
                snap = guestd_probe(host, p)
                changed = snapshot_changes(g["snapshot"], snap)
                if changed:
                    raise ValueError("; ".join(changed))
                h["guestd_pending_mib"] = snap["pool"]["pendingMiB"]
                return True
            check(fresh, "live guestd commitments equal the reviewed snapshot")
    if p.get("gpu"):
        w = p["workers"]
        if not (w["vram_gb"] <= BENCH_VRAM_MAX_GB and w["vram_gb"] * GiB >= MANIFEST_CARD_BYTES):
            problems.append("shared cards: bench worker --vram-gb must cover the 15.5 GiB manifest cap and be <= 16")
    for port in p["workers"]["ports"]:
        if port in PRODUCTION_PORTS or not 1024 < port < 65536:
            problems.append(f"bench worker port {port} collides with production or is privileged")
    check(lambda: host.euid() != 0, "must run as the unprivileged owner")
    rel = release_manifest(p["release"])
    check(lambda: host.sha256(p["pins"]["kernel"]) == rel["files"]["kernel"]["sha256"], "kernel pin")
    problems += firmware_problems(host, p, rel)
    check(lambda: host.sha256(p["pins"]["runtime"]) == rel["files"]["template/rt/runtime.json"]["sha256"], "runtime pin")
    check(lambda: host.sha256(p["qemu"]["path"]) == p["qemu"]["sha256"], "qemu identity")
    check(lambda: host.sha256(p["workers"]["path"]) == p["workers"]["sha256"], "worker identity")
    for f in ("client", "fwd"):
        check(lambda f=f: host.sha256(p[f]) == p[f + "_sha256"], f"{f} identity")
    for k, path in trust_files(p).items():
        check(lambda k=k, path=path: host.sha256(path) == p["trust_sha256"][k], f"trust file {k} identity")
    check(lambda: B.model_identity(B.MODEL_PATH, host.stat) == p["model_identity"], "model stat identity")
    arms = [arm] if arm else p["arms"]
    for a in arms:
        check(lambda a=a: host.sha256(a["image"]) == a["image_sha256"], f"arm {a['arm']} image digest")
        check(lambda a=a: not qemu_violations(unit_argv(p, a)[unit_argv(p, a).index("--") + 1:], p, a),
              f"arm {a['arm']} qemu invariants")
    for path in [B.MODEL_PATH, p["pins"]["kernel"], boot_firmware(p), p["out"], p["bank_dir"]] + [a["image"] for a in arms]:
        check(lambda path=path: host.storage_check(path), f"storage of {path} (USB/removable refused)")
    for dev in ("/dev/kvm", "/dev/sev", "/dev/vhost-vsock"):
        check(lambda dev=dev: host.access_rw(dev), f"{dev} read/write")
    check(lambda: host.statvfs_free(p["bank_dir"]) >= (p["bank_gib"] + 32) * GiB, "bank filesystem free >= bank + 32 GiB")
    check(lambda: available(host) >= need_bytes(host, p, h, preflight=True), "host MemAvailable >= required now")
    problems += gpu_problems(host, p, preflight=True)
    if live:
        check(lambda: not host.exists(p["ring_dir"]), "bench ring dir must not exist")
        for a in arms:
            check(lambda a=a: not host.exists(a["serial_log"]) and not host.exists(a["bank"]), f"arm {a['arm']} outputs must be new")
            check(lambda a=a: show(host, a["unit"]).get("LoadState") == "not-found", f"{a['unit']} must not exist")
        for c in (0, 1):
            check(lambda c=c: show(host, worker_unit(p, c)).get("LoadState") == "not-found", f"worker {c} unit must not exist")
    return problems


def trust_files(p):
    t = p["trust"]
    out = {"vcek": t["vcek"], "min_tcb": t["min_tcb"]}
    if t.get("amd_chain"):
        out["amd_chain"] = t["amd_chain"].split("=", 1)[-1]
    return out


# ---------------------------------------------------------------- plan

def kv(items):
    out = {}
    for it in items or []:
        k, v = it.split("=", 1)
        out[k] = v
    return out


def make_plan(host, a):
    fw_path, fw_sha = getattr(a, "experimental_firmware", None), getattr(a, "experimental_firmware_sha256", None)
    experimental_pair(fw_path, fw_sha)   # one-sided or malformed flags refuse before anything is read
    out = os.path.abspath(a.out)
    if out.startswith(RELEASE):
        raise ValueError("plan dir may not be inside the production release")
    images, preds = kv(a.image), kv(a.measurement)
    order = a.order.split(",")
    if set(order) - set(images) or set(images) - set(ARMS) or set(images) != set(preds):
        raise ValueError("--image/--measurement must name the same arms, all used by --order")
    if "A" not in images or "B" not in images:
        raise ValueError("arms A and B are required")
    for s in [out, a.bank_dir] + list(images.values()):
        if not SAFE.match(os.path.abspath(s)):
            raise ValueError(f"unsafe path for QEMU argv: {s}")
    if len(a.gpu_uuid) != 2 or len(set(a.gpu_uuid)) != 2 or not all(GPU_UUID.match(u) for u in a.gpu_uuid):
        raise ValueError("exactly two distinct GPU UUIDs are required (measured init wires two workers)")
    if not CPUSET.match(a.allowed_cpus):
        raise ValueError("--allowed-cpus must be a cpuset list")
    if not re.fullmatch(r"[0-9a-f]{64}", a.app_sha) or not all(re.fullmatch(r"[0-9a-f]{96}", m) for m in preds.values()):
        raise ValueError("app sha must be 64 hex, measurements 96 hex")
    load_workload(a.workload)
    guestd = memory = gpu = None
    if a.reservations:
        guestd, memory, gpu = validate_reservations(json.loads(host.read(a.reservations)), a.gpu_uuid)
    if memory is None and a.pending_extra_mib is None:
        raise ValueError("strict memory mode needs --pending-extra-mib")
    rel = release_manifest(RELEASE)
    fw = experimental_firmware_record(host, fw_path, fw_sha)
    run_id = secrets.token_hex(8)
    runtime = 7800 if a.soak else 3600
    trust = {"vcek": a.vcek, "amd_chain": a.amd_chain, "min_tcb": a.min_tcb}
    p = {
        "kind": "shield-full-bench-plan/2", "run_id": run_id, "out": out, "release": RELEASE,
        "cmdline": rel["cmdline"], "guest_mib": a.guest_mib, "allowed_cpus": a.allowed_cpus,
        "runtime_max_sec": runtime, "soak": a.soak, "poll_sec": 5,
        "arm_wall_max_sec": runtime + STARTUP_ALLOW_SEC, "total_wall_max_sec": (runtime + STARTUP_ALLOW_SEC) * len(order),
        "pins": {"kernel": os.path.join(RELEASE, "kernel"), "firmware": os.path.join(RELEASE, "firmware.fd"),
                 "runtime": os.path.join(RELEASE, "template/rt/runtime.json")},
        "qemu": {"path": os.path.abspath(a.qemu), "sha256": host.sha256(os.path.abspath(a.qemu))},
        "workers": {"path": os.path.abspath(a.worker), "sha256": a.worker_sha256, "vram_gb": a.vram_gb,
                    "gpu_uuids": a.gpu_uuid, "ports": [a.worker_port_base, a.worker_port_base + 1],
                    "memory_max_mib": a.worker_memory_max_mib},
        "node": a.node, "client": os.path.abspath(a.client), "client_sha256": host.sha256(os.path.abspath(a.client)),
        "fwd": os.path.abspath(a.fwd), "fwd_sha256": host.sha256(os.path.abspath(a.fwd)),
        "trust": trust, "app_sha": a.app_sha, "workload": check_workload(json.loads(host.read(a.workload))),
        "model_identity": B.model_identity(B.MODEL_PATH, host.stat),
        "production_guests": host.guests(), "pending_extra_bytes": (a.pending_extra_mib or 0) * MiB,
        "memory": memory or {"mode": "strict"}, "guestd": guestd, "gpu": gpu,
        "ring_dir": f"/dev/shm/fullbench-{run_id}", "bank_dir": os.path.abspath(a.bank_dir), "bank_gib": a.bank_gib,
        "snp_claim": "configured until each arm's receipt shows client.mjs VERDICT attested; bench measurement, not production"
                     + (f"; booted experimental firmware {fw['sha256']}, not the original release firmware" if fw else ""),
        "experimental_firmware": fw,
        "arms": [],
    }
    p["trust_sha256"] = {k: host.sha256(v) for k, v in trust_files(p).items()}
    p["required_available_bytes"] = plan_required(p)
    for n, arm in enumerate(order):
        cid = CID_LO + secrets.randbelow(CID_HI - CID_LO - len(order)) if n == 0 else p["arms"][0]["cid"] + n
        p["arms"].append({"arm": arm, "seq": n, "image": os.path.abspath(images[arm]),
                          "image_sha256": host.sha256(os.path.abspath(images[arm])), "measurement": preds[arm],
                          "unit": f"fullbench-{run_id}-{arm.lower()}{n}.service", "cid": cid,
                          "serial_log": os.path.join(out, f"serial-{n}-{arm}.log"),
                          "bank": os.path.join(p["bank_dir"], f"fullbench-{run_id}-{n}-{arm}.padbank")})
    os.mkdir(out, 0o755)
    p["plan_time_problems"] = preflight(host, p)
    data = (json.dumps(p, indent=2, sort_keys=True) + "\n").encode()
    write_new(os.path.join(out, "plan.json"), data)
    return p, hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- owned units

def unit_identity(props, unit):
    pid = int(props.get("MainPID") or 0)
    cg = props.get("ControlGroup", "")
    if not props.get("InvocationID") or not cg.endswith("/" + unit):
        raise ValueError(f"{unit} identity incomplete (InvocationID/ControlGroup)")
    return {"invocation": props["InvocationID"], "main_pid": pid, "cgroup": cg}


def start_unit(host, p, h, key, argv, binary):
    """Create a NEW owned unit and record its identity. The name must be absent first. A systemd-run that times out is
    ambiguous: the unit is claimed only if it now exists under this never-before-seen name running our binary."""
    unit = argv[argv.index("--unit") + 1]
    if not owned_unit(p, unit):
        raise ValueError(f"refusing to create {unit}")
    if show(host, unit).get("LoadState") != "not-found":
        raise Stop(f"{unit} exists before create; not ours")
    rec = {"unit": unit, "binary": binary, "created_by_us": True, "invocation": None}
    h["owned"][key] = rec
    try:
        rc, _, err = host.run(argv, timeout=START_TIMEOUT)
    except subprocess.TimeoutExpired:
        rc, err = None, "systemd-run timed out (ambiguous start)"
    props = show(host, unit)
    if props.get("_rc") != 0 or "LoadState" not in props:
        raise Stop(f"start_unreadable:{key}")
    if props["LoadState"] == "not-found":
        raise Stop(f"start_failed:{key}: {(err or '')[-300:]}")
    if f"path={binary} " not in props.get("ExecStart", ""):
        h["owned"][key] = None   # not provably ours: never touched again
        raise Stop(f"start_unproven:{key}")
    rec.update(unit_identity(props, unit))
    rec["pid_start"] = host.pid_start(rec["main_pid"]) if rec["main_pid"] else None
    if rc != 0:
        raise Stop(f"start_failed:{key}: {(err or '')[-300:]}")
    return rec


def stop_owned(host, p, rec):
    """Stop one owned unit and prove nothing of it is alive. Returns problems; [] means gone."""
    unit = rec["unit"]
    if not owned_unit(p, unit):
        raise ValueError(f"refusing to touch {unit}")
    props = show(host, unit)
    if props.get("_rc") != 0 or "LoadState" not in props:
        return [f"{unit}: state unreadable; not touched"]
    if props["LoadState"] != "not-found":
        if rec.get("invocation") is None:   # ambiguous start: claim only with the narrow proof
            if not (rec.get("created_by_us") and f"path={rec['binary']} " in props.get("ExecStart", "")):
                return [f"{unit}: exists but ownership unproven; not touched"]
            try:
                rec.update(unit_identity(props, unit))
            except ValueError as e:
                return [str(e) + "; not touched"]
            rec["pid_start"] = host.pid_start(rec["main_pid"]) if rec["main_pid"] else None
        if props.get("InvocationID") != rec["invocation"]:
            return [f"{unit}: InvocationID changed; not touched"]
        if props.get("ActiveState") not in ("inactive", "failed"):
            try:
                host.run(["systemctl", "--user", "stop", unit], timeout=STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                pass   # the state checks below decide
        for _ in range(STOP_SETTLE):
            props = show(host, unit)
            if props.get("LoadState") == "not-found" or props.get("ActiveState") in ("inactive", "failed"):
                break
            host.sleep(1)
        if props.get("ActiveState") == "failed" and props.get("InvocationID") == rec["invocation"]:
            host.run(["systemctl", "--user", "reset-failed", unit], timeout=15)
        elif props.get("LoadState") != "not-found" and props.get("ActiveState") != "inactive":
            return [f"{unit}: still {props.get('ActiveState')} after stop"]
    bad = []
    if rec.get("main_pid") and rec.get("pid_start") and host.pid_start(rec["main_pid"]) == rec["pid_start"]:
        bad.append(f"{unit}: MainPID {rec['main_pid']} still alive")
    if rec.get("cgroup"):
        procs = host.cgroup_procs(rec["cgroup"])
        if procs:
            bad.append(f"{unit}: cgroup still has {len(procs)} processes")
    return bad


def reap(procs):
    bad = []
    for pr in procs:
        if pr.poll() is None:
            pr.kill()
        try:
            pr.wait(timeout=CHILD_WAIT)
        except subprocess.TimeoutExpired:
            bad.append(f"helper child {pr.pid} did not exit")
    return bad


def cleanup(host, p, arm, h, procs):
    """Clients, fwd and probe first; then guest, then workers. Rings and bank go only when every user is proven gone."""
    errs = reap(procs)
    users_gone = True
    for key in ("guest", "w0", "w1"):
        rec = h["owned"].get(key)
        if key in h["owned"] and rec is None:
            errs.append(f"{key}: a unit under our name could not be proven ours; rings/bank kept")
            users_gone = False
            continue
        if rec is None:
            continue
        e = stop_owned(host, p, rec)
        if e:
            errs += e
            users_gone = False
    if users_gone:
        for path in (arm["bank"], f"{p['ring_dir']}/card-0", f"{p['ring_dir']}/card-1"):
            try:
                if host.exists(path):
                    host.unlink(path)
            except OSError as e:
                errs.append(f"unlink {path}: {e}")
        try:
            if host.exists(p["ring_dir"]):
                host.rmdir(p["ring_dir"])
        except OSError as e:
            errs.append(f"rmdir ring dir: {e}")
    else:
        errs.append("bank/rings left in place: a user may still be alive")
    return errs


# ---------------------------------------------------------------- watchdog

def owned_gpu_pids(host, h):
    pids = set()
    for key in ("w0", "w1"):
        rec = h["owned"].get(key) or {}
        if rec.get("cgroup"):
            pids.update(host.cgroup_procs(rec["cgroup"]) or [])
    return frozenset(pids)


def watch_probe(host, p, h):
    """Latest line of the long-running probe (one guestd session for the whole arm). Stale or changed = yield."""
    if not h.get("probe_out"):
        return []
    tail = host.read_tail(h["probe_out"], PROBE_TAIL_CAP)
    lines = [l for l in tail.split(b"\n")[:-1] if l.strip()]
    if lines:
        try:
            snap = check_snapshot(json.loads(lines[-1]))
        except (ValueError, KeyError, TypeError) as e:
            return [f"guestd probe reported: {e}"]
        if snap["seq"] > h.get("probe_seq", 0):
            h["probe_seq"], h["probe_seen_at"] = snap["seq"], host.now()
            h["guestd_pending_mib"] = snap["pool"]["pendingMiB"]
            changed = snapshot_changes(p["guestd"]["snapshot"], snap)
            if changed:
                return changed
    if host.now() - h["probe_seen_at"] > 3 * p["poll_sec"] + PROBE_TIMEOUT:
        return ["guestd probe stale"]
    return []


def guard(host, p, h):
    """One watchdog tick. Returns a stop reason or None. Production always wins."""
    if host.now() > h["wall_deadline"]:
        return "wall_deadline"
    g = h["owned"].get("guest") or {}
    try:
        cur = host.guests(exclude_pid=g.get("main_pid"))
        if (p.get("memory") or {"mode": "strict"})["mode"] == "strict":
            RG.check(p["production_guests"], cur, FIXED_RESERVE + p["pending_extra_bytes"])
        elif cur != p["production_guests"]:
            return "production_guests_changed"
    except (OSError, ValueError) as e:
        return "production_guests_changed: " + str(e)
    for key, rec in h["owned"].items():
        if rec and rec.get("invocation"):
            props = show(host, rec["unit"])
            if props.get("InvocationID") != rec["invocation"]:
                return f"owned_identity_changed:{key}"
            if props.get("ActiveState") not in ("active", "activating"):
                return f"{key}_ended"
    if p.get("guestd"):
        changed = watch_probe(host, p, h)
        if changed:
            return "production_changed: " + "; ".join(changed)
    if host.now() >= h.get("next_gpu", 0):
        h["next_gpu"] = host.now() + p["poll_sec"]
        bad = gpu_problems(host, p, owned_gpu_pids(host, h))
        if bad:
            return "gpu_changed: " + "; ".join(bad)
    try:
        if available(host) < need_bytes(host, p, h):
            return "low_host_memory"
    except (OSError, ValueError, KeyError) as e:
        return f"memory_accounting_failed: {e}"
    return None


def sample(host, h):
    s = {"t": host.wall(), "host_available": available(host)}
    for key in ("guest", "w0", "w1"):
        cg = (h["owned"].get(key) or {}).get("cgroup")
        for f in ("memory.current", "memory.peak"):
            if cg and (key == "guest" or f == "memory.current"):
                try:
                    s[f if key == "guest" else f"{key}.{f}"] = int(host.read(f"/sys/fs/cgroup{cg}/{f}").strip())
                except (OSError, ValueError):
                    pass
    return s


def tick(host, p, h):
    h["samples"].append(sample(host, h))
    why = guard(host, p, h)
    if why:
        raise Stop(why)


def wait_for(host, p, h, cond, timeout, what):
    """Bounded wait with the full watchdog running every second."""
    until = host.now() + timeout
    while True:
        tick(host, p, h)
        if cond():
            return
        if host.now() >= until:
            raise Stop("timeout:" + what)
        host.sleep(1)


# ---------------------------------------------------------------- one arm

def parse_client(stdout):
    r = {"verdict": None, "status": None, "body": None, "pinned": False}
    for l in stdout.splitlines():
        if l.startswith("VERDICT "):
            r["verdict"] = l.split()[1]
        elif l.startswith("RESULT app_status="):
            r["status"] = int(l.split("=", 1)[1])
        elif l.startswith("RESULT app_body="):
            try:
                r["body"] = json.loads(json.loads(l.split("=", 1)[1]))
            except ValueError:
                r["body"] = {"unparsed": True}
        elif l.startswith("RESULT app_on_pinned_key="):
            r["pinned"] = l.endswith("=1")
    r["ok"] = r["verdict"] == "attested" and r["status"] == 200 and r["pinned"] and isinstance(r["body"], dict) \
        and "tokens_fnv1a64" in r["body"]
    return r


def run_step(host, p, arm, port, step, h, procs, tag):
    """Concurrent attested requests, with the watchdog running while they are in flight. Every child is reaped."""
    mine = []
    for i in range(step["concurrency"]):
        out = os.path.join(p["out"], f"client-{arm['seq']}-{tag}-{i}.out")
        pr = host.popen(client_argv(p, arm, port, probe_path(step["query"], i)), out)
        procs.append(pr)
        mine.append((pr, out))
    until = host.now() + p["workload"]["per_request_timeout_s"]
    reason = None
    while any(pr.poll() is None for pr, _ in mine):
        try:
            tick(host, p, h)
        except Stop as s:
            reason = s.reason
            break
        if host.now() > until:
            reason = "request_timeout"
            break
        host.sleep(1)
    res = []
    for pr, out in mine:
        if pr.poll() is None:
            pr.kill()
        try:
            pr.wait(timeout=CHILD_WAIT)
        except subprocess.TimeoutExpired:
            reason = reason or "client_unkillable"
        raw = host.read_head(out, CLIENT_OUT_CAP)
        r = parse_client(raw[:CLIENT_OUT_CAP].decode("utf-8", "replace"))
        if len(raw) > CLIENT_OUT_CAP:
            r["ok"], r["output_oversize"] = False, True
        r["exit"] = pr.returncode
        r["ok"] = r["ok"] and pr.returncode == 0
        res.append(r)
    return res, reason


def fwd_port(host, fwd, path):
    if fwd.poll() is not None:
        raise Stop("fwd_exited")
    head = host.read_head(path, FWD_OUT_CAP)
    if b"\n" not in head:
        if len(head) > FWD_OUT_CAP:
            raise Stop("fwd_output_oversize")
        return None
    m = FWD_LINE.match(head.split(b"\n", 1)[0].decode("ascii", "replace"))
    if not m:
        raise Stop("fwd_failed")
    return int(m.group(1))


def startup_markers(text):
    """Complete serial lines only. None = not yet; a dict = the app was started and the front says serving; Stop = fail
    closed (a DOM ERROR/end, init's order broken, or an ambiguous start). Timing only: it proves nothing about the guest."""
    seccomp, started, serving = False, None, None
    for raw in text.split("\n")[:-1]:
        l = raw.rstrip("\r")
        if DOM_FATAL.match(l):
            raise Stop("guest_startup_error: " + l[:200])
        if DOM_SECCOMP.match(l):
            seccomp = True
        m = DOM_STARTED.match(l)
        if m:
            if started is not None:
                raise Stop("startup_marker_duplicate")
            if not seccomp:
                raise Stop("startup_marker_order: DOM started before the app's seccomp line")
            started = {"app_pid": int(m.group(1)), "front_pid": int(m.group(2)), "started_at_ms": int(m.group(3)),
                       "serving_seen_before_started": serving is not None}
        m = DOM_SERVING.match(l)
        if m and serving is None:
            serving = {"spki_sha256": m.group(1), "serving_ready_ms": int(m.group(2))}
    if started is None or serving is None:
        return None
    if started["app_pid"] <= 1 or started["front_pid"] <= 1 or started["app_pid"] == started["front_pid"]:
        raise Stop("startup_marker_malformed")
    return dict(started, **serving)


def serial_declined(text):
    return any(DOM_DECLINED.match(l.rstrip("\r")) for l in text.split("\n"))


def classify_failure(host, arm, step, res):
    """model_declined needs the guest's decline line on the serial. Without it a load_by_name NotFound is the requested
    graph missing from the registry (configuration, or a preload skipped silently), never a capacity decline. Only
    bodies of attested, pinned responses count."""
    load = [str(r["body"].get("error", ""))[:200] for r in res if not r["ok"] and r["verdict"] == "attested"
            and r["pinned"] and isinstance(r["body"], dict) and str(r["body"].get("error", "")).startswith("load_by_name:")]
    declined = False
    if host.exists(arm["serial_log"]):
        declined = serial_declined(host.read_head(arm["serial_log"], SERIAL_HEAD_CAP)[:SERIAL_HEAD_CAP].decode("utf-8", "replace"))
    ev = {"graph": step["query"].get("graph"), "load_by_name_errors": load[:4], "serial_declined": declined}
    if load and declined:
        return "model_declined", ev
    if load and all(LOAD_NOT_FOUND.search(e) for e in load):
        return "graph_not_found", ev
    return ("model_load_failed" if load else "request_failed"), ev


def run_arm(host, p, arm, total_deadline):
    h = {"arm": arm["arm"], "unit": arm["unit"], "samples": [], "requests": [], "owned": {}}
    h["wall_deadline"] = min(host.now() + p["arm_wall_max_sec"], total_deadline)
    procs, started = [], False
    try:
        probs = preflight(host, p, arm, live=True, h=h)
        if probs:
            h["outcome"] = "preflight_refused"; h["problems"] = probs
            return h
        started = True
        if p.get("guestd"):
            h["probe_out"] = os.path.join(p["out"], f"guestd-{arm['seq']}.jsonl")
            h["probe_seen_at"] = host.now()
            procs.append(host.popen(probe_argv(p, every=p["poll_sec"]), h["probe_out"]))
        host.mkdir(p["ring_dir"], 0o700)
        for c in (0, 1):
            host.make_sparse(f"{p['ring_dir']}/card-{c}", RING_BYTES)
        for c in (0, 1):
            start_unit(host, p, h, f"w{c}", worker_argv(p, c), p["workers"]["path"])
        wait_for(host, p, h, lambda: all(show(host, worker_unit(p, c)).get("ActiveState") == "active" for c in (0, 1)),
                 WORKER_START_SEC, "worker_start")
        settle = host.now() + WORKER_SETTLE
        wait_for(host, p, h, lambda: host.now() >= settle, WORKER_SETTLE + 5, "worker_settle")
        host.make_sparse(arm["bank"], p["bank_gib"] * GiB)
        t_boot = host.now()
        g = start_unit(host, p, h, "guest", unit_argv(p, arm), p["qemu"]["path"])
        lim = {f: host.read(f"/sys/fs/cgroup{g['cgroup']}/{f}").strip() for f in ("memory.max", "memory.swap.max")}
        if lim != {"memory.max": str((p["guest_mib"] + UNIT_OVERHEAD_MIB) * MiB), "memory.swap.max": "0"}:
            h["outcome"] = "limits_not_enforced"
            return h
        fwd_out = os.path.join(p["out"], f"fwd-{arm['seq']}-{arm['arm']}.out")
        fwd = host.popen([p["fwd"], "-cid", str(arm["cid"])], fwd_out)
        procs.append(fwd)
        box = {}

        def ready():
            box["port"] = fwd_port(host, fwd, fwd_out)
            return box["port"] is not None
        wait_for(host, p, h, ready, FWD_FIRST_LINE_SEC, "fwd_first_line")

        def app_started():
            # the front listens before init forks the app; a document issued in that window scans no runtime process
            if not host.exists(arm["serial_log"]):
                return False
            head = host.read_head(arm["serial_log"], SERIAL_HEAD_CAP)
            if len(head) > SERIAL_HEAD_CAP:
                raise Stop("serial_oversize")
            box["startup"] = startup_markers(head.decode("utf-8", "replace"))
            return box["startup"] is not None
        t_wait = host.now()
        wait_for(host, p, h, app_started, STARTUP_READY_SEC, "startup_readiness")
        h["startup_readiness"] = dict(box["startup"], waited_s=host.now() - t_wait, signal=READINESS_SIGNAL)
        for rnd in range(1, p["workload"]["rounds"] + 1):
            for step in p["workload"]["steps"]:
                if step["name"] == "fixture" and rnd > 1:
                    continue
                tick(host, p, h)
                t0 = host.now()
                res, why = run_step(host, p, arm, box["port"], step, h, procs, f"{rnd}-{step['name']}")
                h["samples"].append(sample(host, h))
                h["requests"].append({"round": rnd, "step": step["name"], "wall_s": host.now() - t0, "results": res})
                if why:
                    h["outcome"] = "stopped:" + why
                    return h
                if rnd == 1 and step["name"] == "fixture":
                    h["first_probe_s"] = host.now() - t_boot
                if not all(r["ok"] for r in res):
                    h["outcome"], h["failure_evidence"] = classify_failure(host, arm, step, res)
                    return h
        h["outcome"] = "success"
        return h
    except Stop as s:
        h["outcome"] = "stopped:" + s.reason
        return h
    except Exception as e:  # noqa: BLE001 - recorded; cleanup still runs
        h["outcome"] = "helper_error"; h["error"] = repr(e)
        return h
    finally:
        if started:
            try:
                errs = cleanup(host, p, arm, h, procs)
            except Exception as e:  # noqa: BLE001 - a cleanup that cannot finish is a failed cleanup
                errs = [f"cleanup raised {e!r}"]
            h["cleanup"] = "failed" if errs else "clean"
            if errs:
                h["cleanup_errors"] = errs
                h["workload_outcome"] = h.get("outcome")
                h["outcome"] = "cleanup_failed"
        if host.exists(arm["serial_log"]):
            log = host.read_head(arm["serial_log"], 8 << 20).decode("utf-8", "replace")
            h["serial_model_line"] = next((l.strip() for l in log.splitlines() if "MODEL verified" in l), None)
            h["serial_declined"] = serial_declined(log)
            h["serial_dom_errors"] = [l.strip()[:200] for l in log.splitlines() if DOM_FATAL.match(l.strip())][:8]
        peaks = [s["memory.peak"] for s in h["samples"] if "memory.peak" in s]
        h["host_peak_last_sample"] = max(peaks) if peaks else None
        h["host_current_max"] = max([s.get("memory.current", 0) for s in h["samples"]] or [0])


def arm_ok(h):
    return h.get("outcome") == "success" and h.get("cleanup") == "clean"


def summarize(arms):
    out = {}
    for h in arms:
        reqs = [r for q in h.get("requests", []) if q["round"] >= 2 for r in q["results"] if r["ok"]]
        toks = sum(max(len(r["body"]["tokens"]) - 1, 0) for r in reqs)
        dec = sum(r["body"]["decode_ms"] for r in reqs)
        out[f"{h['seq']}-{h['arm']}"] = {"outcome": h["outcome"], "cleanup": h.get("cleanup"),
                                         "decode_tok_s_weighted_per_request": toks * 1000.0 / dec if dec else None,
                                         "steps": [{"round": q["round"], "step": q["step"], "wall_s": q["wall_s"],
                                                    "completed_tokens_per_wall_s": sum(max(len(r["body"]["tokens"]) - 1, 0) for r in q["results"] if r["ok"]) / q["wall_s"] if q["wall_s"] else None}
                                                   for q in h.get("requests", [])],
                                         "host_peak_last_sample": h.get("host_peak_last_sample"),
                                         "model_line": h.get("serial_model_line")}
    return out


def execute(host, a):
    raw = host.read_bytes(os.path.abspath(a.plan))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != a.approve_plan_sha256:
        raise ValueError(f"plan sha256 {digest} != approved")
    p = json.loads(raw)
    if p.get("kind") != "shield-full-bench-plan/2":
        raise ValueError("plan predates revision 2; re-plan")
    if not a.execute:
        print(json.dumps({"dry_run": True, "preflight_now": preflight(host, p),
                          "experimental_firmware": p.get("experimental_firmware"),
                          "workers": [worker_argv(p, c) for c in (0, 1)],
                          "arms": [unit_argv(p, x) for x in p["arms"]]}, indent=2))
        return 0
    if not a.coordinated_slot:
        raise ValueError("--execute needs --coordinated-slot (16 CPUs, required RAM, two GPUs)")
    receipt_path = os.path.join(p["out"], "receipt.json")
    if host.exists(receipt_path):
        raise ValueError("receipt exists")
    receipt = {"kind": "shield-full-bench-receipt/2", "plan_sha256": digest, "coordinated_slot": a.coordinated_slot,
               "snp_claim": p["snp_claim"], "experimental_firmware": p.get("experimental_firmware"), "arms": []}
    total_deadline = host.now() + p["total_wall_max_sec"]
    try:
        for arm in p["arms"]:
            h = run_arm(host, p, arm, total_deadline)
            h["seq"] = arm["seq"]
            receipt["arms"].append(h)
            if h.get("cleanup") == "failed" or h["outcome"] not in ("success", "model_declined"):
                break
    finally:
        receipt["summary"] = summarize(receipt["arms"])
        receipt["ok"] = len(receipt["arms"]) == len(p["arms"]) and all(arm_ok(h) for h in receipt["arms"])
        write_new(receipt_path, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    print(json.dumps({"receipt": receipt_path, "ok": receipt["ok"], "summary": receipt["summary"]}, indent=2))
    return 0 if receipt["ok"] else 1


def main(argv=None, host=None):
    host = host or Host()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stage")
    s.add_argument("--release", default=RELEASE)
    s.add_argument("--candidate-loader", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--arms", default="A,B,A1")
    p = sub.add_parser("plan")
    for k in ("--out", "--qemu", "--worker", "--worker-sha256", "--client", "--fwd", "--node", "--vcek",
              "--min-tcb", "--app-sha", "--allowed-cpus", "--bank-dir"):
        p.add_argument(k, required=True)
    p.add_argument("--amd-chain")
    p.add_argument("--image", action="append", required=True, help="ARM=path (A, B, optional A1)")
    p.add_argument("--measurement", action="append", required=True, help="ARM=96-hex prediction")
    p.add_argument("--gpu-uuid", action="append", required=True)
    p.add_argument("--vram-gb", type=int, required=True)
    p.add_argument("--worker-memory-max-mib", type=int, required=True)
    p.add_argument("--worker-port-base", type=int, default=19601)
    p.add_argument("--guest-mib", type=int, default=GUEST_FLOOR_MIB)
    p.add_argument("--pending-extra-mib", type=int, help="strict memory mode only")
    p.add_argument("--reservations", help="root-reviewed fullbench-reservations/1 JSON (REVISION.md)")
    p.add_argument("--bank-gib", type=int, default=64)
    p.add_argument("--workload", default=os.path.join(HERE, "workload.json"))
    p.add_argument("--order", default="A,B,B,A", help="comma list of arms, e.g. A,B,B,A or A,A1,B")
    p.add_argument("--soak", action="store_true")
    p.add_argument("--experimental-firmware", help="opt-in NEW benchmark firmware path; needs the sha256 flag too")
    p.add_argument("--experimental-firmware-sha256", help="root-approved sha256 of --experimental-firmware")
    e = sub.add_parser("execute")
    e.add_argument("--plan", required=True)
    e.add_argument("--approve-plan-sha256", required=True)
    e.add_argument("--execute", action="store_true")
    e.add_argument("--coordinated-slot")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "stage":
            m = stage(a.release, a.candidate_loader, a.out, tuple(a.arms.split(",")))
            print(json.dumps({"stage": a.out, "arms": sorted(m["arms"])}))
            return 0
        if a.cmd == "plan":
            plan, digest = make_plan(host, a)
            print(json.dumps({"plan": os.path.join(plan["out"], "plan.json"), "plan_sha256": digest,
                              "memory_mode": plan["memory"]["mode"], "gpu_mode": (plan["gpu"] or {"mode": "strict"})["mode"],
                              "required_available_bytes": plan["required_available_bytes"],
                              "experimental_firmware": plan["experimental_firmware"],
                              "plan_time_problems": plan["plan_time_problems"]}, indent=2))
            return 0
        return execute(host, a)
    except (OSError, ValueError, KeyError) as err:
        print(f"refused: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
