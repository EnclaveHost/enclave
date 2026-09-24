#!/usr/bin/env bash
# build-hpke.sh -- the page's HPKE (RFC 9180) is @hpke/core (dajiaji/hpke-js, MIT; WebCrypto X25519/HKDF/AES-GCM), not
# code of ours. This rebuilds web/vendor/hpke-core-1.9.0.js reproducibly: the two npm tarballs, each refused unless its
# sha512 equals the pinned registry integrity, bundled into ONE browser ES module (a page cannot resolve @hpke/common by
# bare name) by a pinned esbuild. The site serves the result same-origin; the relay never serves it. MIT notices:
# hpke-LICENSE.txt. Run from anywhere: ESBUILD=<path> web/vendor/build-hpke.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ESBUILD="${ESBUILD:-/home/steven/Projects/enclave/node_modules/.bin/esbuild}"
CORE=1.9.0;   CORE_SRI='sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q=='
COMMON=1.10.1; COMMON_SRI='sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw=='
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
( cd "$W" && npm pack --silent "@hpke/core@$CORE" "@hpke/common@$COMMON" >/dev/null )
sri() { echo "sha512-$(openssl dgst -sha512 -binary "$1" | base64 -w0)"; }
[ "$(sri "$W/hpke-core-$CORE.tgz")" = "$CORE_SRI" ] || { echo "@hpke/core $CORE: integrity mismatch, refusing" >&2; exit 1; }
[ "$(sri "$W/hpke-common-$COMMON.tgz")" = "$COMMON_SRI" ] || { echo "@hpke/common $COMMON: integrity mismatch, refusing" >&2; exit 1; }
mkdir -p "$W/node_modules/@hpke/core" "$W/node_modules/@hpke/common"
tar xzf "$W/hpke-core-$CORE.tgz" -C "$W/node_modules/@hpke/core" --strip-components=1
tar xzf "$W/hpke-common-$COMMON.tgz" -C "$W/node_modules/@hpke/common" --strip-components=1
echo 'export { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm } from "@hpke/core";' > "$W/entry.js"
V="$("$ESBUILD" --version)"
( cd "$W" && "$ESBUILD" entry.js --bundle --format=esm --platform=browser --target=es2022 --legal-comments=inline --log-level=warning \
    --banner:js="// @hpke/core $CORE ($CORE_SRI) + @hpke/common $COMMON ($COMMON_SRI), MIT (hpke-LICENSE.txt); bundled by esbuild $V with web/vendor/build-hpke.sh -- do not edit" \
    --outfile="$HERE/hpke-core-$CORE.js" )
{ echo "@hpke/core $CORE:"; cat "$W/node_modules/@hpke/core/LICENSE"; echo; echo "@hpke/common $COMMON:"; cat "$W/node_modules/@hpke/common/LICENSE"; } > "$HERE/hpke-LICENSE.txt"
echo "built $HERE/hpke-core-$CORE.js sha256 $(sha256sum "$HERE/hpke-core-$CORE.js" | cut -c1-64) (esbuild $V)"
