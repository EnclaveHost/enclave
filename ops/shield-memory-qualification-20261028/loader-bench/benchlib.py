"""Shared, side-effect-free pieces of the loader-only SNP A/B harness.

Everything here only reads files or computes values. Nothing here starts a
process, mounts, writes outside an explicit output path, or reads the model.
"""

import gzip
import hashlib
import io
import os
import re
import stat
import struct
import zlib
from urllib.parse import unquote_plus

GiB = 1 << 30
MiB = 1 << 20

RELEASE = "/home/steven/enclave-prod/release-5cab66e4"
KERNEL_SHA256 = "1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7"
FIRMWARE_SHA256 = "142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9"
MODEL_PATH = ("/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q4-vl-gguf/"
              "Qwen3.8-27B-UD-Q4_K_XL.gguf")
MODEL_SIZE = 17559178144
MODEL_SHA256 = "3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e"
MODEL_DIR_IN_GUEST = "models/qwen3.8-27b-mtp-q4-vl-gguf"

ARMS = ("A", "B")
RECLAIM_MARKER = "rt/shield-original-source-reclaim.enabled"
DROP_MARKER = "rt/shield-model-drop-cache.enabled"

# Production cmdline (release.json) plus panic=-1, so a guest panic ends
# QEMU via -no-reboot instead of hanging until RuntimeMaxSec.
CMDLINE = "console=ttyS0 rdinit=/init loglevel=3 panic=-1"

GUEST_RAM_GIB = 48
GUEST_CPUS = 2
QEMU_OVERHEAD = 2 * GiB
HOST_FLOOR = 18 * GiB
PENDING_PRODUCTION_MIN = 1551 * MiB
UNIT_MEMORY_MAX = "50G"
UNIT_RUNTIME_MAX_SEC = 180
UNIT_CPU_QUOTA = "200%"

SNP_CLAIM = ("configured only: QEMU was given sev-snp-guest with kernel-hashes=on. "
             "No attestation report was requested or verified, so this run does not "
             "show that SNP was active or that the measurement matches production.")


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def required_available(pending_production_bytes):
    """Host MemAvailable needed before each boot. Refuses a pending
    production figure below the 1551 MiB minimum instead of clamping it."""
    if pending_production_bytes < PENDING_PRODUCTION_MIN:
        raise ValueError("pending production RAM below the 1551 MiB minimum")
    return GUEST_RAM_GIB * GiB + QEMU_OVERHEAD + pending_production_bytes + HOST_FLOOR


def meminfo_bytes(text):
    out = {}
    for line in text.splitlines():
        parts = line.replace(":", " ").split()
        if len(parts) >= 2 and parts[1].isdigit():
            out[parts[0]] = int(parts[1]) * (1024 if parts[2:3] == ["kB"] else 1)
    return out


# ---------------------------------------------------------------- static ELF

def check_static_elf_amd64(path):
    """Accept only a statically linked x86-64 ELF: no PT_INTERP and no
    PT_DYNAMIC, which is what CGO_ENABLED=0 GOOS=linux GOARCH=amd64 emits."""
    with open(path, "rb") as f:
        hdr = f.read(64)
        if len(hdr) < 64 or hdr[:4] != b"\x7fELF" or hdr[4] != 2 or hdr[5] != 1:
            raise ValueError(f"{path}: not a little-endian ELF64 file")
        e_type, e_machine = struct.unpack_from("<HH", hdr, 16)
        if e_machine != 62 or e_type != 2:
            raise ValueError(f"{path}: not an x86-64 ET_EXEC binary")
        e_phoff, = struct.unpack_from("<Q", hdr, 32)
        e_phentsize, e_phnum = struct.unpack_from("<HH", hdr, 54)
        f.seek(e_phoff)
        ph = f.read(e_phentsize * e_phnum)
    if e_phentsize < 4 or len(ph) != e_phentsize * e_phnum:
        raise ValueError(f"{path}: truncated program headers")
    for i in range(e_phnum):
        p_type, = struct.unpack_from("<I", ph, i * e_phentsize)
        if p_type in (2, 3):
            raise ValueError(f"{path}: dynamically linked (PT_DYNAMIC/PT_INTERP)")


# ---------------------------------------------------------------- NEWC cpio

