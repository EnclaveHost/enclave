set -eu
id enclave-storage-tunnel >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/enclave-storage-tunnel --shell /usr/sbin/nologin enclave-storage-tunnel
install -d -o enclave-storage-tunnel -g enclave-storage-tunnel -m 700 /var/lib/enclave-storage-tunnel
if [ ! -f /var/lib/enclave-storage-tunnel/id_ed25519 ]; then
 runuser -u enclave-storage-tunnel -- ssh-keygen -q -t ed25519 -N '' -C enclave-storage-tunnel-20261019 -f /var/lib/enclave-storage-tunnel/id_ed25519
fi
cat /var/lib/enclave-storage-tunnel/id_ed25519.pub
