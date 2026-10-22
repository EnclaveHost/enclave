#!/usr/bin/env bash
# Negative controls: each mutant breaks ONE guarantee in a scratch copy of the role; the suite must FAIL for every one.
# The original file is restored (and its sha256 re-checked) after each mutant.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/scratch
T=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/tree
L=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/logs
cd "$S"
declare -A M
M[no-tls-verifier]="s|  for (const n of names) await tlsVerify(n, keyPem, chain, roots, timeoutMs);|  void tlsVerify;|"
M[san-subset-ok]="s|sans.length !== want.length \|\| ||"
M[non-atomic-store]="s|    fsx.renameSync(tmp, path.join(dir, file));|    fsx.writeFileSync(path.join(dir, file), ''); fsx.renameSync(tmp, path.join(dir, file));|"
M[no-preorder-admit]="s|    let d; try { d = await admit(); } catch (e) { return backoff(new Error(\`platform host policy unavailable: \${e.message}\`)); }|    let d = { admit: true };|"
M[refusal-keeps-serving]="s|    ordering?.abort(); closeFronts();|    void closeFronts;|"
M[posix-acl-ignored]="s|  if (st.mode \& 0o077) fail|  if (false) fail|"
M[challenge-any-host]="s|      if (!port) return reply(sock, 421, 'Misdirected Request');|      if (!port \&\& !m[2].startsWith('/.well-known/')) return reply(sock, 421, 'Misdirected Request');|"
M[answer-any-name]="s|challenges.get(hosts\[0\])?.get(m\[2\].slice(prefix.length))|[...challenges.values()].find((x) => x.has(m[2].slice(prefix.length)))?.get(m[2].slice(prefix.length))|"
M[windows-any-sid]="s|  if (extra.length) fail|  if (false) fail|"
M[failed-renewal-drops-cert]="s|  const backoff = (e) => {|  const backoff = (e) => { current = null;|"
F=network/host-services/service-tls.mjs
orig=$(sha256sum "$T/$F" | cut -d' ' -f1)
fails=0
for k in "${!M[@]}"; do
  cp "$T/$F" "$F"
  sed -i "${M[$k]}" "$F"
  if cmp -s "$T/$F" "$F"; then echo "MUTANT $k: sed did not apply"; fails=$((fails+1)); continue; fi
  SERVICE_TLS_TMP=$L node --test --test-timeout=120000 test/service-tls.test.mjs > "$L/mutant-$k.out" 2>&1
  rc=$?
  n=$(grep -c '^not ok' "$L/mutant-$k.out")
  if [ "$rc" -ne 0 ] && [ "$n" -gt 0 ]; then echo "MUTANT $k: KILLED ($n failing top-level tests)"; else echo "MUTANT $k: SURVIVED"; fails=$((fails+1)); fi
done
cp "$T/$F" "$F"
[ "$(sha256sum "$F" | cut -d' ' -f1)" = "$orig" ] || { echo "restore failed"; exit 3; }
echo "survivors/unapplied: $fails"
exit $fails
