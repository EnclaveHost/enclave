set -u
# READ-ONLY (reviewer 9d): the provider that actually runs (systemd drop-ins), its bundle sha and its config's sanitized keys.
D=/etc/systemd/system/enclave-network-provider.service.d
for f in $D/*.conf; do echo "### $f $(sha256sum < $f | cut -c1-64)"; sed -E 's/^(Environment=[^=]*(KEY|SECRET|TOKEN|PASS|PRIVATE)[^=]*=).*/\1<masked>/I' "$f"; done
X=$(systemctl show enclave-network-provider -p ExecStart --value | grep -o 'argv\[\]=[^;]*' | sed 's/argv\[\]=//')
echo "### argv: $X"
set -- $X; B=$2; C=${3:-}
sha256sum "$B" "$C"; ls -la "$(dirname "$B")" | awk '{print $5,$9}'
node -e '
const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const pick={keys:Object.keys(c).sort(),publicAddress:c.publicAddress,uplink:c.uplink,roles:c.roles,region:c.region,zone:c.zone,probeZone:c.probeZone,
 bootstrap:c.bootstrap??null,directories:c.directories,relay:c.relay,ports:c.ports,stateDir:c.stateDir,hostServices:c.hostServices??null,
 authorityPins:c.authorityPins??null,addressBook:c.addressBook??null,rpc:c.rpc,localRoutesCount:Array.isArray(c.localRoutes)?c.localRoutes.length:c.localRoutes?Object.keys(c.localRoutes).length:0};
console.log(JSON.stringify(pick));' "$C"
ls -la /etc/enclave-network | awk '{print $1,$5,$9}'
systemctl show enclave-network-provider -p Environment --value | tr ' ' '\n' | sed -E 's/^([^=]*(KEY|SECRET|TOKEN|PASS|PRIVATE)[^=]*=).*/\1<masked>/I'
