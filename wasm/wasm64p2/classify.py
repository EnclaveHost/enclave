#!/usr/bin/env python3
"""Assert a built artifact is a memory64 COMPONENT.

The same structural sniff every publish path and the runner key on: a
layer-1 component carrying a core module whose memory section has the
64-bit limits flag (0x04), found at the top level or nested (a wasm64 app
ships composed under the wasm32 WASI proxy, so its 64-bit core sits inside
a nested component). Lockstep with wasm_manager._component_mem64.
"""
import sys


def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            return r, i


def module_mem64(m):
    i = 8
    while i < len(m):
        sid = m[i]; size, j = uleb(m, i + 1)
        if sid == 5:
            count, k = uleb(m, j)
            return count > 0 and (m[k] & 0x04) != 0
        i = j + size
    return False


def component_mem64(b):
    i = 8
    while i < len(b):
        sid = b[i]; size, j = uleb(b, i + 1)
        inner = b[j:j + size]
        if sid == 1 and len(inner) >= 8 and module_mem64(inner):
            return True
        if sid == 4 and component_mem64(inner):
            return True
        i = j + size
    return False


def main():
    path = sys.argv[1]
    b = open(path, "rb").read()
    assert b[:4] == b"\x00asm", "not wasm"
    assert (b[6] | (b[7] << 8)) == 1, "not a component (layer 1)"
    assert component_mem64(b), "no 64-bit memory anywhere in the component"
    print(f"[w64] {path}: {len(b):,} bytes, component, memory64")


if __name__ == "__main__":
    main()
