#!/usr/bin/env bash
# Fetches the llm-chat model artifacts into assets/ (gitignored - a 750MB
# model does not belong in git). Pinned to an exact HuggingFace revision and
# sha256 so the build is reproducible. Run once before
# `cargo component build --release --target wasm32-wasip2`.
#
# Model: Qwen2.5-0.5B-Instruct, ONNX export with KV cache, q4 quantization
# with FP32 activations (4-bit MatMulNBits weights). fp32 - not the smaller
# q4f16 - is deliberate: MatMulNBits' fp16 M=1 (single-token decode) kernels
# compute garbage on sm_90 under MPS (prefill GEMM fine, decode GEMV garbage;
# sm_86 and CPU fine - observed live on H200 CC 2026-07-05). fp32 activations
# take a different kernel family and decode correctly, at ~5% lower tok/s.
#
# NOTE the artifact this produces (~493MB) exceeds wasmtime's default 128MiB
# hostcall-fuel budget; the platform launches nn tenants with
# -S hostcall-fuel=4GiB (wasm_manager.py). Local runs need the same flag.
set -euo pipefail
mkdir -p "$(dirname "$0")/assets"
cd "$(dirname "$0")/assets"

REPO=onnx-community/Qwen2.5-0.5B-Instruct
REV=cc5cc01a65cc3ff17bdb73a7de33d879f62599b0

fetch() { # <repo-path> <sha256>
    local out="${1##*/}"
    if [ -f "$out" ] && echo "$2  $out" | sha256sum -c --quiet - 2>/dev/null; then
        echo "$out: cached, checksum ok"
        return
    fi
    echo "fetching $1 ..."
    curl -fsSL -o "$out" "https://huggingface.co/$REPO/resolve/$REV/$1"
    echo "$2  $out" | sha256sum -c -
}

fetch onnx/model_q4.onnx 09235a3b1c135cd04ef570e5053b5c079e028078a2cc5f76ba6a251e91bf3296
fetch tokenizer.json a8506e7111b80c6d8635951a02eab0f4e1a8e4e5772da83846579e97b16f61bf