def _newc(ino, mode, name, data=b"", nlink=1, rdev=(0, 0)):
    name_b = name.encode() + b"\0"
    fields = (ino, mode, 0, 0, nlink, 0, len(data), 0, 0, rdev[0], rdev[1], len(name_b), 0)
    out = b"070701" + "".join("%08X" % v for v in fields).encode() + name_b
    out += b"\0" * (-len(out) % 4) + data
    return out + b"\0" * (-len(out) % 4)


def initramfs_entries(init_bytes, loader_bytes, arm):
    """Archive contents for one arm: (path, mode, data, rdev). The arms
    differ only by the drop-cache marker. uid/gid/mtime are always 0."""
    if arm not in ARMS:
        raise ValueError(arm)
    d = stat.S_IFDIR | 0o755
    entries = [(p, d, b"", None) for p in
               ("bin", "dev", "models", MODEL_DIR_IN_GUEST, "proc", "rt", "sys")]
    entries += [
        # Kernel opens /dev/console for PID 1 before devtmpfs exists; the
        # node lives only in the archive, so the host needs no mknod.
        ("dev/console", stat.S_IFCHR | 0o600, b"", (5, 1)),
        ("init", stat.S_IFREG | 0o755, init_bytes, None),
        ("bin/shieldmodel", stat.S_IFREG | 0o755, loader_bytes, None),
        (RECLAIM_MARKER, stat.S_IFREG | 0o444, b"1\n", None),
    ]
    if arm == "B":
        entries.append((DROP_MARKER, stat.S_IFREG | 0o444, b"1\n", None))
    return sorted(entries, key=lambda e: e[0])


def newc_archive(entries):
    out = bytearray()
    for ino, (path, mode, data, rdev) in enumerate(entries, start=1):
        nlink = 2 if stat.S_ISDIR(mode) else 1
        out += _newc(ino, mode, path, data, nlink, rdev or (0, 0))
    out += _newc(0, 0, "TRAILER!!!")
    return bytes(out)


def deterministic_gzip(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=buf, mtime=0) as g:
        g.write(data)
    return buf.getvalue()


def parse_newc(data):
    """Reader used by tests and review: returns [(path, mode, data, rdev)]."""
    out, off = [], 0
    while True:
        if data[off:off + 6] != b"070701":
            raise ValueError(f"bad magic at {off}")
        f = [int(data[off + 6 + 8 * i: off + 14 + 8 * i], 16) for i in range(13)]
        namesize, filesize = f[11], f[6]
        name = data[off + 110: off + 110 + namesize - 1].decode()
        off += 110 + namesize
        off += -off % 4
        body = data[off: off + filesize]
        off += filesize
        off += -off % 4
        if name == "TRAILER!!!":
            return out
        out.append((name, f[1], body, (f[9], f[10])))


# ---------------------------------------------------------------- storage

def _unescape_mountinfo(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def mount_source_for_dev(st_dev, mountinfo_text):
    want = f"{os.major(st_dev)}:{os.minor(st_dev)}"
    for line in mountinfo_text.splitlines():
        left, sep, right = line.partition(" - ")
        fields = left.split()
        if sep and len(fields) >= 3 and fields[2] == want:
            r = right.split()
            if len(r) >= 2:
                return r[0], _unescape_mountinfo(r[1])
    raise ValueError(f"no mount for device {want}")


def _block_chain(sys_root, devno):
    """Real sysfs paths of a block device, its parent disk if it is a
    partition, and every lower device (dm/md slaves), recursively."""
    seen, todo = [], [os.path.realpath(os.path.join(sys_root, "dev/block", devno))]
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        if not os.path.isdir(p):
            raise ValueError(f"unresolvable block device {p}")
        seen.append(p)
        if os.path.exists(os.path.join(p, "partition")):
            todo.append(os.path.dirname(p))
        slaves = os.path.join(p, "slaves")
        if os.path.isdir(slaves):
            todo += [os.path.realpath(os.path.join(slaves, s)) for s in sorted(os.listdir(slaves))]
    return seen


def storage_check(path, sys_root="/sys", mountinfo_path="/proc/self/mountinfo",
                  stat_fn=os.stat):
    """Return the backing block chain of path. Raise if it cannot be
    resolved, or if any layer is USB-attached or removable."""
    st = stat_fn(path)
    devno = f"{os.major(st.st_dev)}:{os.minor(st.st_dev)}"
    if os.major(st.st_dev) == 0:
        # btrfs, overlay, tmpfs...: resolve via the mount's source device.
        with open(mountinfo_path) as f:
            fstype, source = mount_source_for_dev(st.st_dev, f.read())
        if not source.startswith("/dev/"):
            raise ValueError(f"{path}: on {fstype} {source}, not a block device")
        sst = stat_fn(source)
        if not stat.S_ISBLK(sst.st_mode):
            raise ValueError(f"{path}: mount source {source} is not a block device")
        devno = f"{os.major(sst.st_rdev)}:{os.minor(sst.st_rdev)}"
    chain = _block_chain(sys_root, devno)
    for p in chain:
        if "/usb" in p:
            raise ValueError(f"{path}: USB-attached storage ({p})")
        rem = os.path.join(p, "removable")
        if os.path.exists(rem) and open(rem).read().strip() == "1":
            raise ValueError(f"{path}: removable storage ({p})")
    return chain


def file_identity(path, stat_fn=os.stat):
    st = stat_fn(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"{path}: not a regular file")
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size,
            "mtime_ns": st.st_mtime_ns, "ctime_ns": st.st_ctime_ns}


