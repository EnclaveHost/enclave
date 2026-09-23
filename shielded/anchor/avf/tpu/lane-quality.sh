#!/usr/bin/env bash
# lane-quality.sh <out_dir> <tag> -- the 24-prompt contract set through lane-run2.sh, one fresh VM per prompt, as qc7 did.
#
# Each row is a complete, fail-closed lane-run2 run (its exit status is recorded, never assumed), labelled <tag>-NN, with
# GRAPHS/BUNDLE/BUNDLE_SHA256/MAXNEW/EXTRA passed through. MANIFEST.tsv declares expect_rows BEFORE the first run, so a batch
# cut short scores as missing rows, not as a smaller denominator. Score with lane-score.py.
#   GRAPHS=tpu/g5-h4ds-w4 BUNDLE=tpu/lanes-h4ds-w4.etpu BUNDLE_SHA256=cd56... MAXNEW=256 ./lane-quality.sh ../results/qw4 qw4
set -uo pipefail
OUTD="$1"; TAG="$2"; H="$(cd "$(dirname "$0")" && pwd)"; PROMPTS="${PROMPTS:-$H/../host/quality-prompts.txt}"
[[ "$TAG" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || { echo "bad tag"; exit 2; }
mkdir -p "$OUTD" || exit 2; M="$OUTD/MANIFEST.tsv"; [ -e "$M" ] && { echo "REFUSING: $M exists (one batch per directory)"; exit 2; }
# The driver and the gate it sources are FROZEN into the batch directory and only that copy runs: bash reads a script
# as it executes, and the live file being rewritten mid-batch is how results/qw4-aborted-1 was lost.
mkdir -p "$OUTD/driver/tpu" "$OUTD/driver/host" || exit 2
cp "$H/lane-run2.sh" "$OUTD/driver/tpu/lane-run2.sh" && cp "$H/../host/coolgate.sh" "$OUTD/driver/host/coolgate.sh" || exit 2
chmod 0555 "$OUTD/driver/tpu/lane-run2.sh"; DRV="$OUTD/driver/tpu/lane-run2.sh"
mapfile -t rows < <(grep -v '^#' "$PROMPTS" | grep -v '^[[:space:]]*$')
{ printf '# expect_rows\t%d\n' "${#rows[@]}"
  printf '# settings\tgraphs=%s bundle=%s bundle_sha256=%s maxnew=%s extra=%s\n' "${GRAPHS:-}" "${BUNDLE:-}" "${BUNDLE_SHA256:-}" "${MAXNEW:-}" "${EXTRA:-}"
  printf '# prompts_sha256\t%s\n' "$(sha256sum "$PROMPTS" | cut -d' ' -f1)"
  printf '# driver_sha256\t%s (frozen copy: driver/tpu/lane-run2.sh)\n' "$(sha256sum "$DRV" | cut -d' ' -f1)"
  printf '# coolgate_sha256\t%s\n' "$(sha256sum "$OUTD/driver/host/coolgate.sh" | cut -d' ' -f1)"
  printf '# id\tlabel\tstatus\trc\tprompt\texpect\n'; } > "$M"
n=0
for row in "${rows[@]}"; do
  n=$((n+1)); id=$(printf '%02d' $n); prompt="${row%%$'\t'*}"; expect="${row#*$'\t'}"; label="$TAG-$id"
  case "$prompt" in *'|'*) printf '%s\t%s\tfailed\t2\t%s\t%s\n' "$id" "$label" "$prompt" "$expect" >> "$M"; continue;; esac   # '|' would split the turn
  echo "== $label $(date +%T)"
  ASK="$prompt" OUT="$OUTD" "$DRV" "$label" > "$OUTD/$label.driver" 2>&1; rc=$?
  tail -3 "$OUTD/$label.driver"
  printf '%s\t%s\t%s\t%d\t%s\t%s\n' "$id" "$label" "$([ $rc = 0 ] && echo ok || echo failed)" "$rc" "$prompt" "$expect" >> "$M"
done
echo "LANE-QUALITY END $n rows"
