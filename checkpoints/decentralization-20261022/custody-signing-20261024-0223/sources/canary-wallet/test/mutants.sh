#!/bin/bash
# Each mutant removes one guard; the server-level suite must FAIL on every one. Scratch copies under $TMPDIR.
set -u
here=$(cd "$(dirname "$0")/.." && pwd); killed=0; total=0
mutant() {   # mutant "<label>" <file> <perl substitution>
  total=$((total+1)); local m; m=$(mktemp -d); cp -r "$here"/*.mjs "$here"/*.js "$here"/*.html "$here"/*.css "$here/vendor" "$here/test" "$here/evidence" "$m/"; ln -s "$here/node_modules" "$m/node_modules"
  perl -0pi -e "$3" "$m/$2"
  if cmp -s "$here/$2" "$m/$2"; then echo "MUTANT NOT APPLIED: $1"; rm -rf "$m"; return; fi
  if (cd "$m" && timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit test/handoff.test.mjs >/dev/null 2>&1); then echo "SURVIVED: $1"; else echo "killed: $1"; killed=$((killed+1)); fi
  rm -rf "$m"
}
mutant "upload signer not checked"           upload.mjs        's/if \(signer !== lc\(trust\.uploadSigner \?\? trust\.admin\)\) throw/if (false) throw/'
mutant "gateway CID not compared"            upload.mjs        's/if \(cid !== C\.cid\) \{/if (false) {/'
mutant "fetched bytes not hashed"            upload.mjs        's/if \(b\.length !== C\.size \|\| sha256\(b\) !== C\.sha256 \|\| rawCid\(b\) !== C\.cid\) throw/if (false) throw/'
mutant "publish not gated on storage"        upload.mjs        's/if \(state\.status !== "stored-verified"\) return `the component/if (false) return `the component/'
mutant "gate trusts the journal (no re-fetch)" upload.mjs      's/try \{ await fetchBack\(\); return null; \}/try { return null; }/'
mutant "crash in uploading forgotten"        upload.mjs        's/if \(state\.status === "uploading"\) \{/if (false) {/'
mutant "unknown upload re-authorizable"      upload.mjs        's/if \(state\.status !== "ready" && !expired\) throw/if (false) throw/'
mutant "any wallet error resets the upload"  upload.mjs        's/state\.status !== "authorizing" \|\| b\.code !== 4001/state.status !== "authorizing"/'
mutant "changed file uploaded"               upload.mjs        's/if \(sha256\(bytes\) !== c\.sha256\) throw/if (false) throw/'
mutant "transport gate dropped"              handoff-server.mjs 's/const blocked=await gate\(\);\n   if\(blocked\)return reply\(res,409,\{error:blocked\}\);//'
mutant "reconcile ignores the minimum age"   publish-stage.mjs 's/if \(!\(age >= trust\.reconcileMinAgeMs\)\) return/if (false) return/'
mutant "reconcile resets a published attempt" publish-stage.mjs 's/if \(latest > nonce && versions > 0n\) return \{ reset: false, published: true,/if (latest > nonce \&\& versions > 0n) return { reset: true, published: true,/'
mutant "reconcile ignores a pending tx"      publish-stage.mjs 's/if \(pending !== latest\) return \{ reset: false/if (false) return { reset: false/'
mutant "raised fee accepted"                 publish-stage.mjs 's/if \(BigInt\(tx\.maxFeePerGas\) > BigInt\(w\.maxFeePerGas\)\) throw/if (false) throw/'
mutant "stored version not read back"        publish-stage.mjs 's/throw Error\("the stored version differs from the request"\);/void 0;/' 
mutant "relay error body kept"               upload.mjs        's/refuseBeforeGateway\(`the relay refused the authorization \(HTTP \$\{r\.status\}\)`\)/refuseBeforeGateway(`the relay refused the authorization (HTTP \${r.status}) \${body}`)/'
mutant "gateway error body kept"             upload.mjs        's/lastError: `the gateway refused the upload \(HTTP \$\{r\.status\}\)`/lastError: `the gateway refused the upload (HTTP \${r.status}) \${body}`/'
mutant "non-CID gateway answer stored"       upload.mjs        's/typeof cid === "string" && CID_SHAPE\.test\(cid\) \? cid : "\(an answer that is not a CID\)"/String(cid)/'
mutant "recovery error echoed"               upload.mjs        's/catch \{ throw Error\("the signature could not be recovered; nothing was uploaded"\); \}/catch (e) { throw Error(String(e.message) + " " + sig); }/'
mutant "failed fetch resets an unknown upload" upload.mjs      's/set\(\{ \.\.\.state, lastError: state\.status === "upload-unknown" \? why : e\.message, checkedAt/set({ ...state, status: state.status === "upload-unknown" ? "ready" : state.status, lastError: state.status === "upload-unknown" ? why : e.message, checkedAt/'
mutant "same-bytes retry without confirmation" upload.mjs      's/if \(b\.confirm !== "retry-same-bytes"\) throw/if (false) throw/'
echo "MUTANTS killed $killed/$total"
[ "$killed" = "$total" ]