def model_identity(path=MODEL_PATH, stat_fn=os.stat):
    """Stat only. The model is never opened on the host: its digest is
    verified inside the guest by shieldmodel."""
    ident = file_identity(path, stat_fn)
    if ident["size"] != MODEL_SIZE:
        raise ValueError(f"model size {ident['size']} != pinned {MODEL_SIZE}")
    return ident


# ---------------------------------------------------------------- QEMU argv

UNSAFE_ARG = re.compile(r"[,\s=]")


def qemu_argv(qemu, cpu_model, kernel, firmware, initrd, model, serial_log):
    for p in (kernel, firmware, initrd, model, serial_log):
        if not os.path.isabs(p) or UNSAFE_ARG.search(p):
            raise ValueError(f"path not usable in QEMU options: {p!r}")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", cpu_model):
        raise ValueError(f"bad cpu model {cpu_model!r}")
    return [
        qemu,
        "-nodefaults", "-no-user-config", "-no-reboot",
        "-display", "none", "-monitor", "none", "-parallel", "none", "-nic", "none",
        "-serial", "file:" + serial_log,
        "-machine", "q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram0,vmport=off",
        "-cpu", cpu_model,
        "-smp", str(GUEST_CPUS),
        "-m", f"{GUEST_RAM_GIB}G",
        "-object", f"memory-backend-memfd,id=ram0,size={GUEST_RAM_GIB}G,share=true",
        "-object", "sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on",
        "-bios", firmware,
        "-kernel", kernel,
        "-initrd", initrd,
        "-append", CMDLINE,
        "-drive", f"if=none,id=model,file={model},format=raw,readonly=on,cache=none",
        "-device", "virtio-blk-pci,drive=model,disable-legacy=on,iommu_platform=on",
    ]


def systemd_run_argv(unit, qemu):
    if not re.fullmatch(r"shield-snp-ab-[0-9a-f]{32}-[AB]\.service", unit):
        raise ValueError(f"not an owned unit name: {unit}")
    return [
        "systemd-run", "--user", "--quiet", "--unit", unit, "--service-type=exec",
        "--description", "shield loader-only SNP A/B bench (owned, transient)",
        "--property=MemoryMax=" + UNIT_MEMORY_MAX,
        "--property=MemorySwapMax=0",
        "--property=CPUQuota=" + UNIT_CPU_QUOTA,
        "--property=RuntimeMaxSec=%d" % UNIT_RUNTIME_MAX_SEC,
        "--property=KillMode=control-group",
        # Keeps ExecMainStatus readable after QEMU exits; the helper stops
        # the unit itself right after reading it.
        "--property=RemainAfterExit=yes",
        "--", *qemu,
    ]


# ---------------------------------------------------------------- serial

RECORD = re.compile(r"BENCH (seq=\d+ .*) crc=([0-9a-f]{8})$")


