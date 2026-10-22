#!/bin/bash
# LOCAL (this dev host, through the queue at 256): freeze the ruleset from tree/ kernel.mjs, write the MANIFEST, then run
# stage2.sh in SCAFFOLD mode under an unprivileged user namespace. This validates the namespaces, kernel WireGuard peers and
# the Python fixtures; the DNS expressions cannot load on this kernel (no module tree), which scaffold mode reports.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
node "$D/gen-frozen.mjs"
{ echo "Frozen inputs generated $(date -u -r "$D/frozen/ruleset-dns.nft" +%FT%TZ) (mtime) by gen-frozen.mjs (local-scaffold.sh, queue 256) from:"
  echo "  $(cd "$D/.." && sha256sum tree/network/wg-provider/kernel.mjs)"; echo "  $(cd "$D" && sha256sum gen-frozen.mjs)"; echo "  node $(node --version)"
  echo "frozen/SHA256SUMS: $(sha256sum "$D/frozen/SHA256SUMS" | cut -c1-64)"; } > "$D/SOURCE.txt"
(cd "$D" && sha256sum run.sh stage2.sh dnsfix.py gen-frozen.mjs README.txt SOURCE.txt control/rev3-ruleset-dns.nft control/rev3-sync-h1.nft control/rev3-sync-h2.nft > MANIFEST.sha256 && cat MANIFEST.sha256 && cat SOURCE.txt)
unshare -r --net --mount --pid --fork --mount-proc /bin/bash "$D/stage2.sh" "$D" scaffold
