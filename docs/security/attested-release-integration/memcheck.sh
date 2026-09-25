B=/opt/enclave-predict/829c09adb176
W=$(mktemp -d); chown 65534 $W
CR="catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0 38b90458cf061ea5a6716f1a1201a5aa5b971ab31e91cec1707939a65f01f1809ddf3fe2ed8d764bc586c21353be2a93"
echo "peak before: $(cat /sys/fs/cgroup/memory.peak)"
env $(grep -v '^#' $B/predict.env | xargs) SECRETS_RELEASE_PREDICT_WORK=$W/work CHECK_BASE=$B VIEM=/r/node_modules/viem CROSSCHECK="$CR" \
  setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env HOME=$W node $B/check.mjs | cut -c1-240
echo "rc $?"
echo "memory.peak (bytes, this container's cgroup: node + git + go build + python + sev-snp-measure + gzip, cold work dir): $(cat /sys/fs/cgroup/memory.peak)"
grep -E "^(anon|file|shmem) " /sys/fs/cgroup/memory.stat
