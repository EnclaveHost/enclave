#!/bin/sh
# Serial, foreground suite runner: waits (bounded, 9 min) for >= 18.1 GiB MemAvailable before EACH suite, then runs it
# under systemd-run with MemoryMax (default 512M) and no swap. Usage: run-guarded.sh NAME MEM file...
W=$(cd "$(dirname "$0")" && pwd); NAME=$1; MEM=$2; shift 2
cd "$W/tree" || exit 9
node -e 'const fs=require("fs");const t0=Date.now();const av=()=>Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo","utf8"))[1])/1048576;
(function poll(){const a=av();if(a>=18.1){console.log("start MemAvailable",a.toFixed(1),"GiB");process.exit(0)}if(Date.now()-t0>540000){console.log("NOT STARTED: MemAvailable",a.toFixed(1),"GiB");process.exit(3)}setTimeout(poll,5000)})()' || exit 3
env -u GIT_DIR -u GIT_WORK_TREE timeout 1500 systemd-run --user --scope --quiet -p MemoryMax=$MEM -p MemorySwapMax=0 \
  node --import 'data:text/javascript,process.on("exit",()=>process.stderr.write("MAXRSS_KB "+process.resourceUsage().maxRSS+"\n"))' \
  --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=1200000 "$@" > "$W/logs/$NAME.log" 2>&1
code=$?
echo "EXIT $code" >> "$W/logs/$NAME.log"
grep -E "^(not )?ok|^# (tests|pass|fail)|MAXRSS|^EXIT" "$W/logs/$NAME.log"
exit $code
