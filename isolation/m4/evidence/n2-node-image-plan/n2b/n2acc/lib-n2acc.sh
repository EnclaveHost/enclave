# n2acc (sourced AFTER ../e7-20260926/lib-e7.sh): N2-b's acceptance relaunch - hookbin (0ddbd824) ONLY, relaunched onto
# the SAME release 5db18199 by the owner's restart, after N2-b put the node on dist-iso-6845565a (fab9c6c7: the retry + the
# next-rev judge). It proves the node's NEW judge certifies a 5db18199 guest (seccomp unstated, listed) and measures the
# retry (5d's A1-A3). Its own state dir, seeded from e7's accepted state; e7's scripts and state are never touched.
E4=~/enclave-bench/n2acc-20260926; LOG4=$E4/n2acc.log; ST=$E4/state
KEYS4=$ST/canary-keys.txt; TSV4=$ST/canaries.tsv
NODEM=fab9c6c76aca8d7650c05d5efdddc27b4b5aa76e7d81cd5c97365458513aedcf70ffe7d2817ac3836575b34917954bb0; NODEC=6845565a9dc0df5d8b469b8f2e74699c1aaa3444
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
