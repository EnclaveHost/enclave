#!/bin/bash
# Mutation check of the retention fix (isolated copies only). Each mutant = tree/relay/certs.js with ONE change reverted
# or broken; the suite must FAIL for each. Then the unmutated tree must pass.
set -u
cd "$(dirname "$0")"
run() { (cd "$1" && timeout 420 node --test test/certs.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok" | head -8); }
mk() { rm -rf mut; mkdir -p mut; cp -r tree/relay tree/test tree/package.json mut/; ln -sfn ../../enclave/node_modules mut/node_modules; python3 - "$1" "$2" <<'PY'
import sys; p='mut/relay/certs.js'; s=open(p).read(); a,b=sys.argv[1],sys.argv[2]
assert s.count(a)>=1,a; s=s.replace(a,b,1); open(p,'w').write(s)
PY
}
declare -a A B N
N+=("M1 issue: uncertain not kept");   A+=("    else if (uncertain(e)) { keep = true; keptPending(e); }
    throw e;
  } finally {
    if (!keep) { dropOrder(key); txtCleanup(rec); }
  }
}
// Resume"); B+=("    throw e;
  } finally {
    if (!keep) { dropOrder(key); txtCleanup(rec); }
  }
}
// Resume")
N+=("M2 resume: uncertain not kept");  A+=("  const csrDer = Buffer.from(rec.csrDer, \"base64url\");"); B+=("  const csrDer = Buffer.from(rec.csrDer, \"base64url\"); const uncertain = () => false;")
N+=("M3 kept order does not cool CA"); A+=("const keptCooling = (ca, name, e) => {
  ca.downUntil = Date.now() + CA_COOLDOWN_MS;"); B+=("const keptCooling = (ca, name, e) => {")
N+=("M4 no CSR/key match check");      A+=("  if (spki !== String(key)"); B+=("  if (false && spki !== String(key)")
N+=("M5 deadline counted uncertain");  A+=("e?.caLevel === true && !e.deadline &&"); B+=("e?.caLevel === true &&")
N+=("M6 4xx counted uncertain");       A+=(" && !(e.status >= 400 && e.status < 500)"); B+=("")
N+=("M7 never persisted");             A+=("    store.data.orders[key] = rec; store.saveSoon();
    if (rec.txtName) {"); B+=("    if (rec.txtName) {")
for i in "${!N[@]}"; do mk "${A[$i]}" "${B[$i]}"; echo "== ${N[$i]}"; run mut; done
# M8: the OLD placement - persisted only once finalize answered (the base's rule), everything else of the fix kept
mk "const env = (k)" "const env = (k)"; python3 - <<'PY'
p='mut/relay/certs.js'; s=open(p).read()
persist="    store.data.orders[key] = rec; store.saveSoon();\n"
fin="    await acmePost(ca, rec.finalizeUrl, { csr: b64u(csrDer) }, { acct });\n"
assert s.count(persist)==1 and s.count(fin)==1
s=s.replace(persist,"",1).replace(fin,fin+persist,1); open(p,'w').write(s)
PY
echo "== M8 persisted only after finalize answered (old placement)"; run mut
echo "== UNMUTATED tree"; run tree
rm -rf mut
