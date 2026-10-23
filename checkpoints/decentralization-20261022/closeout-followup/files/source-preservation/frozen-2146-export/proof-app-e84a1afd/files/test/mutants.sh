#!/bin/bash
# Each mutant breaks one property; the unit tests must FAIL on every one. Runs in a scratch copy (out/mutant), host only.
set -u
here=$(cd "$(dirname "$0")/.." && pwd); m=$here/out/mutant; killed=0; total=0
mutant() {  # mutant "<label>" <perl substitution on src/proof.rs>
  total=$((total+1)); rm -rf "$m"; mkdir -p "$m"; cp -r "$here/Cargo.toml" "$here/Cargo.lock" "$here/src" "$m/"
  perl -0pi -e "$2" "$m/src/proof.rs"
  if cmp -s "$here/src/proof.rs" "$m/src/proof.rs"; then echo "MUTANT NOT APPLIED: $1"; return; fi
  if (cd "$m" && cargo test --offline --locked --target-dir "$here/target/mutant" -q >/dev/null 2>&1); then echo "SURVIVED: $1"; else echo "killed: $1"; killed=$((killed+1)); fi
}
mutant "any value under a CANARY_ name is hashed" 's/filter\(\|\(_, v\)\| is_marker\(v\)\)/filter(|(_, v)| !v.is_empty())/'
mutant "bare 64 hex accepted as a marker"         's/fn is_marker\(v: &str\) -> bool \{/fn is_marker(v: &str) -> bool { if is_hex64(v) { return true; }/'
mutant "nine names allowed"                       's/MAX_NAMES: usize = 8/MAX_NAMES: usize = 9/'
mutant "duplicates allowed"                       's/ \|\| named\.windows\(2\)\.any\(\|w\| w\[0\]\.0 == w\[1\]\.0\)//'
mutant "name not bound into the proof"            's/mac\.update\(name\.as_bytes\(\)\);//'
mutant "no domain separation"                     's/mac\.update\(DOMAIN\);//'
mutant "lowercase names accepted"                 's/b\.is_ascii_uppercase\(\) \|\| b\.is_ascii_digit\(\) \|\| b == b._.\)/b.is_ascii_alphanumeric() || b == b'"'"'_'"'"')/'
mutant "POST answered"                            's/Some\(c\) if method_is_get => c/Some(c) => c/'
mutant "uppercase challenge accepted"             's/fn is_hex64\(s: &str\) -> bool \{ s\.len\(\) == 64 && s\.bytes\(\)\.all\(\|b\| b\.is_ascii_digit\(\) \|\| \(b.a.\.\.=b.f.\)\.contains\(&b\)\)/fn is_hex64(s: &str) -> bool { s.len() == 64 \&\& s.bytes().all(|b| b.is_ascii_hexdigit())/'
echo "MUTANTS killed $killed/$total"
[ "$killed" = "$total" ]
