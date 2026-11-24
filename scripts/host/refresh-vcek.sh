#!/usr/bin/env bash
# Keep metal0's VCEK (metal/config.json "vcekFile" -> vcek.der here) matching the chip's REPORTED TCB.
#
# The agent sends this VCEK with every fleet-tunnel quote. After a microcode or SEV firmware update (amd-ucode
# 20261019 took effect at the 2026-11-18 boot: ucode SPL 0x75 -> 0x7b) the chip signs reports with a different VCEK,
# the relay answers "attest REJECTED: VCEK signature over the report is invalid", and metal0 drops off the listing.
#
# The network agent (enclave-network/metal0/config.json linux.vcekFile) judges whole-VM guests such as Enclave RPC with
# the same file: stale, it refuses their proofs, the relay holds their routes ("private_routes_unavailable"), the app's
# name gets no DNS record and no certificate.
#
# Runs as ExecStartPre of enclave-metal.service and enclave-network-agent.service: reads chip ID + reported TCB from
# /dev/sev (bin/sev-inventory, read-only), fetches that TCB's VCEK from AMD KDS once (cached in by-tcb/), verifies it
# against AMD's pinned chain + CRL and the floor in min-tcb.json (isolation/m2/host-collateral.mjs prepare), installs it.
# Never blocks either service from starting: on failure it keeps the current vcek.der and says why.
set -u
DIR=/home/steven/enclave-prod/collateral/metal0
HC=/home/steven/enclave-prod/metal-deabf8f90/isolation/m2/host-collateral.mjs
log() { echo "[refresh-vcek] $*"; }

# both services run this at boot: one at a time, the second finds the first's result
exec 9>"$DIR/.lock" && flock -w 170 9 || { log "WARN: another refresh still holds $DIR/.lock; keeping $DIR/vcek.der"; exit 0; }

tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
if ! node "$HC" inventory --firmware --helper "$DIR/bin/sev-inventory" --statement-out "$tmp/st.json" >/dev/null; then
  log "WARN: could not read the chip's TCB from /dev/sev; keeping $DIR/vcek.der"; exit 0
fi
key=$(node -p 'const s = JSON.parse(require("fs").readFileSync(process.argv[1])); `${s.chipId}-${s.reportedTcbRaw}`' "$tmp/st.json")
want="$DIR/by-tcb/$key"

# collateral.json is the last file prepare places: its presence marks a complete, verified set
if [ ! -f "$want/collateral.json" ]; then
  rm -rf "$want"
  for wait in 10 20 30 0; do
    node "$HC" prepare --statement "$tmp/st.json" --min-tcb "$DIR/min-tcb.json" --fetch-vcek --fetch-crl --out "$want" >/dev/null && break
    rm -rf "$want"
    [ "$wait" -gt 0 ] && { log "KDS fetch/verify failed for $key; retrying in ${wait}s"; sleep "$wait"; }
  done
  if [ ! -f "$want/collateral.json" ]; then
    log "WARN: no verified VCEK for $key; keeping $DIR/vcek.der (the relay will reject the tunnel quote if it is stale)"; exit 0
  fi
fi

# guestd judges every per-app guest it launches with its own copy (its -vcek default; it reads the file at each
# launch, so no restart). That copy was not kept here until 2026-11-24: after the 2026-11-18 boot it still held the
# VCEK of the old microcode and guestd rejected every per-app guest for six days ("VCEK signature over the report is
# invalid"), while the two files this script already kept were current.
GUESTD_VCEK=/home/steven/.cache/enclave-isolation/m3-clean/vcek.der
sync_guestd() {
  [ -f "$GUESTD_VCEK" ] || return 0
  cmp -s "$want/vcek.der" "$GUESTD_VCEK" && return 0
  cp "$want/vcek.der" "$GUESTD_VCEK.new" && mv -f "$GUESTD_VCEK.new" "$GUESTD_VCEK" && log "installed VCEK for $key in guestd's copy"
}

if cmp -s "$want/vcek.der" "$DIR/vcek.der"; then log "VCEK current for $key"; sync_guestd; exit 0; fi
cp "$want/vcek.der" "$DIR/.vcek.der.new" && mv -f "$DIR/.vcek.der.new" "$DIR/vcek.der" && log "installed VCEK for $key"
sync_guestd
