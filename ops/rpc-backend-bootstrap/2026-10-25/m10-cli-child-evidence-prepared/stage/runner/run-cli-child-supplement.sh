#!/bin/bash
# SUPPLEMENTAL M10 CLI child evidence (GUEST, root, FOREGROUND, ONE attempt; NOT run by Claude):
#   bash /srv/m10-guest-validation/stage-cli-child/runner/run-cli-child-supplement.sh <attempt 1-9> <sha256 of pins/pins.json>
# The stage directory (this file's ../) must be a READ-ONLY root-owned copy outside /home (ProtectHome hides /home).
# Runs ONLY the already compiled run-2 CLI test binary (no build, no cargo, no DB, no live config): a pinned copy is executed
# by the dedicated user m10build in a transient unit with MemoryMax 256M, no swap, CPUQuota 100%, PrivateNetwork,
# PrivateTmp, ProtectSystem=strict, ProtectHome, writable ONLY in its work dir, RuntimeMaxSec 15 min, KillMode=control-group.
# The ORIGINAL run-2 receipt (pass:false) is never modified: the compound verdict is a separate receipt
# (receipts/cli-child-<N>.compound.json) written by checker/check_compound.py, fail-closed.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); N=${1:-}; WANT=${2:-}
[[ "$N" =~ ^[1-9]$ ]] && [[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: usage run-cli-child-supplement.sh <1-9> <pins-sha256>"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "## REFUSED: run as root"; exit 2; }
case "$H" in /home/*) echo "## REFUSED: the stage must not be under /home (ProtectHome)"; exit 2;; esac
PINS=$H/pins/pins.json
sha() { sha256sum "$1" 2>/dev/null | cut -c1-64; }
[ "$(sha "$PINS")" = "$WANT" ] || { echo "## REFUSED: pins.json sha256 differs from the argument"; exit 2; }
(cd "$H" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## REFUSED: stage MANIFEST.sha256 does not verify"; exit 2; }
pin() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$PINS" "$1"; }
BASE=/srv/m10-guest-validation; R=$(pin run2.receiptDir); L2=$(pin run2.logsDir); SUP=$BASE/supplement/cli-child-$N; U=m10-cli-child-$N
BIN=$(pin binary.path); BINSHA=$(pin binary.sha256); SRC=$(pin source.guestPath); SRCSHA=$(pin source.sha256)
for p in "$SUP" "$R/cli-child-$N.out" "$R/cli-child-$N.launcher.json" "$R/cli-child-$N.compound.json"; do [ ! -e "$p" ] || { echo "## REFUSED: $p exists"; exit 2; }; done
# pins BEFORE anything runs: the compiled binary (mutable run-1 cache), the reviewed test source, every run-2 receipt/log
B0=$(sha "$BIN"); [ "$B0" = "$BINSHA" ] || { echo "## REFUSED: $BIN sha256 ${B0:-missing} != pinned $BINSHA"; exit 2; }
[ "$(sha "$SRC")" = "$SRCSHA" ] || { echo "## REFUSED: CLI test source $SRC differs from the reviewed node.rs pin"; exit 2; }
python3 -I - "$PINS" "$R" "$L2" <<'PY' || { echo "## REFUSED: a run-2 receipt or log differs from its pin"; exit 2; }
import hashlib, json, pathlib, sys
p = json.load(open(sys.argv[1])); r, l = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]); bad = []
for d, files in ((r, p["run2"]["receipts"]), (l, p["run2"]["logs"])):
    for f, want in files.items():
        q = d / f
        if not q.is_file() or hashlib.sha256(q.read_bytes()).hexdigest() != want: bad.append(str(q))
present = sorted(x.name for x in l.glob("*.test.out"))
if present != sorted(p["run2"]["logs"]): bad.append(f"run-2 logs set {present}")
print("\n".join(bad)); sys.exit(1 if bad else 0)
PY
install -d -m 0755 "$BASE/supplement" "$SUP" "$SUP/bin" && install -d -o m10build -g m10build -m 0750 "$SUP/work" "$SUP/work/home" || { echo "## REFUSED: directories"; exit 2; }
install -m 0555 -o root -g root "$BIN" "$SUP/bin/cli-test" || { echo "## REFUSED: binary copy"; exit 2; }
BC=$(sha "$SUP/bin/cli-test"); [ "$BC" = "$BINSHA" ] || { echo "## REFUSED: copied binary sha256 $BC"; exit 2; }
S0=$(date -u +%FT%TZ)
systemd-run --unit=$U --uid=m10build --gid=m10build --wait --pipe --quiet \
  -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=100% -p Nice=10 -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p RuntimeMaxSec=15min -p TimeoutStartSec=15min -p KillMode=control-group -p TimeoutStopSec=30 \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p "ReadWritePaths=$SUP/work" -p "WorkingDirectory=$SUP/work" \
  -E "HOME=$SUP/work/home" -E LANG=C.UTF-8 \
  -- /usr/bin/python3 -I "$H/runner/cli_child_cases.py" "$SUP/bin/cli-test" "$PINS" "$SUP/work/out" > "$R/cli-child-$N.out" 2>&1
rc=$?; S1=$(date -u +%FT%TZ)
UNIT=$(systemctl show $U -p Result -p ExecMainCode -p ExecMainStatus -p MemoryPeak 2>/dev/null | tr '\n' ' '); systemctl reset-failed $U 2>/dev/null || true
B1=$(sha "$BIN"); BC1=$(sha "$SUP/bin/cli-test")
python3 -I - "$R/cli-child-$N.launcher.json" "$N" "$rc" "$UNIT" "$S0" "$S1" "$WANT" "$BIN" "$B0" "${B1:-missing}" "$BC" "${BC1:-missing}" "$(sha "$SRC")" "$SUP/work/out" <<'PY'
import json, sys
o, n, rc, unit, s0, s1, want, b, b0, b1, bc, bc1, src, sup = sys.argv[1:]
json.dump({"format": "m10-cli-child-supplement-launcher/v1", "attempt": int(n), "unitExit": int(rc), "unit": unit, "start": s0, "end": s1,
  "pinsSha256": want, "binaryPath": b, "binarySha256Before": b0, "binarySha256After": b1, "executedCopySha256": bc,
  "executedCopySha256After": bc1, "sourceSha256": src or "missing", "supplementOut": sup}, open(o, "w"), indent=1)
PY
python3 -I "$H/checker/check_compound.py" --pins "$PINS" --run2-receipts "$R" --run2-logs "$L2" --supplement "$SUP/work/out" \
  --launcher "$R/cli-child-$N.launcher.json" > "$R/cli-child-$N.compound.json"; C=$?
echo "## cli-child supplement attempt $N: unit exit $rc; compound checker rc $C (receipt $R/cli-child-$N.compound.json)"
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print("## compoundAccepted:",d["compoundAccepted"]);[print("## REASON:",x) for x in d["failures"][:40]]' "$R/cli-child-$N.compound.json"
[ "$C" = 0 ] && exit 0; exit 1
