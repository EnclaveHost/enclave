#!/bin/bash
# Each mutant removes one safety check from lib/publish.mjs; the suite must FAIL on every one. Scratch copy in out/.
set -u
here=$(cd "$(dirname "$0")/.." && pwd); m=$(cd "$here/.." && pwd)/out/publish-mutant; killed=0; total=0
mutant() {
  total=$((total+1)); rm -rf "$m"; mkdir -p "$m"; cp -r "$here/lib" "$here/test" "$here/fixtures" "$here/package.json" "$m/"; ln -s "$here/node_modules" "$m/node_modules"
  mkdir -p "$m/../out-link"; perl -0pi -e "$2" "$m/lib/publish.mjs"
  if cmp -s "$here/lib/publish.mjs" "$m/lib/publish.mjs"; then echo "MUTANT NOT APPLIED: $1"; return; fi
  sed -i 's|new URL("../../out/custody_canary_proof.wasm", import.meta.url)|new URL("file://'"$(cd "$here/.." && pwd)"'/out/custody_canary_proof.wasm")|' "$m/test/publish.test.mjs"
  if (cd "$m" && node --test --test-concurrency=1 test/pacing.test.mjs test/publish.test.mjs >/dev/null 2>&1); then echo "SURVIVED: $1"; else echo "killed: $1"; killed=$((killed+1)); fi
}
mutant "catalog owner not checked"          's/if \(owner !== cfg\.publisher\) refuse/if (false) refuse/'
mutant "pending handoff ignored"            's/if \(pending !== ZERO\) refuse/if (false) refuse/'
mutant "existing listing accepted"          's/if \(versions !== 0n\) refuse/if (false) refuse/'
mutant "listed CID accepted"                's/if \(cs\[0\]\) refuse/if (false) refuse/'
mutant "book appCatalog not checked"        's/if \(bookCatalog !== cfg\.catalog\) refuse/if (false) refuse/'
mutant "catalog code hash not checked"      's/if \(await codeHash\(cfg\.catalog, "catalog"\) !== cfg\.catalogCodeHash\) refuse/if (false) refuse/'
mutant "ledger code hash not checked"       's/if \(await codeHash\(cfg\.ledger, "ledger", ledgerCodeHashOf\) !== cfg\.ledgerCodeHash\) refuse/if (false) refuse/'
mutant "operator fee left out of the total" 's/const l2 = gas \* maxFeePerGas, total = l2 \+ l1 \+ operatorFee;/const l2 = gas * maxFeePerGas, total = l2 + l1;/'
mutant "not-Isthmus treated as zero fee"    's/if \(isthmus !== true\) refuse\([^;]*\);/if (isthmus !== true) operatorFee = 0n;/'
mutant "L1 sized from the unsigned tx only" 's/argument: Math\.max\(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE\)/argument: unsigned - 10/'
mutant "first RPC trusted alone"            's/if \(JSON\.stringify\(r\[0\]\) !== JSON\.stringify\(r\[1\]\)\) refuse/if (false) refuse/'
mutant "unsettled nonce accepted"           's/if \(\[\.\.\.nl, \.\.\.np\]\.some\(\(x\) => x !== nonceAt\)\) refuse/if (false) refuse/'
mutant "fee cap not enforced"               's/if \(maxFeePerGas > cfg\.caps\.maxFeePerGas\) refuse/if (false) refuse/'
mutant "wrong chain accepted"               's/if \(ids\.some\(\(x\) => Number\(x\) !== cfg\.chainId\)\) refuse/if (false) refuse/'
mutant "non-429 errors retried too"          's/if \(e instanceof Refusal \|\| e\?\.status !== 429\) throw e;/if (e instanceof Refusal) throw e;/'
mutant "no per-provider pacing"             's/next\.set\(url, slot \+ pacing\.minIntervalMs\);/next.set(url, slot);/'
mutant "unbounded 429 retries"              's/if \(attempt >= pacing\.max429Retries\) refuse/if (false) refuse/'
mutant "Retry-After cap ignored"            's/if \(ra !== null && ra > pacing\.retryAfterCapMs\) refuse/if (false) refuse/'
mutant "Retry-After ignored (backoff only)" 's/clock\.now\(\) \+ \(ra \?\? pacing\.backoffMs\[attempt\]\)/clock.now() + pacing.backoffMs[attempt]/'
mutant "request budget unchecked"           's/if \(stats\.requests >= pacing\.maxRequests\) refuse/if (false) refuse/'
mutant "time budget unchecked"              's/if \(at > deadline\) refuse/if (false) refuse/'
mutant "stale block accepted"               's/if \(age > pacing\.freshnessMs\) refuse/if (false) refuse/'
mutant "budget may exceed freshness"        's/if \(p\.timeBudgetMs > p\.freshnessMs\) throw/if (false) throw/'
echo "MUTANTS killed $killed/$total"
[ "$killed" = "$total" ]
