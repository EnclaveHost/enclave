#!/usr/bin/env bash
# build-identity.sh <out-file> -- tie a result to the binary the DEVICE actually ran, or say plainly that it could not.
#
# The previous attempt did this:
#       adb shell "cat $APKPATH" | unzip -p /dev/stdin lib/.../libggml-tpu.so 2>/dev/null | sha256sum
# and recorded e3b0c44298fc1c149afbf4c8996fb924 -- the SHA256 of ZERO BYTES. unzip cannot read a
# non-seekable stream for a member extraction, its error was discarded by 2>/dev/null, no exit status was
# checked anywhere in the pipeline, and sha256sum hashed the empty result without complaint. The manifest
# then presented that as the installed identity, which is worse than recording nothing.
#
# So every step here is checked, the APK is pulled to a real seekable file, the member's length must be
# non-zero, hashes are FULL, and any failure is written into the manifest as a FAILED line instead of a
# digest. Existing manifests are never overwritten; a failed one is kept beside the new attempt.
set -uo pipefail
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
PKG="${PKG:-host.enclave.anchor.avf}"
MEMBER="${MEMBER:-lib/arm64-v8a/libggml-tpu.so}"
OUTF="${1:?usage: build-identity.sh <out-file>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say() { printf '%s\n' "$*" >> "$OUTF"; }

[ -e "$OUTF" ] && { n=1; while [ -e "$OUTF.prev.$n" ]; do n=$((n+1)); done; cp -p "$OUTF" "$OUTF.prev.$n"
                    echo "kept the previous manifest as $(basename "$OUTF").prev.$n"; }
: > "$OUTF"
say "# binary identity, $(date -Is). Every line below is either a FULL digest or a FAILED explanation."

APKPATH=$("$ADB" shell pm path "$PKG" 2>/dev/null | sed 's/^package://' | tr -d '\r' | head -1)
if [ -z "$APKPATH" ]; then
  say "FAILED  installed apk: pm path returned nothing for $PKG (is it installed? is the device attached?)"
else
  say "installed apk path      $APKPATH"
  if ! "$ADB" pull "$APKPATH" "$TMP/base.apk" >/dev/null 2>"$TMP/pull.err"; then
    say "FAILED  adb pull: $(tr -d '\r' < "$TMP/pull.err" | tail -1)"
  elif [ ! -s "$TMP/base.apk" ]; then
    say "FAILED  adb pull produced an empty file"
  else
    say "installed apk bytes     $(stat -c %s "$TMP/base.apk")"
    say "installed apk sha256    $(sha256sum "$TMP/base.apk" | cut -d' ' -f1)"
    # the member must be LISTED with a non-zero length before it is extracted
    LEN=$(unzip -l "$TMP/base.apk" "$MEMBER" 2>/dev/null | awk -v m="$MEMBER" '$4==m{print $1}' | head -1)
    if [ -z "$LEN" ]; then
      say "FAILED  $MEMBER is not present in the installed apk"
    elif [ "$LEN" -eq 0 ] 2>/dev/null; then
      say "FAILED  $MEMBER is listed at zero length in the installed apk"
    else
      if ! unzip -p "$TMP/base.apk" "$MEMBER" > "$TMP/member" 2>"$TMP/unzip.err"; then
        say "FAILED  extracting $MEMBER: $(tail -1 "$TMP/unzip.err")"
      else
        GOT=$(stat -c %s "$TMP/member")
        if [ "$GOT" -eq 0 ]; then
          say "FAILED  extracting $MEMBER produced zero bytes (listed length was $LEN)"
        elif [ "$GOT" != "$LEN" ]; then
          say "FAILED  $MEMBER extracted $GOT bytes, the directory says $LEN"
        else
          say "$(basename "$MEMBER") bytes   $GOT  (matches the zip directory)"
          say "$(basename "$MEMBER") sha256  $(sha256sum "$TMP/member" | cut -d' ' -f1)  <- THE BINARY THAT RAN"
        fi
      fi
    fi
  fi
fi

# the local build, for comparison only: it is evidence of what was BUILT, never of what ran
L="$HERE/../out/anchor.apk"
if [ -f "$L" ]; then
  say "local apk sha256        $(sha256sum "$L" | cut -d' ' -f1)  (built here; only matters if it matches above)"
  if unzip -p "$L" "$MEMBER" > "$TMP/lmember" 2>/dev/null && [ -s "$TMP/lmember" ]; then
    say "$(basename "$MEMBER") sha256  $(sha256sum "$TMP/lmember" | cut -d' ' -f1)  (from the LOCAL apk)"
  else
    say "FAILED  could not extract $MEMBER from the local apk"
  fi
else
  say "FAILED  no local $L to compare against"
fi

say "compiled switches, read from the source that was current at this moment:"
grep -n 'kRepairClips\|kVerifyKernel\|kInjectFault' "$HERE/../payload/ggml-tpu.cpp" | grep constexpr | sed 's/^/  /' >> "$OUTF"
say "(the AUTHORITY on what was compiled is the payload's own \"build config\" line in each run's log;"
say " the source lines above can differ from the binary and that is exactly the trap this guards.)"
grep -q '<- THE BINARY THAT RAN' "$OUTF" || { echo "build-identity: FAILED to establish the installed binary" >&2; exit 1; }
