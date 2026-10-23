# sourced by every step (adapted from measured-image-build/tools/env.sh): the ssh/scp/sftp-denying stubs FIRST in PATH, proved
# selected (shell lookup + a node child), and the job proved to run in a PRIVATE network namespace (q.sh: unshare -r -n) whose
# only interface is loopback - no packet can leave this host.
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-carrier-closure
export PATH="$B/stub/bin:$PATH" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$B/tmp"
unset GIT_DIR GIT_WORK_TREE
for c in ssh scp sftp; do [ "$(command -v $c)" = "$B/stub/bin/$c" ] || { echo "STUB NOT SELECTED for $c"; exit 3; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","stub-proof"]);if(r.status!==255)process.exit(3)' || { echo "node child does not get the stub"; exit 3; }
echo "[env] ssh/scp/sftp -> $B/stub/bin (shell + node child proved)"
ifs=$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\n' ' ')
[ "$ifs" = "lo " ] || { echo "NOT in a private network namespace (interfaces: $ifs)"; exit 3; }
[ -z "$(tail -n +2 /proc/self/net/route)" ] || { echo "a route exists in the job's namespace"; exit 3; }
echo "[env] private network namespace: interfaces = lo only, no IPv4 route ($(readlink /proc/self/ns/net))"
STUB_BASE=$(wc -l < "$B/stub/invocations.log")
