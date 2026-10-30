#!/usr/bin/env bash
# prod-host.sh <release apk> [component.wasm] -- run the phone as a pVM CPU HOST in production (PVM-CPU.md, "Production path"):
# the release app (host.enclave.pvmcpu, signed with the owner's release key; build.sh ANCHOR_RELEASE_KEYSTORE=...) serves a
# CPU-only Wasm component until stopped, from its foreground service, attached to the production relay's fleet tunnel. The
# relay admits it on PVM_CPU_CODE_HASHES / PVM_CPU_AUTHORITY_HASHES / PVM_CPU_RUNTIME_IDS (relay/pvm-cpu-tier.mjs), and it is
# listed on https://api.enclave.host/enclaves with lane "pvm-cpu". A lost tunnel re-attaches in place (RelayKeeper).
# Env: NAME (the tunnel name, default pixel10-pvm-cpu), VMNAME (default pvmprod1), RELAY (default the production tunnel),
# LABEL (the capture label, default prod-<UTC time>). Stop it with: adb shell am force-stop host.enclave.pvmcpu
set -uo pipefail
APK="$1"; H="$(cd "$(dirname "$0")/.." && pwd)"; WASM="${2:-$H/runtime/conformance/bundles/cpu-probe.wasm}"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; R=host.enclave.pvmcpu
NAME="${NAME:-pixel10-pvm-cpu}"; VM="${VMNAME:-pvmprod1}"; RELAY="${RELAY:-wss://api.enclave.host/v1/fleet-tunnel}"
LABEL="${LABEL:-prod-$(date -u +%Y%m%dT%H%M%SZ)}"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $R | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { echo "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $R | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { echo "installed APK $have is not $want"; exit 2; }
sh_ "pm grant $R android.permission.MANAGE_VIRTUAL_MACHINE; pm grant $R android.permission.POST_NOTIFICATIONS" >/dev/null
"$ADB" push "$WASM" /data/local/tmp/pvm-host-app.wasm </dev/null >/dev/null || exit 2
sh_ "run-as $R mkdir -p files && run-as $R cp /data/local/tmp/pvm-host-app.wasm files/app.wasm" >/dev/null
echo "apk $want; component $(sha256sum "$WASM" | cut -c1-64); tunnel $NAME -> $RELAY; capture $LABEL"
sh_ "am force-stop $R; am start-foreground-service -n $R/host.enclave.anchor.avf.AnchorService --es mode app --es vmname $VM --es app /data/user/0/$R/files/app.wasm --ei app_serve_s 0 --es relay $RELAY --es name $NAME --es capture $LABEL"
echo "watch: $ADB shell run-as $R cat files/capture/$LABEL.log"
