#!/usr/bin/env bash
# Mutation controls (queue 256): each mutant is a copy of tools/ + test/ under ./mut-<name>, changed by one sed; its tests MUST fail.
#   dir-tsize   adapter-model buildDir Tsize without its own block (a dag-size bug): the real-release CID test must fail
#   car-ignored hold-site verify swallows a failed complete-CAR fetch: the fault test must fail
set -uo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); mkdir -p "$P/tmp"; export TMPDIR="$P/tmp"; rc=0
run() { local name="$1" file="$2" from="$3" to="$4" test="$5" M="$P/mut-$1"
  rm -rf "$M"; mkdir -p "$M"; cp -r "$P/tools" "$P/test" "$M/"
  python3 - "$M/$file" "$from" "$to" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read(); assert s.count(a)==1,(p,a); open(p,'w').write(s.replace(a,b))
PY
  if (cd "$M" && node --test --test-concurrency=1 --test-name-pattern="$6" "$test" > "$P/logs/mutant-$name.out" 2>&1); then echo "MUTANT $name SURVIVED"; rc=1; else echo "mutant $name killed"; fi
  rm -rf "$M"; }
run dir-tsize tools/adapter-model.mjs 'tsize: links.reduce((s, l) => s + l.tsize, 0) + block.length' 'tsize: links.reduce((s, l) => s + l.tsize, 0)' test/a-model-release.test.mjs '^884 files'
run car-ignored tools/hold-site.mjs '} catch (e) { fail.push(`complete CAR from the adapter: ${String(e.message).slice(0, 200)}`); }' '} catch (e) { void e; }' test/b-client.test.mjs '^(plan|faults)'
rmdir "$P/tmp" 2>/dev/null || true; echo "mutants rc=$rc"; exit $rc
