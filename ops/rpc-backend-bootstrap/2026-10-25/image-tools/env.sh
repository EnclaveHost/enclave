# sourced by every step (adapted from linux-runtime-release/tools/env.sh): the ssh/scp/sftp-denying stubs FIRST in PATH, proved
# selected (shell lookup + a node child), and the job proved to run in a PRIVATE network namespace (q.sh: unshare -r -n) whose
# only interface is loopback.
B=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/image
R=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/image
L=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch
V=$L/chain-verifier-inputs
C=ec56a70f143cf1bb6bbdd52228401bcf24eca05b; TREE=fd45bf5da82475033f2abcc586b7e21fc36ded04; C9=ec56a70f1
S=$B/src; OUT=$B/dist-linux-$C9
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
KEPT=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90
OVMF=$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF"
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
export PATH="$B/stub/bin:$PATH" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$B/tmp"
unset GIT_DIR GIT_WORK_TREE
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
pin() { local got; got=$(sha256sum < "$1" | cut -c1-64); [ "$got" = "$2" ] && echo "[pin] OK $1 $got" || { echo "[pin] MISMATCH $1 $got (want $2)"; exit 7; }; }
for c in ssh scp sftp; do [ "$(command -v $c)" = "$B/stub/bin/$c" ] || { echo "STUB NOT SELECTED for $c"; exit 3; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","stub-proof"]);if(r.status!==255)process.exit(3)' || { echo "node child does not get the stub"; exit 3; }
echo "[env] ssh/scp/sftp -> $B/stub/bin (shell + node child proved)"
ifs=$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\n' ' ')
[ "$ifs" = "lo " ] || { echo "NOT in a private network namespace (interfaces: $ifs)"; exit 3; }
[ -z "$(tail -n +2 /proc/self/net/route)" ] || { echo "a route exists in the job's namespace"; exit 3; }
echo "[env] private network namespace: interfaces = lo only, no IPv4 route ($(readlink /proc/self/ns/net))"
STUB_BASE=$(wc -l < "$B/stub/invocations.log")
stub_none() { local n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]; }
