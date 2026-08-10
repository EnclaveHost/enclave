#!/bin/sh
# enclave/SET: build a Rust guest that runs on REAL threads.
#
# Measured on this recipe (200M-iteration dependent chain per thread):
#   n=1 real 0.207s user 0.200s (0.97x)   n=4 real 0.207s user 0.775s (3.74x)
#   n=2 real 0.207s user 0.398s (1.92x)   n=8 real 0.206s user 1.547s (7.51x)
# Constant wall time with linearly-scaling CPU time IS the scaling signature
# here: each thread does a FIXED amount of work, so 8x the work in the same
# wall time is 8x throughput.
set -e
IMG="${IMG:-enclave-wasipsetc-build:r14d}"
OUT="${OUT:-rustset.wasm}"

# 1. Rust -> staticlib. Three things are load-bearing:
#    * `-Z build-std=core` — the PRECOMPILED core/std for wasm32-wasip2 is built
#      WITHOUT atomics and cannot be linked into a shared-memory module. core is
#      rebuilt here with them.
#    * the target features — same set the C wrapper forces.
#    * `no_std` — Rust's std for wasip2 bundles its own wasi-libc, which fights
#      the SET sysroot. Threading comes from the SET libc's pthreads by FFI.
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals" \
  cargo +nightly build --release --target wasm32-wasip2 -Z build-std=core

# 2. Link through the SET wrapper: it supplies --sysroot=/opt/wasip2-set-sysroot,
#    -Wl,--shared-memory,--max-memory,--export-table and runs set-componentize.
cp target/wasm32-wasip2/release/libset_demo.a .
docker run --rm -v "$PWD":/src "$IMG" main.c libset_demo.a -O2 -o "$OUT"

echo "built $OUT — run it with:"
echo "  W=\"-W threads,shared-everything-threads,component-model-threading,shared-memory\""
echo "  wasmtime run \$W -S cli $OUT 8"
