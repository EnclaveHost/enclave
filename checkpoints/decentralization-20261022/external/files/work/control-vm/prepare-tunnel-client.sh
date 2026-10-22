set -eu
id enclave-control-tunnel >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/enclave-control-tunnel --shell /usr/sbin/nologin enclave-control-tunnel
install -d -o enclave-control-tunnel -g enclave-control-tunnel -m 700 /var/lib/enclave-control-tunnel
if [ ! -f /var/lib/enclave-control-tunnel/id_ed25519 ]; then
 runuser -u enclave-control-tunnel -- ssh-keygen -q -t ed25519 -N '' -C enclave-control-tunnel-20261019 -f /var/lib/enclave-control-tunnel/id_ed25519
fi
cat /var/lib/enclave-control-tunnel/id_ed25519.pub
