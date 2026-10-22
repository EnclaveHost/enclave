# sourced by every step: the ssh/scp/sftp-denying stubs FIRST in PATH, proved selected (shell lookup + a node child).
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-image-build
export PATH="$B/stub/bin:$PATH" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$B/tmp"
unset GIT_DIR GIT_WORK_TREE
for c in ssh scp sftp; do [ "$(command -v $c)" = "$B/stub/bin/$c" ] || { echo "STUB NOT SELECTED for $c"; exit 3; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","stub-proof"]);if(r.status!==255)process.exit(3)' || { echo "node child does not get the stub"; exit 3; }
echo "[env] ssh/scp/sftp -> $B/stub/bin (shell + node child proved)"
STUB_BASE=$(wc -l < "$B/stub/invocations.log")
