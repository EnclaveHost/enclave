#!/bin/bash
# Each mutant removes one rule from lib/maintenance.mjs; the plan + protocol suites must FAIL on every one.
set -u
here=$(cd "$(dirname "$0")/.." && pwd); killed=0; total=0
mutant() {
  total=$((total+1)); local m; m=$(mktemp -d); cp -r "$here/lib" "$here/test" "$here/vendor" "$here/package.json" "$m/" 2>/dev/null; ln -s "$here/node_modules" "$m/node_modules"
  perl -0pi -e "$2" "$m/lib/maintenance.mjs"
  if cmp -s "$here/lib/maintenance.mjs" "$m/lib/maintenance.mjs"; then echo "MUTANT NOT APPLIED: $1"; rm -rf "$m"; return; fi
  if (cd "$m" && timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit test/plan.test.mjs test/protocol.test.mjs >/dev/null 2>&1); then echo "SURVIVED: $1"; else echo "killed: $1"; killed=$((killed+1)); fi
  rm -rf "$m"
}
mutant "B uses nonce N (not N+1)"          's/nonce: Number\(n \+ 1n\)/nonce: Number(n)/'
mutant "chain id 0 allowed"                's/if \(cfg\.chainId === 0 \|\| /if (/'
mutant "aggregate fee cap not enforced"    's/if \(total > cfg\.feeCapWei\) refuse/if (false) refuse/'
mutant "operator code not checked"         's/if \(lc\(f\.operatorCode\) !== designatorOf\(cfg\.executor\)\) refuse/if (false) refuse/'
mutant "sponsor code not checked"          's/if \(lc\(f\.sponsorCode\) !== "0x"\) refuse/if (false) refuse/'
mutant "unsettled nonce accepted"          's/if \(!\(n\.atBlock === n\.latest && n\.latest === n\.pending\)\) refuse/if (false) refuse/'
mutant "sponsored Lease deadline ignored"  's/if \(!\(blockTs > q\.lastSponsoredLeaseDeadline \+ cfg\.quiesce\.deadlineMarginSec\)\) refuse/if (false) refuse/'
mutant "lease window ignored"              's/if \(remaining < cfg\.quiesce\.minLeaseRemainingSec\) refuse/if (false) refuse/'
mutant "L1 sized from the unsigned bytes"  's/const argument = Math\.max\(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE\);/const argument = unsigned - 80;/'
mutant "restore target is another address" 's/address: lc\(cfg\.executor\), nonce: Number/address: lc(cfg.reserve), nonce: Number/'
mutant "sponsor balance not checked"       's/if \(BigInt\(f\.sponsorBalance\) < cfg\.valueWei \+ total\) refuse/if (false) refuse/'
echo "MUTANTS killed $killed/$total"
[ "$killed" = "$total" ]
