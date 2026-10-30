#!/bin/bash
# guest-state-install-stage/r1 (HOST, root/operator runs; PREPARED, not run): bounded LOCAL copy of the kept archive into the guest
# work dir over the VM's existing pinned SSH forward (127.0.0.1:22850, its own ssh_config + known_hosts). No WAN. The host archive is
# only READ. Resumable: rsync --partial --append-verify (a resumed copy re-checks the existing prefix). The guest then proves identity
# with `guest_state.py import-verify` (full sha256 == provenance). Refuses unless the guest has rsync and passwordless sudo, the work dir
# layout exists root 0700, and the guest filesystem has room for archive + extracted state + reserve.
#   transfer_to_guest.sh PROVENANCE.json [BWLIMIT_KIB]
set -euo pipefail
PROV=${1:?usage: transfer_to_guest.sh PROVENANCE.json [BWLIMIT_KIB]}; BW=${2:-0}
S=/home/steven/.local/state/enclave-rpc-production; SSH="ssh -F $S/ssh_config -o BatchMode=yes -o UserKnownHostsFile=$S/known_hosts -o StrictHostKeyChecking=yes"
HOST=enclave-rpc; W=/srv/enclave-base-holder/tmp/state-gsi
SRC=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["hostPath"])' "$PROV")
SIZE=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["size"])' "$PROV")
[ "$(stat -c %s "$SRC")" = "$SIZE" ] || { echo "REFUSED: host archive size != provenance"; exit 2; }
grep -q "^Host $HOST\b" $S/ssh_config || { echo "REFUSED: ssh_config has no Host $HOST (check the alias)"; exit 2; }
$SSH $HOST "command -v rsync >/dev/null && sudo -n true && sudo -n test -d $W/stage -a -d $W/x-home -a -d $W/extract-state && [ \"\$(sudo -n stat -c %U:%a $W)\" = root:700 ]" \
  || { echo "REFUSED: guest lacks rsync / passwordless sudo / the root 0700 work dir layout"; exit 2; }
FREE=$($SSH $HOST "df -B1 --output=avail /srv/enclave-base-holder | tail -1")
NEED=$(( SIZE + 1138167361549 + 200000000000 ))        # archive + extracted state + 200 GB reserve (history is separate: preflight)
[ "$FREE" -ge "$NEED" ] || { echo "REFUSED: guest free $FREE < $NEED"; exit 2; }
rsync -e "$SSH" --rsync-path="sudo -n rsync" --partial --append-verify --inplace --timeout=600 ${BW:+--bwlimit=$BW} \
  --chmod=F0600 --chown=root:root "$SRC" "$HOST:$W/state.tar.zst"
echo "transferred; now in the guest: guest_state.py import-verify ... --provenance <copy of $PROV in $W>"
