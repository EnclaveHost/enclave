#!/usr/bin/env bash
# Reproducible, locked build of the site-host component for the release pinned in release.lock.json.
#
#   scripts/build.sh --release <DIR>/<CID>     a site-release directory (e.g. the frozen artifact)
#   scripts/build.sh --car <site.car>          the release's CAR alone, fetched from anywhere by its CID
#
# Inputs:
#   - the toolchain (rust-toolchain.toml);
#   - the crates (Cargo.lock, --locked);
#   - the source;
#   - the validated CAR.
# The same inputs give the same wasm, whatever directory or user builds it: build paths are remapped away.
# Output: dist/site_host.wasm and dist/PACKAGE.json, which records:
#   - the wasm hash and size;
#   - the embedded release;
#   - the toolchain;
#   - a source digest;
#   - the component's imports;
#   - the catalog resources to publish with.
# Nothing here touches a network unless cargo must fetch a crate that is not in the local cache; set
# CARGO_NET_OFFLINE=true to forbid even that.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$(pwd -P)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"

node scripts/embed-release.mjs "$@"

export RUSTFLAGS="--remap-path-prefix=$SRC=/site-host --remap-path-prefix=$CARGO_HOME_DIR=/cargo"
cargo build --locked --release --target wasm32-wasip2
WASM=target/wasm32-wasip2/release/site_host.wasm
wasm-tools validate --features all "$WASM"
wasm-tools component wit "$WASM" > target/component.wit
# the serve-time guarantee, on the binary: no way to make an outgoing request or open a socket
if grep -Eq "import wasi:http/outgoing-handler|import wasi:sockets/" target/component.wit; then
  echo "site-host: the built component imports an egress interface; refusing" >&2; exit 1
fi
grep -q "export wasi:http/incoming-handler@0.2" target/component.wit

mkdir -p dist
cp "$WASM" dist/site_host.wasm
node - "$SRC" <<'EOF'
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto"), { execFileSync } = require("node:child_process");
const src = process.argv[2], sha = (b) => createHash("sha256").update(b).digest("hex");
const run = (cmd, a) => execFileSync(cmd, a, { cwd: src, encoding: "utf8" }).trim();
// the source digest: every file the build reads, by relative path (generated/ignored inputs excluded)
const files = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (["target", "dist", "release"].includes(r) || r === ".git") continue;
    if (e.isDirectory()) walk(r); else files.push(r);
  }
})("");
files.sort();
const manifest = files.map((f) => `${sha(fs.readFileSync(path.join(src, f)))}  ${f}`).join("\n") + "\n";
const wasm = fs.readFileSync(path.join(src, "dist/site_host.wasm"));
const embed = JSON.parse(fs.readFileSync(path.join(src, "release/release.json"), "utf8"));
const cargoToml = fs.readFileSync(path.join(src, "Cargo.toml"), "utf8");
const pkg = {
  schema: "site-host-package/1",
  app: "site-host", version: /^version = "([^"]+)"/m.exec(cargoToml)[1],
  wasm: { file: "site_host.wasm", sha256: sha(wasm), bytes: wasm.length },
  release: { cid: embed.cid, car: embed.car },
  toolchain: { rustc: run("rustc", ["-V"]), cargo: run("cargo", ["-V"]), target: "wasm32-wasip2", profile: "release (lto, opt-level s, strip)",
               rustflags: "--remap-path-prefix=<src>=/site-host --remap-path-prefix=<CARGO_HOME>=/cargo", locked: true },
  source: { files: files.length, sha256: sha(manifest) },
  imports: fs.readFileSync(path.join(src, "target/component.wit"), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^(import|export) /.test(l)).map((l) => l.replace(/;$/, "")),
  catalog: { ports: "", mem: 256, cpuGflops: 10, vram: 0, gpuGflops: 0, config: { release: embed.cid } },
};
fs.writeFileSync(path.join(src, "dist/SOURCE.sha256"), manifest);
fs.writeFileSync(path.join(src, "dist/PACKAGE.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`site-host ${pkg.version}: wasm ${pkg.wasm.sha256} (${pkg.wasm.bytes} bytes), release ${pkg.release.cid}, source ${pkg.source.sha256} (${files.length} files), ${pkg.toolchain.rustc}`);
EOF
