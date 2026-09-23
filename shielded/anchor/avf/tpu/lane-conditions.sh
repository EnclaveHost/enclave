#!/usr/bin/env bash
# lane-conditions.sh <out_dir> <conditions.tsv> -- one prompt, several lane conditions, each a fail-closed lane-run2 run.
#
# conditions.tsv: one run per line, in the order given (write ABBA orders yourself so drift lands on every condition):
#     <label> <TAB> <condition name> <TAB> <EXTRA for am start, may be empty> [<TAB> <APK to install first>]
# With the fourth column the APK is installed (-r, app data kept) before the run and the file the package manager then
# points at is hashed ON THE DEVICE; a failed install or a hash that is not the local file's fails that run without
# starting it, so a comparison between builds can interleave them (ABBA) and every row names the build it measured.
# GRAPHS, BUNDLE, BUNDLE_SHA256, MAXNEW and ASK come from the environment and are the same for every run. As in
# lane-quality.sh the driver, its gate and its CPU tools are frozen into <out_dir> and only that copy runs; RUNS.tsv
# records each run's exit status, never assumed. Each run's stdin is /dev/null: the first version of this script ran ONE
# of eight conditions, because the driver's adb calls read the rest of the conditions file from the shared stdin.
set -uo pipefail
OUTD="$1"; CONDS="$2"; H="$(cd "$(dirname "$0")" && pwd)"
[ -n "${ASK:-}" ] || { echo "ASK is required"; exit 2; }
mkdir -p "$OUTD" || exit 2; R="$OUTD/RUNS.tsv"; [ -e "$R" ] && { echo "REFUSING: $R exists"; exit 2; }
mkdir -p "$OUTD/driver/tpu" "$OUTD/driver/host" || exit 2
cp "$H/lane-run2.sh" "$H/cpu-sampler.sh" "$H/cpu-window.py" "$OUTD/driver/tpu/" && cp "$H/../host/coolgate.sh" "$OUTD/driver/host/coolgate.sh" && cp "$CONDS" "$OUTD/conditions.tsv" || exit 2
chmod 0555 "$OUTD/driver/tpu/lane-run2.sh"; DRV="$OUTD/driver/tpu/lane-run2.sh"
{ printf '# settings\tgraphs=%s bundle=%s bundle_sha256=%s maxnew=%s\n' "${GRAPHS:-}" "${BUNDLE:-}" "${BUNDLE_SHA256:-}" "${MAXNEW:-}"
  printf '# ask\t%s\n' "$ASK"
  printf '# driver_sha256\t%s\n' "$(sha256sum "$DRV" | cut -d' ' -f1)"
  printf '# label\tcondition\textra\tstatus\trc\tapk_sha256\n'; } > "$R"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; PKG="${PKG:-host.enclave.anchor.avf}"
# install_apk <apk>: prints the installed sha256 on success; nothing (and non-zero) on any failure
install_apk() { local want got path
  want=$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1) && [ -n "$want" ] || return 1
  "$ADB" install -r "$1" </dev/null >/dev/null 2>&1 || return 1
  path=$("$ADB" shell pm path "$PKG" </dev/null 2>/dev/null | tr -d '\r' | sed -n 's/^package://p' | head -1); [ -n "$path" ] || return 1
  got=$("$ADB" shell sha256sum "$path" </dev/null 2>/dev/null | tr -d '\r' | cut -d' ' -f1)
  [ "$got" = "$want" ] || return 1; echo "$got"; }
# Fields are split by hand: `IFS=$'\t' read` treats TAB as whitespace and COLLAPSES empty fields, so an empty EXTRA
# followed by an APK moved the APK path into EXTRA (handed to am start, and nothing installed).
while IFS= read -r line; do
  f=(); r="$line"$'\t'; while [[ $r == *$'\t'* ]]; do f+=("${r%%$'\t'*}"); r=${r#*$'\t'}; done
  label=${f[0]:-}; cond=${f[1]:-}; extra=${f[2]:-}; apk=${f[3]:-}
  [ -z "$label" ] || [ "${label:0:1}" = "#" ] && continue
  echo "== $label ($cond) $(date +%T)"
  asha=-
  if [ -n "${apk:-}" ]; then
    asha=$(install_apk "$apk") || { echo "INSTALL FAILED or hash mismatch: $apk"; printf '%s\t%s\t%s\t%s\t%d\t%s\n' "$label" "$cond" "$extra" failed 97 "install:$apk" >> "$R"; continue; }
  fi
  EXTRA="$extra" OUT="$OUTD" "$DRV" "$label" > "$OUTD/$label.driver" 2>&1 </dev/null; rc=$?   # </dev/null: adb shell reads stdin, and ate the rest of the list
  tail -4 "$OUTD/$label.driver"
  printf '%s\t%s\t%s\t%s\t%d\t%s\n' "$label" "$cond" "$extra" "$([ $rc = 0 ] && echo ok || echo failed)" "$rc" "$asha" >> "$R"
done < "$OUTD/conditions.tsv"
echo "LANE-CONDITIONS END"
