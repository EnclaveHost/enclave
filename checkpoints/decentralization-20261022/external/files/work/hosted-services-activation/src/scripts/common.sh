# Shared by every stage script (sourced). Overridable for an isolated test: DESTDIR (a fake root), SYSTEMCTL, NODE.
LABEL=@LABEL@
UNIT_NAME=enclave-host-services.service
D=${DESTDIR:-}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
NODE=${NODE:-/usr/bin/node}
OPT=$D/opt/enclave-host-services/$LABEL
ETC=$D/etc/enclave-host-services/$LABEL
UNIT=$D/etc/systemd/system/$UNIT_NAME
DATA=$D/var/lib/enclave-host-services-data/$LABEL
RECEIPT=$ETC/install-receipt.txt
CONFIG=$ETC/host-services.json
die() { echo "$(basename "$0"): $*" >&2; exit "${2:-3}"; }
# the installed config with every absolute stage path moved under DESTDIR (identity when DESTDIR is empty)
prefixed_config() {
  local out; out=$(mktemp)
  sed -e "s#\"/opt/enclave-host-services/#\"$D/opt/enclave-host-services/#g" -e "s#\"/var/lib/enclave-host-services#\"$D/var/lib/enclave-host-services#g" "$CONFIG" > "$out"
  echo "$out"
}
