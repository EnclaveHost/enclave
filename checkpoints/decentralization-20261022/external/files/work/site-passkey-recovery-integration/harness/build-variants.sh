#!/usr/bin/env bash
# Real scripts/build-site.mjs runs on a scratch copy of the candidate tree (the build needs git for its stamp; the
# candidate has no .git, and the build rewrites site/css, site/js/gen and site/dist, which must not touch tree/).
#   1. default build (no profile)                     -> artifacts/default-dist
#   2. build with the synthetic built-in profile        -> artifacts/profile-dist
#   3. malformed inputs: each build must FAIL, leave no site/dist, and the release tool must then have nothing to release
# Nothing here publishes, signs or contacts a remote service.
set -uo pipefail
C="$(cd "$(dirname "$0")/.." && pwd)"
B="$C/build/repo"; A="$C/artifacts"; FX="$C/tree/test/fixtures/built-in-profile.synthetic.json"
fail() { echo "HARNESS FAIL: $*"; exit 1; }

rm -rf "$C/build" "$A"; mkdir -p "$B" "$A" "$C/build/bad"
rsync -a --exclude=/site/dist --exclude=/node_modules "$C/tree/" "$B/"
ln -s "$(readlink "$C/tree/node_modules")" "$B/node_modules"
( cd "$B" && git init -q && git add -A && git -c user.name=scratch -c user.email=scratch@localhost -c commit.gpgsign=false \
    commit -q -m "scratch snapshot of the candidate (build stamp only)" ) || fail "scratch git"
echo "[harness] scratch commit $(git -C "$B" rev-parse --short=8 HEAD)"

cd "$B"
echo "[harness] 1. default build"
node scripts/build-site.mjs || fail "default build"
cp -a site/dist "$A/default-dist"

echo "[harness] 2. built-in profile build"
D="sha256:$(sha256sum "$FX" | cut -d' ' -f1)"
node scripts/build-site.mjs --built-in-profile "$FX" --built-in-profile-digest "$D" || fail "profile build"
cp -a site/dist "$A/profile-dist"
echo "$D" > "$A/profile-digest.txt"

echo "[harness] 3. malformed inputs (each must fail before producing anything releasable)"
X="$C/build/bad"
printf '{ "format": "enclave-browser-profile", ' > "$X/truncated.json"
sed 's/"version": 1,/"version": 1, "version": 1,/' "$FX" > "$X/duplicate-key.json"
sed 's|"rpcs": \["https://rpc-a.builtin.invalid", "https://rpc-b.builtin.invalid"\]|"rpcs": ["https://rpc-a.builtin.invalid"]|' "$FX" > "$X/one-rpc.json"
sed 's|"https://rpc-a.builtin.invalid"|"http://rpc-a.builtin.invalid"|' "$FX" > "$X/plain-http-rpc.json"
{ head -c 60 "$FX"; printf '\xe9'; tail -c +61 "$FX"; } > "$X/not-utf8.json"
sed 's/"usdc"/"usdc2": 1, "usdc"/' "$FX" > "$X/unknown-field.json"
cmp -s "$X/one-rpc.json" "$FX" && fail "one-rpc fixture unchanged"
cmp -s "$X/plain-http-rpc.json" "$FX" && fail "http fixture unchanged"
dig() { echo "sha256:$(sha256sum "$1" | cut -d' ' -f1)"; }
n=0
attempt() {   # name, expected-error-regex, build args...
  local name="$1" re="$2"; shift 2
  rm -rf site/dist; cp -a "$A/default-dist" site/dist   # a previous good build is present before every attempt
  [ -f site/dist/index.html ] || fail "no dist before $name"
  out="$(node scripts/build-site.mjs "$@" 2>&1)"; rc=$?
  [ $rc -ne 0 ] || fail "$name: build exited 0"
  echo "$out" | grep -Eq "$re" || { echo "$out" | tail -5; fail "$name: error does not match /$re/"; }
  [ ! -e site/dist ] || fail "$name: site/dist still exists after the failed build"
  rel="$(node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --out "$C/build/rel-$name" --no-base-i-accept-dropping-old-chunks --commit scratch 2>&1)"; rrc=$?
  [ $rrc -ne 0 ] || fail "$name: the release tool released something"
  echo "[harness]   $name: build exit $rc, /$(echo "$out" | grep -Eo "$re" | head -1)/, site/dist absent, release tool exit $rrc"
  n=$((n+1))
}
attempt wrong-digest "not the reviewed" --built-in-profile "$FX" --built-in-profile-digest "sha256:$(printf 'x' | sha256sum | cut -d' ' -f1)"
attempt missing-digest "go together" --built-in-profile "$FX"
attempt unknown-flag "unknown build argument" --profile "$FX"
attempt truncated-json "not a usable browser profile" --built-in-profile "$X/truncated.json" --built-in-profile-digest "$(dig "$X/truncated.json")"
attempt duplicate-key "duplicate key" --built-in-profile "$X/duplicate-key.json" --built-in-profile-digest "$(dig "$X/duplicate-key.json")"
attempt one-rpc "2–8 RPC origins" --built-in-profile "$X/one-rpc.json" --built-in-profile-digest "$(dig "$X/one-rpc.json")"
attempt plain-http-rpc "must use HTTPS" --built-in-profile "$X/plain-http-rpc.json" --built-in-profile-digest "$(dig "$X/plain-http-rpc.json")"
attempt not-utf8 "not UTF-8" --built-in-profile "$X/not-utf8.json" --built-in-profile-digest "$(dig "$X/not-utf8.json")"
attempt unknown-field "unknown field" --built-in-profile "$X/unknown-field.json" --built-in-profile-digest "$(dig "$X/unknown-field.json")"
attempt missing-file "ENOENT|no such file" --built-in-profile "$X/absent.json" --built-in-profile-digest "$(dig "$FX")"
echo "[harness] malformed inputs refused: $n/10"
[ $n -eq 10 ] || fail "not every malformed input ran"

cd "$A"
for d in default-dist profile-dist; do
  ( cd "$d" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$d.sha256"
  echo "[harness] $d: $(wc -l < "$d.sha256") files, manifest sha256 $(sha256sum "$d.sha256" | cut -d' ' -f1)"
done
sha256sum default-dist/recover/* default-dist/vendor/aa.js default-dist/csp-script-src.txt
echo "[harness] OK"
