#!/usr/bin/env bash
# lane-conditions.sh <out_dir> <conditions.tsv> -- one prompt, several lane conditions, each a fail-closed lane-run2 run.
#
# conditions.tsv: one run per line, in the order given (write ABBA orders yourself so drift lands on every condition):
#     <label> <TAB> <condition name> <TAB> <EXTRA for am start, may be empty>
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
  printf '# label\tcondition\textra\tstatus\trc\n'; } > "$R"
while IFS=$'\t' read -r label cond extra; do
  [ -z "$label" ] || [ "${label:0:1}" = "#" ] && continue
  echo "== $label ($cond) $(date +%T)"
  EXTRA="$extra" OUT="$OUTD" "$DRV" "$label" > "$OUTD/$label.driver" 2>&1 </dev/null; rc=$?   # </dev/null: adb shell reads stdin, and ate the rest of the list
  tail -4 "$OUTD/$label.driver"
  printf '%s\t%s\t%s\t%s\t%d\n' "$label" "$cond" "$extra" "$([ $rc = 0 ] && echo ok || echo failed)" "$rc" >> "$R"
done < "$OUTD/conditions.tsv"
echo "LANE-CONDITIONS END"
