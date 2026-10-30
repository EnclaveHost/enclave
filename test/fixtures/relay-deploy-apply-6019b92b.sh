set -euo pipefail; dir=$1 stage=$2 unit=$3 id=$4 settle=$5 back="$1.rollback-$4"
exec 9>"$dir.deploy.lock"; flock -n 9 || { echo "another deploy holds $dir.deploy.lock" >&2; exit 1; }
mkdir -m 700 "$back"; : > "$back/.new"
while read -r _ f; do
  if [ -e "$dir/$f" ]; then mkdir -p "$back/$(dirname "$f")"; cp -a "$dir/$f" "$back/$f"; else echo "$f" >> "$back/.new"; fi
done < "$stage/.deploy-manifest"
[ ! -e "$dir/node_modules" ] || mv "$dir/node_modules" "$back/node_modules"
restore() {
  while read -r _ f; do if grep -qxF "$f" "$back/.new"; then rm -f "$dir/$f"; elif [ -e "$back/$f" ]; then cp -a "$back/$f" "$dir/$f"; fi; done < "$stage/.deploy-manifest"
  rm -rf "$dir/node_modules"; [ ! -e "$back/node_modules" ] || mv "$back/node_modules" "$dir/node_modules"
}
while read -r _ f; do mkdir -p "$dir/$(dirname "$f")"; cp "$stage/$f" "$dir/$f.deploy-tmp"; mv -f "$dir/$f.deploy-tmp" "$dir/$f"; done < "$stage/.deploy-manifest"
mv "$stage/node_modules" "$dir/node_modules"
if systemctl restart "$unit" && sleep "$settle" && systemctl is-active --quiet "$unit"; then
  echo "$unit: active"
  for old in "$dir".rollback-*; do [ "$old" = "$back" ] || rm -rf "$old"; done
  rm -rf "$stage"; exit 0
fi
echo "$unit FAILED to stay up after restart (crash loop?) — last logs:"; journalctl -u "$unit" -n 25 --no-pager || true
restore; systemctl restart "$unit" || true; sleep "$settle"
if systemctl is-active --quiet "$unit"; then echo "$unit: previous release restored and active"; else echo "$unit: previous release restored but NOT active"; fi
rm -rf "$stage"; exit 1