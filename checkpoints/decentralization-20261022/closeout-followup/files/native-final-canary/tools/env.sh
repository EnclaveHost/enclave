# Sourced by every step (and by the root run): the ssh/scp/sftp-denying stubs FIRST in PATH, proved selected by the shell
# AND by a node child; a minimal PATH otherwise; no ambient GIT_DIR.
D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-final-canary
export PATH="$D/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GIT_DIR GIT_WORK_TREE
for c in ssh scp sftp; do [ "$(command -v $c)" = "$D/bin/$c" ] || { echo "STUB NOT SELECTED for $c"; exit 3; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","stub-proof"]);if(r.status!==255)process.exit(3)' || { echo "node child does not get the ssh stub"; exit 3; }
echo "[env] ssh/scp/sftp -> $D/bin (shell + node child proved)"
STUB_BASE=$(wc -l < "$D/logs/ssh-stub-invocations.log")
