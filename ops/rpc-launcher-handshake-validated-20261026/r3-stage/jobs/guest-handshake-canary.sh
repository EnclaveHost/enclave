#!/bin/bash
# GUEST privileged canary (root inside the RPC VM; PREPARED, NOT run; only if root decides the local tests are not enough).
# It NEVER starts Base, never touches /etc/enclave-rpc/base-bootstrap, the DB or any unit. Under the unit's EXACT sandbox
# properties plus the proposed drop-in, it proves:
#   (1) the root launcher can flock and durably append a journal (the r2 wrapper's own launch_lock/journal_append) only on
#       the drop-in ReadWritePaths, while the rest of /etc and a launch dir stay read-only (EROFS);
#   (2) it can read the rpcbase-owned data dir (CAP_DAC_READ_SEARCH);
#   (3) the r2 wrapper's real drop_privileges() yields exactly the legacy User=rpcbase identity (uids, gids, groups), with
#       CapEff/CapPrm 0, NoNewPrivs 1, and setuid(0) failing.
# Usage: guest-handshake-canary.sh <copy of r2/wrapper/chain_service.py>   (bounded: RuntimeMaxSec=60, MemoryMax=256M)
set -euo pipefail
WRAP=${1:?r2 wrapper path}; WANT=07276ec89e3d779f852b4d77085fe54b258f2807d063184a0f9dea83a3ad659b
[ "$(id -u)" = 0 ] && [ "$(sha256sum < "$WRAP" | cut -d' ' -f1)" = "$WANT" ] || { echo "REFUSED: root + the pinned r2 wrapper"; exit 2; }
C=/etc/enclave-rpc/base-bootstrap-canary; OUT=/root/base-handshake-canary-$(date -u +%Y%m%dT%H%M%SZ)
[ ! -e "$C" ] || { echo "REFUSED: $C exists"; exit 2; }
mkdir -m 0700 "$OUT"; install -d -o root -g root -m 0755 "$C" "$C/journal"
install -o root -g root -m 0600 /dev/null "$C/journal.lock"; install -o root -g root -m 0644 "$WRAP" "$C/chain_service.py"
trap 'rm -rf -- "$C"' EXIT
D=/srv/enclave-base-holder
COMMON=(--wait --pipe --collect --quiet -p Type=exec -p RequiresMountsFor=$D -p NoNewPrivileges=yes -p ProtectSystem=strict
        -p ProtectHome=yes -p PrivateTmp=yes -p UMask=0027 -p "ReadWritePaths=$D/data $D/tmp" -p RuntimeMaxSec=60
        -p MemoryMax=256M -p TasksMax=64)
ID='import json,os;print(json.dumps({"resuid":os.getresuid(),"resgid":os.getresgid(),"groups":sorted(os.getgroups())}))'
timeout 90 systemd-run "${COMMON[@]}" -p User=rpcbase -p Group=rpcbase /usr/bin/python3 -I -c "$ID" > "$OUT/legacy.json"
PY=$(cat <<'PYEOF'
import datetime, errno, importlib.util, json, os, pathlib
C = pathlib.Path('/etc/enclave-rpc/base-bootstrap-canary'); r = {}
s = importlib.util.spec_from_file_location('w', C / 'chain_service.py'); W = importlib.util.module_from_spec(s); s.loader.exec_module(W)
fd = W.launch_lock(C, 0)
r['journal'] = [e['event'] for _, e in W.journal_append(C / 'journal', 0, 'ab' * 32, [], 'armed', {'canary': True},
                                                        datetime.datetime.now(datetime.timezone.utc).isoformat())]
def erofs(p):
    try:
        os.close(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)); os.unlink(p); return False
    except OSError as e:
        return e.errno == errno.EROFS
r['etcReadOnly'] = erofs('/etc/enclave-rpc/.canary-probe'); r['launchDirReadOnly'] = erofs(str(C / '.canary-probe'))
r['dataReadable'] = isinstance(os.listdir('/srv/enclave-base-holder/data'), list)
W.drop_privileges(W.service_identity())
st = dict(l.split(':\t', 1) for l in pathlib.Path('/proc/self/status').read_text().splitlines() if ':\t' in l)
r.update(resuid=os.getresuid(), resgid=os.getresgid(), groups=sorted(os.getgroups()), capEff=st['CapEff'].strip(),
         capPrm=st['CapPrm'].strip(), noNewPrivs=st['NoNewPrivs'].strip())
try:
    os.setuid(0); r['setuid0'] = 'SUCCEEDED'
except PermissionError:
    r['setuid0'] = 'EPERM'
os.close(fd); print(json.dumps(r))
PYEOF
)
timeout 90 systemd-run "${COMMON[@]}" -p User=root -p Group=root -p Environment=ENCLAVE_BASE_LAUNCH_HANDSHAKE=1 \
  -p "ReadWritePaths=$C/journal $C/journal.lock" -p "CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH" \
  -p AmbientCapabilities= /usr/bin/python3 -I -c "$PY" > "$OUT/dropin.json"
python3 -I - "$OUT/legacy.json" "$OUT/dropin.json" <<'PYEOF'
import json, sys
L, D = (json.load(open(p)) for p in sys.argv[1:])
want = {'journal': ['armed'], 'etcReadOnly': True, 'launchDirReadOnly': True, 'dataReadable': True, 'capEff': '0000000000000000',
        'capPrm': '0000000000000000', 'noNewPrivs': '1', 'setuid0': 'EPERM', **L}
bad = {k: (D.get(k), v) for k, v in want.items() if D.get(k) != v}
print(json.dumps({'ok': not bad, 'mismatch': bad, 'legacy': L, 'dropin': D})); sys.exit(1 if bad else 0)
PYEOF
