#!/usr/bin/env bash
# Local (Linux) checks of the E2 repair; no PowerShell, no sandbox here.
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/native-e2-repair-20261021; cd "$D/fixed"
SRC=$(cat probe.mjs)
P='process.stdout.write(JSON.stringify(process.argv.slice(1)))'
echo "1a self-check WITHOUT --: $(timeout 20 node -e "$P" --input-type=module --eval 'console.log(1)' probe.mjs 18001 18002 2>&1 | head -c 200)"
echo "1b self-check WITH --   : $(timeout 20 node -e "$P" -- --input-type=module --eval 'x' probe.mjs 18001 18002 2>&1 | head -c 200)"
echo "2a eval argv mapping    : $(timeout 20 node --input-type=module --eval 'console.log(JSON.stringify(process.argv.slice(1)))' probe.mjs 18001 18002 2>&1)"
G=$((20000 + RANDOM % 10000)); O=$((G + 1))
node listener.mjs $G $O > /tmp/e2-listener.$$ 2>&1 & L=$!; sleep 1
echo "2b real probe via --eval: $(timeout 30 node --input-type=module --eval "$SRC" probe.mjs $G $O 2>&1)"
kill $L 2>/dev/null; wait $L 2>/dev/null; echo "   listener saw: $(grep -c '"type":"tcp"' /tmp/e2-listener.$$) tcp, $(grep -c '"type":"udp"' /tmp/e2-listener.$$) udp (no firewall here: all three succeed locally)"; rm -f /tmp/e2-listener.$$
python3 "$D/escape-roundtrip.py"
