#!/usr/bin/env bash
# Publish a new version of the NAN frontend to IPFS via a STABLE IPNS name.
#   ./nan-deploy.sh /path/to/site-dir
#
# Lives on the nan box at /usr/local/bin/nan-deploy.sh (invoked by site/deploy.sh
# as `sudo -u ipfs IPFS_PATH=/var/lib/ipfs nan-deploy.sh /opt/nan-site`). This
# repo copy is the source of truth — deploy it with scripts/deploy-nan-deploy.sh.
#
# enclave.host (plus legacy aliases nan.host / nan.eth) points at the IPNS name (set ONCE), so a deploy is just:
#   add+pin new CID  ->  ipfs name publish  ->  prune superseded roots  ->  done. No DNS/ENS change per deploy.
set -euo pipefail
export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs}"
KEY="${NAN_IPNS_KEY:-nan}"      # named IPNS key; created on first run

SITE="${1:?usage: nan-deploy.sh <site-dir>}"
[ -d "$SITE" ] || { echo "not a directory: $SITE"; exit 1; }

# ensure the IPNS key exists and grab its name (k51...)
if ! ipfs key list -l | awk '{print $2}' | grep -qx "$KEY"; then
  echo "[deploy] creating IPNS key '$KEY' ..."
  ipfs key gen --type=ed25519 "$KEY" >/dev/null
fi
IPNS_NAME="$(ipfs key list -l | awk -v k="$KEY" '$2==k {print $1}')"

# The CURRENTLY published root, captured BEFORE we publish the new one. The prune
# at the end keeps it pinned for ONE more generation: after the IPNS switch a
# gateway can still serve this old CID from its namesys cache (~30s TTL), so its
# blocks must stay available or those requests 500 until the cache rolls over.
PREV_CID="$(ipfs name resolve --nocache "/ipns/$IPNS_NAME" 2>/dev/null | sed 's#^/ipfs/##' || true)"

echo "[deploy] adding $SITE ..."
CID="$(ipfs add -r --hidden -Q --cid-version 1 "$SITE")"        # CIDv1/base32 for DNSLink + ENS
ipfs pin add "$CID" >/dev/null
echo "[deploy] pinned $CID"

echo "[deploy] publishing /ipfs/$CID -> /ipns/$IPNS_NAME (can take ~30-60s) ..."
ipfs name publish --key="$KEY" --lifetime=72h --ttl=30s "/ipfs/$CID"

# publish can silently not take (observed 2026-07-10: resolve kept returning a
# previous CID, flapping between generations). Verify and republish until the
# record actually carries this CID; fail the deploy loudly if it never does.
for attempt in 1 2 3; do
  GOT="$(ipfs name resolve --nocache "/ipns/$IPNS_NAME" || true)"
  [ "$GOT" = "/ipfs/$CID" ] && break
  echo "[deploy] WARNING: record resolves to ${GOT:-nothing}, republishing (attempt $attempt) ..."
  ipfs name publish --key="$KEY" --lifetime=72h --ttl=30s --allow-offline "/ipfs/$CID"
  sleep 2
done
GOT="$(ipfs name resolve --nocache "/ipns/$IPNS_NAME" || true)"
if [ "$GOT" != "/ipfs/$CID" ]; then
  echo "[deploy] ERROR: IPNS record still resolves to ${GOT:-nothing}, expected /ipfs/$CID" >&2
  exit 1
fi
echo "[deploy] verified: /ipns/$IPNS_NAME -> /ipfs/$CID"

# --- prune superseded site roots ------------------------------------------
# Every deploy adds a brand-new root CID; the old ones would otherwise stay
# pinned forever (the frontend's pins grew by one full site tree per deploy —
# 200 stale roots had piled up by 2026-07-12). Unpin every OTHER site-shaped
# root, keeping only the one we just published, then GC. Best-effort: a prune
# failure must never fail an otherwise-good deploy. Retention stays consistent
# with the chunk-archive union above — the last 48h of hashed chunks live inside
# THIS root, so they remain pinned; only >48h-unique blocks are reclaimed.
if [ -x /usr/local/bin/nan-prune-site-roots.py ]; then
  echo "[deploy] pruning superseded site roots ..."
  # Keep BOTH this root and the previous one: the previous may still be served
  # from a gateway's IPNS cache for a few seconds after the switch, so GC'ing it
  # now would 500 those requests (its blocks would be gone). One extra generation
  # pinned covers that window; the next deploy reclaims it.
  KEEP=(--keep "$CID")
  [ -n "${PREV_CID:-}" ] && [ "$PREV_CID" != "$CID" ] && KEEP+=(--keep "$PREV_CID")
  SITE_IPNS="$IPNS_NAME" python3 /usr/local/bin/nan-prune-site-roots.py "${KEEP[@]}" --gc \
    || echo "[deploy] WARN site-root prune failed (non-fatal)"
fi

cat <<MSG

=========================================================
 IPNS name : $IPNS_NAME    (stable - set the records below ONCE)
 this CID  : $CID
=========================================================
ONE-TIME records (only on first deploy / if they ever change):

  enclave.host   DNS:
     _dnslink.enclave.host.   300   IN   TXT   "dnslink=/ipns/$IPNS_NAME"
     enclave.host.        A/AAAA -> this server

  nan.eth    ENS contenthash (legacy alias):
     ipns://$IPNS_NAME

Every future deploy: just re-run this script. The names already follow IPNS.

Verify:
  ipfs name resolve /ipns/$IPNS_NAME
  curl -sI https://enclave.host/ | head
=========================================================
MSG

# --- optional redundant pin (protects the ipfs:// path if THIS node is down) --
# ipfs pin remote add --service=backup --name="nan-$CID" "$CID" || true
