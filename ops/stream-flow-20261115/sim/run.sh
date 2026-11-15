#!/bin/sh
# run.sh <repo> <lanes: 0 = plain tunnel> <seconds> [flowsim flags...]   one simulated stream; run it inside its own
# network namespace (unshare -r -n), from the folder build.sh made. Prints the receiver's line, then the sender's.
D=$(cd "$(dirname "$0")" && pwd); repo=$1; lanes=$2; secs=$3; shift 3
ip link set lo up
"$D/flowsim" "$@" > "$D/sim.out" 2> "$D/sim.err" &
pid=$!
for i in 1 2 3 4 5 6 7 8 9 10; do grep -q ready "$D/sim.out" 2>/dev/null && break; python3 -c "import time; time.sleep(0.3)"; done
node "$D/client.mjs" "$repo" "$lanes" "$secs" 18443 ${REORDER:-80}
kill -TERM $pid; wait $pid 2>/dev/null
tail -1 "$D/sim.out"
