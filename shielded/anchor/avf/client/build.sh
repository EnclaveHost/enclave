#!/usr/bin/env bash
# build.sh -- the pVM client artifacts, reproducibly (client/DESIGN.md; LAB, not production). From the same commit, anyone
# with the pinned esbuild gets the same bytes: no timestamps, no absolute paths (esbuild runs from this directory), the
# extension zip STORED with fixed dates, sorted entries and fixed permissions. Outputs in client/dist/:
#   pvm-client.mjs       the CLI, one file; its first line is the version marker trust.js checks on update
#   pvm-client-ext.zip   the MV3 browser extension (the same core, a site cannot replace it)
#   BUILD.json           every input with its sha256, the tool version, every output with its sha256 and size
# Run: ESBUILD=<path to esbuild 0.28.1> client/build.sh [--check]   (--check: rebuild to a temporary directory and
# compare with the committed dist/, exit 1 on any difference)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
ESBUILD="${ESBUILD:-/home/steven/Projects/enclave/node_modules/.bin/esbuild}"; WANT_ESBUILD=0.28.1
[ "$("$ESBUILD" --version)" = "$WANT_ESBUILD" ] || { echo "esbuild $WANT_ESBUILD required (got $("$ESBUILD" --version))" >&2; exit 2; }
VERSION=$(sed -n 's/^export const CLIENT_VERSION = "\([0-9.]*\)".*/\1/p' src/trust.js)
[ -n "$VERSION" ] || { echo "no CLIENT_VERSION in src/trust.js" >&2; exit 2; }
OUT="$HERE/dist"; [ "${1:-}" = "--check" ] && OUT="$(mktemp -d)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$OUT" "$W/ext"
LIC="$(cat ../web/vendor/hpke-LICENSE.txt)"
BANNER="/*! enclave-pvm-client $VERSION (LAB, not production) -- built by client/build.sh with esbuild $WANT_ESBUILD
Contains @hpke/core 1.9.0 and @hpke/common 1.10.1 (MIT):
$LIC
*/"
common=(--bundle --format=esm --target=es2022 --legal-comments=none --charset=utf8 --log-level=warning)
"$ESBUILD" cli.mjs "${common[@]}" --platform=node --banner:js="$BANNER" --metafile="$W/cli.meta.json" --outfile="$W/pvm-client.mjs"
for p in client options; do
  "$ESBUILD" "ext/$p.src.js" "${common[@]}" --platform=browser --banner:js="$BANNER" --metafile="$W/$p.meta.json" --outfile="$W/ext/$p.js"
done
cp ext/manifest.json ext/client.html ext/options.html ext/style.css "$W/ext/"
cp ../web/vendor/hpke-LICENSE.txt "$W/ext/THIRD_PARTY_LICENSES.txt"
cp "$W/pvm-client.mjs" "$OUT/pvm-client.mjs"
python3 - "$W" "$OUT" "$VERSION" "$WANT_ESBUILD" <<'PY'
import hashlib, json, os, sys, zipfile
w, out, version, esb = sys.argv[1:5]
ext = os.path.join(w, "ext"); zp = os.path.join(out, "pvm-client-ext.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_STORED) as z:
    for name in sorted(os.listdir(ext)):
        zi = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)); zi.external_attr = 0o100644 << 16; zi.create_system = 3
        with open(os.path.join(ext, name), "rb") as f: z.writestr(zi, f.read())
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
inputs = {}
for m in ("cli", "client", "options"):
    for k in json.load(open(os.path.join(w, f"{m}.meta.json")))["inputs"]: inputs[k] = sha(k)
for k in ("ext/manifest.json", "ext/client.html", "ext/options.html", "ext/style.css", "../web/vendor/hpke-LICENSE.txt"): inputs[k] = sha(k)
b = {"client": "enclave-pvm-client", "version": version, "lab": "NOT PRODUCTION", "esbuild": esb,
     "inputs": dict(sorted(inputs.items())),
     "outputs": {n: {"sha256": sha(os.path.join(out, n)), "size": os.path.getsize(os.path.join(out, n))} for n in ("pvm-client.mjs", "pvm-client-ext.zip")}}
json.dump(b, open(os.path.join(out, "BUILD.json"), "w"), indent=1, sort_keys=True); open(os.path.join(out, "BUILD.json"), "a").write("\n")
for n, o in b["outputs"].items(): print(f"{n} sha256 {o['sha256']} ({o['size']} bytes)")
PY
if [ "${1:-}" = "--check" ]; then
  for f in pvm-client.mjs pvm-client-ext.zip BUILD.json; do cmp -s "$OUT/$f" "$HERE/dist/$f" || { echo "NOT REPRODUCED: $f differs from the committed dist/" >&2; rm -rf "$OUT"; exit 1; }; done
  echo "reproduced: dist/ matches a fresh build byte for byte"; rm -rf "$OUT"
fi