def parse_serial(data):
    """Parse guest records. A record counts only if its CRC matches; the log
    is complete only if seq runs 1..N without gaps or duplicates, record N is
    the poweroff record, and there is exactly one result record."""
    records, problems = {}, []
    for raw in data.split(b"\n"):
        line = raw.rstrip(b"\r").decode("utf-8", "replace")
        i = line.find("BENCH seq=")
        if i < 0:
            continue
        m = RECORD.match(line[i:])
        if not m:
            problems.append("malformed")
            continue
        body = "BENCH " + m.group(1)
        if zlib.crc32(body.encode()) != int(m.group(2), 16):
            problems.append("crc")
            continue
        fields = {}
        for tok in body.split(" ")[1:]:
            k, sep, v = tok.partition("=")
            k = unquote_plus(k)
            if not sep or k in fields:
                fields = None
                break
            fields[k] = unquote_plus(v)
        if fields is None or not fields["seq"].isdigit():
            problems.append("fields")
            continue
        seq = int(fields["seq"])
        if seq in records:
            problems.append(f"duplicate seq {seq}")
            continue
        records[seq] = fields
    n = max(records, default=0)
    results = [r for r in records.values() if r.get("kind") == "result"]
    complete = (n > 0 and sorted(records) == list(range(1, n + 1))
                and records[n].get("kind") == "poweroff" and len(results) == 1 and not problems)
    if n and sorted(records) != list(range(1, n + 1)):
        problems.append("seq gap")
    return [records[k] for k in sorted(records)], complete, problems


def _find(records, kind, **match):
    return [r for r in records if r.get("kind") == kind and all(r.get(k) == v for k, v in match.items())]


def guest_report(records, complete, problems):
    result = (_find(records, "result") or [{}])[-1]
    pre = (_find(records, "preflight") or [{}])[-1]
    metrics = {}
    for phase in ("before", "after"):
        metrics[phase] = {
            "meminfo": bool(_find(records, "meminfo", phase=phase, status="ok")),
            "child_cgroup": bool(_find(records, "cgroup", phase=phase, scope="child")),
            "child_memory_stat": bool(_find(records, "cgroupfile", phase=phase, scope="child",
                                            file="memory.stat", status="ok")),
        }
    after = (_find(records, "cgroup", phase="after", scope="child") or [{}])[-1]
    metrics_available = (complete and all(all(v.values()) for v in metrics.values())
                         and after.get("memory.peak", "").isdigit())
    return {
        "complete": complete,
        "problems": problems,
        "arm": pre.get("arm"),
        "status": result.get("status"),
        "reason": result.get("reason"),
        # Only a complete, CRC-checked log can report a verified digest.
        "digest_verified": complete and result.get("digest_verified") == "true"
                           and result.get("model_sha256") == MODEL_SHA256
                           and result.get("model_bytes") == str(MODEL_SIZE),
        "poweroff_record": bool(records) and records[-1].get("kind") == "poweroff",
        "metrics_available": metrics_available,
        "metrics_phases": metrics,
        "child_peak_bytes": after.get("memory.peak"),
        "copy_verify_ms": result.get("copy_verify_ms"),
        "child_wall_ms": result.get("child_wall_ms"),
        "advised_bytes": result.get("advised_bytes"),
        "advice_failures": result.get("advice_failures"),
        "loader_stdout": [r.get("line") for r in _find(records, "child-stdout")],
        "loader_stderr": [r.get("line") for r in _find(records, "child-stderr")],
    }


# ---------------------------------------------------------------- verdict

def classify_arm(expected_arm, host, guest):
    """Host verdict for one boot. Order matters: any host-side kill or
    failure wins over whatever the guest printed, so a killed guest is
    never reported as a success."""
    checks = [
        ("preflight_refused", host.get("preflight_error")),
        ("start_failed", host.get("start_error")),
        ("helper_error", host.get("helper_error")),
        ("limits_not_enforced", host.get("limits_error")),
        ("identity_changed", host.get("identity_error")),
        ("killed_low_host_memory", host.get("watchdog_stop") == "low_host_memory"),
        ("killed_host_deadline", host.get("watchdog_stop") == "host_deadline"),
        ("watchdog_stopped", bool(host.get("watchdog_stop"))),
        ("unit_timeout", host.get("result") == "timeout"),
        ("qemu_failed", host.get("exec_main_code") != "1" or host.get("exec_main_status") != "0"
                        or host.get("result") != "success"),
        ("serial_incomplete", not guest.get("complete")),
        ("arm_mismatch", guest.get("arm") != expected_arm),
        ("guest_error", guest.get("status") != "ok"),
        ("digest_not_verified", not guest.get("digest_verified")),
        ("metrics_unavailable", not guest.get("metrics_available")),
        ("model_identity_changed", host.get("model_identity_changed")),
        ("cleanup_failed", host.get("cleanup_error")),
    ]
    for outcome, failed in checks:
        if failed:
            return outcome
    return "success"
