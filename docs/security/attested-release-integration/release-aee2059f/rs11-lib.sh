# rs-11's pins and the checks it ADDS to rs-9's (sourced by rs-11.sh, rs-11-accept.sh and rs11-selftest.sh). No env value printed.
DEST=/opt/enclave-predict/rel-aee2059ffcc7
NEW_SHA=414810a351c3ad572a4a476b6d475b4fa26f9d66d970c5ec1aa42e18cfb67f5b   # lines4.env: R's 3 lines (6877d7de) + the allowlist + N1, N2
OLD_SHA=d2598b43029a25cd165aa4b7a2a19091cf67fa30aa93a9ca6d28d868af4319d8   # lines4.before.env: the live 3 lines (03e0ccf1) + the live allowlist
N1=b2dba54a92de62850f2624da3e84912ae940da8e966155d1e03f51d6bb580797841f90bd9c3d35ef893f60c7d04a27df   # node image N1 2492e683 (5d GO)
N2=fab9c6c76aca8d7650c05d5efdddc27b4b5aa76e7d81cd5c97365458513aedcf70ffe7d2817ac3836575b34917954bb0   # node image N2 6845565a (d1 GO)
ADD="$N1,$N2"
LIVE_NODE=02f6e313a2c03f7f163426e03154654233ac6d8ac9bcc00f598ff94f3a1f596312f8849ea7419db0c4425bdf13bdde8b   # f6cbd75a, KEPT
R=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532; K=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77
S9_EPOCH=${S9_EPOCH:-$HOME/enclave-bench/fl-20260926/state/s9-switched-epoch}   # 63's S9 (guestd onto R) writes it
HV=nucbox-k11
# a named box's public row: metal-iso0 -> its attested measurement; nucbox-k11 -> "<mode> <ownerOnly> <served ids>"; "absent"
node_meas() { curl -sS -m 20 https://api.enclave.host/enclaves | python3 -c '
import json, sys
r = [e for e in json.load(sys.stdin).get("enclaves", []) if e.get("name") == sys.argv[1]]
print((r[0].get("measurement") or "none") if r else "absent")' "${1:-metal-iso0}"; }
hv_row() { curl -sS -m 20 https://api.enclave.host/enclaves | python3 -c '
import json, sys
r = [e for e in json.load(sys.stdin).get("enclaves", []) if e.get("name") == sys.argv[1]]
if not r: print("absent"); sys.exit(0)
e = r[0]; print(e.get("mode") or "-", "true" if e.get("ownerOnly") is True else "false", *sorted(d.get("id", "") for d in (e.get("servesDeployments") or [])))' "${1:-$HV}"; }
hv_attach_line() { $NAN "journalctl _SYSTEMD_INVOCATION_ID=$1 --no-pager -o short-iso-precise | grep -m1 -F '[tunnel] ${2:-$HV} attached via attestation(hv-node)'" || true; }
# the ROLLBACK guards (a rollback takes N1, N2 off the allowlist AND R out of all three lines): refuses, with the reason, while
#  (a) metal-iso0 attests N1 or N2 (63's N1-b/N2-b ran: the node would be refused on its next attach) - roll the node back first;
#  (b) 63's S9 epoch file exists (guestd builds guests on R: they would lose secrets and certificates) - roll S9 back first;
#  (c) metal-iso0's measurement cannot be read (fail closed);
#  (d) a guestd record on this host names R (guest_on_r, below; enclave-5d's R1).   $1 = metal-iso0's measurement as read
rollback_guard() {
  local m=$1
  [[ "$m" =~ ^[0-9a-f]{96}$ ]] || { echo "metal-iso0's measurement is unreadable ('${m:0:20}')"; return 1; }
  case ",$ADD," in *",$m,"*) echo "metal-iso0 attests ${m:0:8} (N1/N2): roll the node back to f6cbd75a FIRST (enclave-63)"; return 1;; esac
  [ ! -e "$S9_EPOCH" ] || { echo "S9 switched guestd to R at epoch $(cat "$S9_EPOCH" 2>/dev/null) ($S9_EPOCH): roll S9 back FIRST (enclave-63)"; return 1; }
  # an EXACT "clear" is the only pass (enclave-5d): a missing python3, a traceback or empty output all refuse (fail closed)
  local g; g=$(guest_on_r 2>&1); [ "$g" = clear ] || { echo "${g:-no answer from the guestd-record check (fail closed)}"; return 1; }
  return 0
}
# (d) (enclave-5d's R1) a guest BUILT ON R survives an S9 rollback (the old guestd re-adopts it; s9t-rollback removes the epoch),
# so the guard also reads guestd's own records on this host (key-free: the instance.json files, never its API or key). It prints
# EXACTLY "clear" only when the root and every record read and none names R; anything else it prints (a reason, a traceback,
# nothing) is a refusal - rollback_guard passes on "clear" alone. Order after e8: S9 rollback -> each e8 canary back onto
# 5db18199 -> rs-11 rollback.
GUESTD_ROOT=${GUESTD_ROOT:-$HOME/enclave-prod/guestd-root}
guest_on_r() { python3 - "$R" "$GUESTD_ROOT" <<'PYG'
import glob, json, os, sys
r, root = sys.argv[1], sys.argv[2]
if not os.path.isdir(root) or not os.access(root, os.R_OK | os.X_OK): print(f"the guestd records at {root} cannot be read (fail closed)"); sys.exit(1)
for d in sorted(glob.glob(os.path.join(root, "gd*"))):
    f = os.path.join(d, "instance.json")
    try: rel = json.load(open(f)).get("Releases")
    except Exception as e: print(f"the guestd record {f} cannot be read ({type(e).__name__}; fail closed)"); sys.exit(1)
    if not isinstance(rel, list): print(f"the guestd record {f} names no Releases list (fail closed)"); sys.exit(1)
    if r in rel: print(f"a guestd record names {r[:8]} ({os.path.basename(d)}): relaunch that guest onto 5db18199 FIRST (after S9's rollback)"); sys.exit(1)
print("clear")
PYG
}
# the live allowlist line's sha256 on nan, and the expected one from the staged file (after = lines4.env, before = lines4.before.env)
allow_live() { $NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env | sha256sum | cut -c1-64"; }
allow_staged() { $NAN "grep '^METAL_ALLOWED_MEASUREMENTS=' $DEST/$1 | sha256sum | cut -c1-64"; }
