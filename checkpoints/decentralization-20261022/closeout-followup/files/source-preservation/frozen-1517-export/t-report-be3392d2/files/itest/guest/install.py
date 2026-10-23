"""Guest-only installation before systemd starts (as root, in the guest's tmpfs root).

What it installs:
- the composed tools: transport (t), S storage_nbd + budget, P's vendored storage_nbd + budget;
- the GENERATED units (byte-for-byte from the production-shaped renders the host made into /gin/units);
- the stand-in drop-ins (only ExecStart replaced);
- the run's fixture configs, client credentials and fixture ledger;
- the test target.

Also masks host units that are irrelevant to a diskless test VM. Nothing here touches the host."""
import json
import os
import shutil

GIN, SRC = "/gin", "/src"
os.makedirs("/etc/systemd/system", exist_ok=True)
open("/etc/passwd", "w").write("root:x:0:0:root:/root:/bin/bash\nenclave-holder:x:990:990::/:/usr/bin/nologin\n"
                               "enclave-l1:x:991:991::/:/usr/bin/nologin\nnobody:x:65534:65534::/:/usr/bin/nologin\n")
open("/etc/group", "w").write("root:x:0:\nenclave-holder:x:990:\nenclave-l1:x:991:\nnobody:x:65534:\nsystemd-journal:x:190:\n")
open("/etc/machine-id", "w").write(open(f"{GIN}/machine-id").read())
open("/etc/os-release", "w").write('NAME="enclave hdd compose test guest"\nID=enclave-test\n')
open("/etc/hostname", "w").write("hddtest\n")
os.symlink("/proc/self/mounts", "/etc/mtab")


def copytree(a, b):
    shutil.copytree(a, b, ignore=shutil.ignore_patterns("__pycache__", "test", "*.pyc"))


copytree(f"{SRC}/t/transport", "/opt/enclave-rpc-hdd/transport")
os.makedirs("/opt/enclave-base-holder", exist_ok=True)
for f in ("storage_nbd.py", "budget.py"):
    shutil.copyfile(f"{SRC}/s/holder/{f}", f"/opt/enclave-base-holder/{f}")
os.makedirs("/opt/enclave-l1-pair/vendor/holder", exist_ok=True)
for f in ("storage_nbd.py", "budget.py"):
    shutil.copyfile(f"{SRC}/p/l1pair/vendor/holder/{f}", f"/opt/enclave-l1-pair/vendor/holder/{f}")
os.makedirs("/opt/itest", exist_ok=True)
shutil.copyfile(f"{SRC}/itest/consumer.py", "/opt/itest/consumer.py")
for root, dirs, files in os.walk("/opt"):
    os.chmod(root, 0o755)
    for f in files:
        os.chmod(os.path.join(root, f), 0o755 if f.endswith(".py") else 0o644)

for u in os.listdir(f"{GIN}/units"):
    shutil.copyfile(f"{GIN}/units/{u}", f"/etc/systemd/system/{u}")
for unit, text in json.load(open(f"{GIN}/dropins.json")).items():
    os.makedirs(f"/etc/systemd/system/{unit}.d", exist_ok=True)
    open(f"/etc/systemd/system/{unit}.d/standin.conf", "w").write(text)
open("/etc/systemd/system/hddtest.target", "w").write(
    "[Unit]\nDescription=hdd compose test\nWants=hddtest-driver.service systemd-journald.service\n")
open("/etc/systemd/system/hddtest-driver.service", "w").write(
    "[Unit]\nDescription=hdd compose test driver\nAfter=basic.target systemd-journald.service\n\n"
    "[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -u -I /src/itest/guest/driver.py\n"
    "StandardOutput=file:/out/driver.log\nStandardError=inherit\nTimeoutStartSec=1500\n")
MASK = ["systemd-firstboot.service", "systemd-repart.service", "ldconfig.service", "systemd-hwdb-update.service",
        "systemd-tpm2-setup.service", "systemd-tpm2-setup-early.service", "systemd-pcrphase.service",
        "systemd-pcrphase-sysinit.service", "systemd-pcrmachine.service", "systemd-pcrnvdone.service",
        "systemd-pcrosseparator.service", "systemd-pcrproduct.service", "systemd-journal-catalog-update.service",
        "systemd-random-seed.service", "systemd-boot-random-seed.service", "systemd-binfmt.service",
        "systemd-sysusers.service", "systemd-machine-id-commit.service", "systemd-hibernate-clear.service",
        "systemd-journal-flush.service", "systemd-update-done.service", "systemd-networkd.service",
        "systemd-resolved.service", "systemd-timesyncd.service", "getty@tty1.service", "serial-getty@ttyS0.service",
        "systemd-logind.service", "dbus.socket", "dm-event.socket", "lvm2-monitor.service", "systemd-userdbd.socket",
        "systemd-homed.service", "systemd-udev-trigger.service"]
for m in MASK:
    p = f"/etc/systemd/system/{m}"
    if not os.path.lexists(p):
        os.symlink("/dev/null", p)

for d in ("/etc/enclave-rpc-hdd", "/etc/enclave-base-holder", "/etc/enclave-l1-pair", "/etc/enclave-rpc-cache"):
    os.makedirs(d, mode=0o755, exist_ok=True)
for role in ("l1", "base"):
    cd = f"/etc/enclave-rpc-hdd/{role}/client"
    os.makedirs(cd, mode=0o700)
    for f in ("ca-cert.pem", "client-cert.pem", "client-key.pem"):
        shutil.copyfile(f"{GIN}/creds/{role}/{f}", f"{cd}/{f}")
        os.chmod(f"{cd}/{f}", 0o600 if f.endswith("key.pem") else 0o644)
    shutil.copyfile(f"{GIN}/attach-{role}.json", f"/etc/enclave-rpc-hdd/attach-{role}.json")
for src, dst in (("holder-storage-nbd.json", "/etc/enclave-base-holder/holder-storage-nbd.json"),
                 ("holder-watch.json", "/etc/enclave-base-holder/holder-watch.json"),
                 ("l1pair-storage-nbd.json", "/etc/enclave-l1-pair/l1pair-storage-nbd.json"),
                 ("l1pair-watch.json", "/etc/enclave-l1-pair/l1pair-watch.json"),
                 ("ledger.json", "/etc/enclave-rpc-cache/nvme-cache-budget.json")):
    shutil.copyfile(f"{GIN}/{src}", dst)
    os.chmod(dst, 0o644)
for d in ("/srv", "/vm", "/var/lib", "/var/log", "/root"):
    os.makedirs(d, exist_ok=True)
print("installed")
