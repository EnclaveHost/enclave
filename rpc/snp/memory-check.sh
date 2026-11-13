#!/bin/sh
# What a built guest image does with memory it is not asked for, read from inside a boot of it.
#
# Run by rpc/snp/kvm_check.py as the boot's systemd.run= command (root, plain KVM, no chain disks, no SNP device),
# which puts UNITS='the image builder's MASKED_UNITS' in front of this text. Every finding is one console line
# starting with "QUAL " on the second serial port (the first is the console, and its getty hangs up whatever else has
# it open); nothing here judges, kvm_check.py does. The guest powers off at the end.
#
# It starts a copy of the Base client's unit (same user, sandbox, slice, limits and log namespace, a shell in place
# of the client) because the client itself needs its chain volume: that is what shows the unit's log lines arriving
# in the Base journal and gives the working-set probe a slice to ask.
exec >/dev/ttyS1 2>&1
say() { echo "QUAL $*"; }
CG=/sys/fs/cgroup/enclave.slice/enclave-rpc.slice/enclave-rpc-clients.slice
PROBE=/run/enclave-rpc-memprobe/state.json
field() { python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1])); print(*[s.get(k) for k in sys.argv[2:]])' "$PROBE" "$@" 2>&1; }
overlay() { du -xsm /media/root-rw/overlay 2>/dev/null | cut -f1; }

systemctl start --no-block multi-user.target
n=0
while [ $n -lt 150 ] && [ "$(systemctl is-active multi-user.target)" != active ]; do n=$((n+1)); sleep 2; done
say boot multi-user=$(systemctl is-active multi-user.target) waited=$((n*2))s kernel=$(uname -r) systemd=$(systemctl --version | sed -n '1s/ (.*//p' | tr ' ' -)
say memtotal-kb $(awk '/^MemTotal/{print $2}' /proc/meminfo)
say overlay-mb-at-boot $(overlay)
say journal-mb-at-boot $(du -sm /var/log/journal 2>/dev/null | cut -f1)

for u in $UNITS; do say unit $u $(systemctl is-enabled "$u" 2>&1 | head -1 | tr ' ' _) $(systemctl is-active "$u" 2>&1 | head -1); done
systemctl list-timers --all --no-pager --plain --no-legend | awk '{print "QUAL timer", $(NF-1)}'
systemctl list-units --type=service --state=running --no-pager --plain --no-legend | awk '{print "QUAL running", $1}'
systemctl --failed --no-pager --plain --no-legend | awk '{print "QUAL failed", $1}'
ps -eo rss=,comm= --sort=-rss | head -25 | awk '{print "QUAL rss-kb", $1, $2}'
say rss-kb-all $(ps -eo rss= | awk '{s+=$1} END{print s}')
awk '/^(MemFree|MemAvailable|Cached|Shmem|AnonPages|Slab):/{print "QUAL meminfo-kb", $1, $2}' /proc/meminfo

systemd-analyze cat-config systemd/journald.conf 2>/dev/null | grep -E '^[A-Z][A-Za-z]+=' | awk '{print "QUAL journald-conf", $0}'
grep -E '^[A-Z][A-Za-z]+=' /etc/systemd/journald@base.conf 2>/dev/null | awk '{print "QUAL journald-base-conf", $0}'
say syslog-file $(stat -c %s /var/log/syslog 2>/dev/null || echo none)

for u in enclave-rpc-clients.slice enclave-rpc-el.service enclave-rpc-cl.service enclave-rpc-base.service; do
    say limit $u $(systemctl show "$u" -p MemoryHigh -p MemoryMax -p TimeoutStopUSec | tr '\n' ' ')
done
say probe-unit $(systemctl is-enabled enclave-rpc-memprobe.service 2>&1 | head -1) $(systemctl is-active enclave-rpc-memprobe.service 2>&1 | head -1)
say probe-before $(field phase ticks asked short held lastError)
say front $(systemctl is-active enclave-rpc-front.service 2>&1 | head -1)

# The Base unit with a shell in place of the client: it logs, fills page cache from the read-only root, and stays.
mkdir -p /run/systemd/system/qual-base.service.d
sed -e '/^RequiresMountsFor=/d' -e '/^BindsTo=/d' -e '/^ReadWritePaths=/d' -e '/^Restart=/d' \
    -e "s|^ExecStart=.*|ExecStart=/bin/sh -c 'echo NSLINE-base-sandbox \$\$(id -un); find /usr /opt -xdev -type f -size +64k -exec cat {} + >/dev/null 2>\&1; echo NSLINE-base-loaded; exec sleep 1800'|" \
    /etc/systemd/system/enclave-rpc-base.service > /run/systemd/system/qual-base.service
