#!/bin/bash
# Compare-and-swap install of stage @LABEL@. It ADDS files and one unit; it changes no existing file, unit, service,
# firewall or provider setting, and it neither starts nor enables anything.
#   scripts/install.sh            (from the extracted stage directory, as root)
# Every target must be ABSENT on a first install (a re-run must find exactly this stage's bytes, as its receipt says).
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
(cd "$STAGE" && sha256sum --quiet --strict -c STAGE-SHA256SUMS) || die "the stage does not match STAGE-SHA256SUMS"
current=$("${NODE}" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packagesCurrent === true' "$STAGE/STAGE-INPUTS.json" 2>/dev/null || echo false)
if [ "$current" != true ] && [ "${ALLOW_TEST_STAGE:-0}" != 1 ]; then die "this is a TEST stage (its packages were not current with its tree): refusing to install"; fi
v=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || die "no node at $NODE"
[ "$v" -ge 22 ] || die "node $v at $NODE; >= 22 required"
pairs=()
for f in $(cd "$STAGE" && ls bin/*.mjs packages/* scripts/*.sh) ACTIVATION.txt STAGE-SHA256SUMS; do pairs+=("$f|$OPT/$f"); done
pairs+=("config/host-services.json|$CONFIG" "systemd/$UNIT_NAME|$UNIT" "data/bootstrap-manifest.json|$DATA/bootstrap-manifest.json")
rerun=no; [ -f "$RECEIPT" ] && rerun=yes
for p in "${pairs[@]}"; do
  src=$STAGE/${p%%|*}; dest=${p#*|}
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    [ $rerun = yes ] || die "refusing: $dest already exists and no install receipt of this stage is present"
    cmp -s "$src" "$dest" || die "refusing: $dest differs from this stage"
  fi
done
for dir in "$OPT" "$ETC" "$DATA"; do
  if [ -e "$dir" ] && [ $rerun = no ]; then die "refusing: $dir already exists"; fi
done
tmp=$(mktemp)
# parents are recorded only when THIS install creates them (a first install), so rollback removes nothing pre-existing
if [ $rerun = yes ]; then grep '^dir ' "$RECEIPT" >> "$tmp"; else
  for dir in "$(dirname "$OPT")" "$(dirname "$ETC")" "$(dirname "$DATA")" "$OPT" "$ETC" "$DATA" "$DATA/artifacts" "$DATA/policy-import"; do
    if [ ! -d "$dir" ]; then install -d -m 0755 "$dir"; echo "dir $dir" >> "$tmp"; fi
  done
fi
for p in "${pairs[@]}"; do
  src=$STAGE/${p%%|*}; dest=${p#*|}
  case "$src" in *.sh) mode=0755 ;; *) mode=0644 ;; esac
  install -d -m 0755 "$(dirname "$dest")"
  [ -e "$dest" ] || install -m "$mode" "$src" "$dest"
  echo "file $(sha256sum "$dest" | cut -d' ' -f1) $dest" >> "$tmp"
done
install -m 0644 "$tmp" "$RECEIPT"; rm -f "$tmp"
"$SYSTEMCTL" daemon-reload
cfg=$(prefixed_config)
"$NODE" "$OPT/bin/host-services-runner.mjs" check "$cfg" > "$cfg.out" || { cat "$cfg.out" >&2; rm -f "$cfg" "$cfg.out"; die "the runner refuses the installed configuration"; }
"$NODE" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!j.ok||j.warnings.length){console.error(JSON.stringify(j.warnings));process.exit(3)}' "$cfg.out" || { rm -f "$cfg" "$cfg.out"; die "the runner check reported warnings"; }
rm -f "$cfg" "$cfg.out"
echo "installed stage $LABEL ($( [ $rerun = yes ] && echo 're-run, unchanged' || echo 'first install')); receipt $RECEIPT"
echo "NOT started and NOT enabled. Next: scripts/fill-data.sh artifacts ..., scripts/fill-data.sh policy, scripts/start.sh"
