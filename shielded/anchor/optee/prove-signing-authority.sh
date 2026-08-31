#!/usr/bin/env bash
# prove-signing-authority.sh -- we sign our own TAs; no vendor is involved.
#
# The phone-anchor research kept dead-ending on one fact: on a retail handset,
# TrustZone TAs are verified against a root-cert hash fused into the SoC, and
# that key belongs to the phone OEM. A solo LLC cannot get a trustlet signed
# for a retail Galaxy, at any price (shielded/anchor/SIGNING.md).
#
# On OP-TEE that problem does not exist, and this script demonstrates why
# rather than asserting it. The mechanism, from the OP-TEE tree:
#
#   optee_os/mk/config.mk:  TA_SIGN_KEY   ?= keys/default_ta.pem
#                           TA_PUBLIC_KEY ?= $(TA_SIGN_KEY)
#   optee_os/core/crypto/signed_hdr.c:  shdr_verify_signature() checks each TA
#                           against `ta_pub_key`, which is COMPILED INTO the
#                           OP-TEE core image at build time.
#
# So whoever builds the secure world chooses the key that admits TAs. Build
# OP-TEE with TA_PUBLIC_KEY=ours and only our TAs load. That is the whole of it.
#
# The script signs the anchor TA twice -- once with OP-TEE's default key, once
# with ours -- and cross-verifies both against both keys. The diagonal is the
# positive control: if it does not say ACCEPTED, the test itself is broken and
# the off-diagonal REJECTEDs mean nothing.
#
# Usage:
#   TA_DEV_KIT_DIR=<optee_os>/out/arm-plat-vexpress/export-ta_arm64 \
#     ./prove-signing-authority.sh
#
# What this does NOT prove: that we can run our OP-TEE build on any particular
# SILICON. That is the separate question of who owns the boot-chain root of
# trust -- fused by the OEM on a phone, but customer-programmable on SoCs that
# expose their own key fuses. See SIGNING.md.

set -u
DK="${TA_DEV_KIT_DIR:-}"
[ -n "$DK" ] && [ -d "$DK/scripts" ] || { echo "set TA_DEV_KIT_DIR to an OP-TEE export-ta_arm64 dir" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
SIGN="$DK/scripts/sign_encrypt.py"
UUID=6e3f9c52-8d41-4c07-9ab2-5ed01a847c33
ELF="$HERE/ta/$UUID.stripped.elf"
[ -f "$ELF" ] || { echo "build the TA first (make -C ta)" >&2; exit 2; }

OURS="$HERE/keys/enclave_ta.pem"
mkdir -p "$HERE/keys"
[ -f "$OURS" ] || openssl genrsa -out "$OURS" 4096 2>/dev/null
DEFAULT="$(dirname "$(dirname "$DK")")/../../keys/default_ta.pem"
[ -f "$DEFAULT" ] || DEFAULT="$(find "$DK/../../.." -name default_ta.pem 2>/dev/null | head -1)"
[ -f "$DEFAULT" ] || { echo "could not locate OP-TEE's default_ta.pem" >&2; exit 2; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 "$SIGN" sign-enc --key "$DEFAULT" --uuid $UUID --in "$ELF" --out "$TMP/theirs.ta" >/dev/null 2>&1
python3 "$SIGN" sign-enc --key "$OURS"    --uuid $UUID --in "$ELF" --out "$TMP/ours.ta"   >/dev/null 2>&1

printf '\n  %-22s %s\n' "our key SHA-256:" "$(openssl rsa -in "$OURS" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
printf '  %-22s %s\n\n' "OP-TEE default:" "$(openssl rsa -in "$DEFAULT" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"

fail=0
for ta in theirs ours; do
  for pair in "$DEFAULT:OP-TEE-default" "$OURS:OUR-key"; do
    key="${pair%%:*}"; name="${pair##*:}"
    if python3 "$SIGN" verify --uuid $UUID --key "$key" --in "$TMP/$ta.ta" >/dev/null 2>&1; then
      verdict=ACCEPTED; else verdict=REJECTED; fi
    printf '  TA signed by %-16s verified against %-16s -> %s\n' "$ta" "$name" "$verdict"
    # diagonal must accept, off-diagonal must reject
    want=REJECTED
    { [ "$ta" = theirs ] && [ "$name" = OP-TEE-default ]; } && want=ACCEPTED
    { [ "$ta" = ours ]   && [ "$name" = OUR-key ]; }        && want=ACCEPTED
    [ "$verdict" = "$want" ] || { echo "      ^ expected $want -- TEST BROKEN"; fail=1; }
  done
done

echo
if [ $fail -eq 0 ]; then
  echo "  PASS: a TA is bound to the key that signed it, and we hold that key."
  echo "        Build OP-TEE with TA_PUBLIC_KEY=keys/enclave_ta.pem and only our"
  echo "        TAs load. No vendor signs anything."
else
  echo "  FAIL: controls did not behave as expected; ignore the matrix above."
fi
exit $fail
