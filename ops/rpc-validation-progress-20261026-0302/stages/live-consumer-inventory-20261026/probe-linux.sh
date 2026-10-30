# READ-ONLY probe (whitelisted output only): no env, no full argv, no files' contents except hashes
echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
ss -ltnpH 2>/dev/null | awk '{print "listen", $4, $6}' | sed -E 's/,fd=[0-9]+//g' | grep -E ':(443|80|8188|8080|3000|8443|9600|28590|8545) ' | sort -u
systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print "unit", $1}' | grep -iE 'enclave|relay|api|front|caddy|nginx|haproxy|route|provider|directory|custod|mcp|node|tuna|gateway'
for p in $(pgrep -x node; pgrep -x nodejs; pgrep -f '^/[^ ]*/node ' ); do
  [ -r /proc/$p/cmdline ] || continue
  exe=$(readlink /proc/$p/exe 2>/dev/null); cwd=$(readlink /proc/$p/cwd 2>/dev/null)
  scr=$(tr '\0' '\n' < /proc/$p/cmdline | grep -m1 -E '^/[^ =]*\.(m?js|cjs)$')
  unit=$(grep -oE '[^/]+\.service' /proc/$p/cgroup 2>/dev/null | head -1)
  h=""; [ -n "$scr" ] && h=$(sha256sum "$scr" 2>/dev/null | cut -c1-16)
  echo "node pid=$p unit=${unit:-?} exe=$exe script=${scr:-?} cwd=$cwd sha16=${h:-unreadable}"
done | sort -u