cp /etc/systemd/system/enclave-rpc-base.service.d/*.conf /run/systemd/system/qual-base.service.d/ 2>/dev/null
ls /etc/systemd/system/enclave-rpc-base.service.d/ 2>/dev/null | awk '{print "QUAL base-dropin", $1}'
systemctl daemon-reload
systemctl start qual-base.service
say qual-base $(systemctl is-active qual-base.service) $(systemctl show qual-base.service -p LogNamespace -p User -p Slice -p MemoryMax -p MemoryHigh | tr '\n' ' ')
systemd-run --quiet --wait -u qual-plain /bin/echo NSLINE-default
n=0
while [ $n -lt 90 ] && ! journalctl '--namespace=*' -u qual-base -o cat --no-pager 2>/dev/null | grep -q NSLINE-base-loaded; do n=$((n+1)); sleep 2; done
journalctl '--namespace=*' -u qual-base -n 5 -o short-iso --no-pager 2>&1 | awk '{print "QUAL ns-tail", $0}'
say ns-every-namespace-sees-base $(journalctl '--namespace=*' -u qual-base -o cat --no-pager 2>/dev/null | grep -c NSLINE-base)
say ns-default-sees-base $(journalctl -u qual-base -o cat --no-pager 2>/dev/null | grep -c NSLINE-base)
say ns-base-sees-base $(journalctl --namespace=base -u qual-base -o cat --no-pager 2>/dev/null | grep -c NSLINE-base)
say ns-every-namespace-sees-default $(journalctl '--namespace=*' -u qual-plain -o cat --no-pager 2>/dev/null | grep -c NSLINE-default)
say journald-base $(systemctl is-active systemd-journald@base.service 2>&1 | head -1)
ls -d /var/log/journal/* 2>/dev/null | awk '{print "QUAL journal-dir", $1}'

say slice-loaded current=$(cat $CG/memory.current 2>&1) high=$(cat $CG/memory.high 2>&1) max=$(cat $CG/memory.max 2>&1) reclaim=$([ -e $CG/memory.reclaim ] && echo present || echo absent)
say qual-base-cgroup current=$(cat $CG/qual-base.service/memory.current 2>&1) high=$(cat $CG/qual-base.service/memory.high 2>&1) max=$(cat $CG/qual-base.service/memory.max 2>&1)
say slice-pressure $(head -1 $CG/memory.pressure 2>&1)

# More log text than the caps hold, into each journal: 2,000,000 distinct lines of about 190 bytes (about 380 MB).
# journald drops a unit's lines past a burst (10,000 in 30 s, scaled by free space) before it stores any, and a
# per-unit interval of 0 means "not set", so the flood units raise their burst instead.
FLOOD='BEGIN{p=sprintf("%170s","");gsub(/ /,"x",p);for(i=0;i<2000000;i++)printf "flood %d %s\n",i,p}'
t=$(date +%s)
systemd-run --quiet -u qual-flood-base -p LogNamespace=base -p LogRateLimitBurst=50000000 /usr/bin/awk "$FLOOD"
systemd-run --quiet -u qual-flood-main -p LogRateLimitBurst=50000000 /usr/bin/awk "$FLOOD"
n=0
while [ $n -lt 150 ] && { [ "$(systemctl is-active qual-flood-base 2>/dev/null)" = active ] || [ "$(systemctl is-active qual-flood-main 2>/dev/null)" = active ]; }; do n=$((n+1)); sleep 2; done
journalctl --sync; journalctl --namespace=base --sync 2>/dev/null
say flood seconds=$(( $(date +%s) - t )) base=$(systemctl is-active qual-flood-base 2>&1 | head -1) main=$(systemctl is-active qual-flood-main 2>&1 | head -1)
for d in /var/log/journal/*; do say journal-mb-after-flood $d $(du -sm "$d" | cut -f1); done
say flood-suppressed base=$(journalctl --namespace=base -o cat --no-pager 2>/dev/null | grep -c 'Suppressed .* messages from qual-flood') main=$(journalctl -o cat --no-pager 2>/dev/null | grep -c 'Suppressed .* messages from qual-flood')
say journal-lines-kept base=$(journalctl --namespace=base -u qual-flood-base -o cat --no-pager 2>/dev/null | wc -l) main=$(journalctl -u qual-flood-main -o cat --no-pager 2>/dev/null | wc -l)
say syslog-file-after-flood $(stat -c %s /var/log/syslog 2>/dev/null || echo none)
say overlay-mb-after-flood $(overlay)
df -m / /run 2>/dev/null | awk 'NR>1{print "QUAL df-mb", $6, "used", $3, "of", $2}'

# The probe looks once a minute: give it three looks at the loaded slice.
n=0
while [ $n -lt 100 ] && [ "$(field asked)" = 0 -o "$(field asked)" = 1 ]; do n=$((n+1)); sleep 2; done
say probe-after $(field phase ticks asked askedBytes short held lastError)
say probe-state $(cat $PROBE 2>&1 | head -c 1500)
say slice-probed current=$(cat $CG/memory.current 2>&1) high=$(cat $CG/memory.high 2>&1) max=$(cat $CG/memory.max 2>&1)
say qual-base-still $(systemctl is-active qual-base.service)
journalctl -u enclave-rpc-memprobe -o cat --no-pager -n 5 2>&1 | awk '{print "QUAL probe-log", $0}'

say front-memory $(python3 -I -c 'import sys; sys.path.insert(0, "/opt/enclave-rpc"); import front; sys.stdout.write(front.memory().decode())' 2>&1 | head -c 6000)
say front-journal $(python3 -I -c 'import sys; sys.path.insert(0, "/opt/enclave-rpc"); import front; print(len(front.journal("qual-flood-base.service", 200).splitlines()), len(front.journal("qual-flood-main.service", 200).splitlines()))' 2>&1 | tail -1)
say end
systemctl poweroff --force --force
