#!/usr/bin/env bash
# Standalone public-prefix producer with the phone's MTP driver. Does not
# modify the main build or load a GPU. Run the result with GGML_CPU_SO set.
set -euo pipefail
if [[ $# != 1 || -z ${GGML_SRC:-} || -z ${GGML_LIB:-} ]]; then
    echo 'usage: GGML_SRC=<pinned llama source> GGML_LIB=<shared libraries> build-prefix-mtp.sh OUTPUT_DIR' >&2
    exit 2
fi
gg_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
payload_dir="$gg_dir/../../shielded/anchor/avf/payload"
mkdir -p -- "$1"
build_dir=$(cd -- "$1" && pwd)
common=(-O2 -g -ffunction-sections -fdata-sections -ffp-contract=off)
objects=()
for name in prefix-kv shielded-pads tweetnacl poly1305-donna; do
    obj="$build_dir/$name.o"
    "${CC:-cc}" "${common[@]}" -D_POSIX_C_SOURCE=200809L -std=c11 -c "$gg_dir/$name.c" -o "$obj"
    objects+=("$obj")
done
"${CC:-cc}" "${common[@]}" -D_POSIX_C_SOURCE=200809L -std=c11 -I"$GGML_SRC/include" -I"$GGML_SRC/ggml/include" \
    -c "$payload_dir/anchor_mtp.c" -o "$build_dir/anchor_mtp.o"
"${CXX:-c++}" "${common[@]}" -std=c++17 -DSH_PREFIX_WITH_MTP -I"$payload_dir" \
    -I"$GGML_SRC/include" -I"$GGML_SRC/ggml/include" "$gg_dir/prefix-kv-mint.cpp" "${objects[@]}" "$build_dir/anchor_mtp.o" \
    -Wl,--gc-sections -L"$GGML_LIB" -Wl,-rpath,"$GGML_LIB" -lllama -lggml -lggml-base -ldl -lpthread -lm \
    -o "$build_dir/prefix-kv-mint"
echo "Built $build_dir/prefix-kv-mint (use --mtp 1 for the compound artifact)"
