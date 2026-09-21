#!/usr/bin/env bash
# sync.sh -- push the enclave engine's sources to the mini PC (C:\Users\claude\vbs\ee) and rebuild there.
#   ./sync.sh          sync + full build          ./sync.sh host   sync + host only
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; GG="$HERE/../../wasm/ggml-shielded"; BOX="${BOX:-minipc-zt}"
ssh "$BOX" 'New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs\ee\ggml-shielded, C:\Users\claude\vbs\ee\posix\sys, C:\Users\claude\vbs\ee\posix\netinet, C:\Users\claude\vbs\ee\posix\linux, C:\Users\claude\vbs\ee\posix\arpa, C:\Users\claude\vbs\ee\posix\asm, C:\Users\claude\vbs\ee\patched | Out-Null'
scp -q "$HERE"/*.c "$HERE"/*.cpp "$HERE"/*.h "$HERE"/build.cmd "$BOX:C:/Users/claude/vbs/ee/"
scp -q "$HERE"/patched/* "$BOX:C:/Users/claude/vbs/ee/patched/"
ssh "$BOX" 'New-Item -ItemType Directory -Force -Path C:\Users\claude\vbs\ee\stl | Out-Null'
scp -q "$HERE"/stl/*.cpp "$HERE"/stl/*.hpp "$BOX:C:/Users/claude/vbs/ee/stl/"
for d in . sys netinet linux arpa asm; do scp -q "$HERE"/posix/$d/*.h "$BOX:C:/Users/claude/vbs/ee/posix/$d/"; done
scp -q "$GG"/*.c "$GG"/*.cpp "$GG"/*.h "$GG"/*.inc "$BOX:C:/Users/claude/vbs/ee/ggml-shielded/"
ssh "$BOX" "cmd /c C:\\Users\\claude\\vbs\\ee\\build.cmd ${1:-}"
