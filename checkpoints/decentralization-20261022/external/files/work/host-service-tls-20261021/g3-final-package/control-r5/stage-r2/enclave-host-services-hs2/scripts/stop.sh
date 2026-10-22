#!/bin/bash
# Stop stage hs2: SIGTERM to the runner, which stops every role (KillMode=mixed: whatever remains after
# TimeoutStopSec=30s is killed). Then prove none of the stage's ports is still listening. Nothing public changes.
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
"$SYSTEMCTL" stop "$UNIT_NAME"
if "$SYSTEMCTL" is-active --quiet "$UNIT_NAME"; then die "$UNIT_NAME is still active"; fi
cfg=$(prefixed_config); trap 'rm -f "$cfg"' EXIT
ports=$("$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=[];for(const s of c.services){const x=s.config;for(const k of ["port","dnsPort","apiPort"])if(x[k])p.push(x[k])}console.log(p.join(" "))' "$cfg")
left=""
for p in $ports; do if ss -Hltnu | awk '{print $5}' | grep -qE "[:.]$p\$"; then left="$left $p"; fi; done
[ -z "$left" ] || die "ports still listening after stop:$left (another process?)"
echo "stopped $UNIT_NAME; none of the stage ports ($ports) is listening"
