# vendor/ggml — the engine's ggml headers, pinned

These are ggml's public and internal headers at the version the ELL engine image
ships (`VERSION`), vendored so that `metal/build-image.mjs` can compile the
shielded backend **from source, inside the image build**, rather than copying in
a binary somebody built on a workstation months earlier.

That is not tidiness. `libggml-shielded.so` holds the one-time pads, the
Freivalds secret and every plaintext activation: it is the single place the
tier's confidentiality lives. Shipped as a prebuilt binary it had two properties
worth removing — a reviewer approving a change to it saw only
`Bin 76040 -> 145344 bytes`, and anyone who compromised the build workstation or
its toolchain could put code inside the measurement without ever touching this
repository's source. Headers are text, so vendoring them makes the whole input
to that binary reviewable and lets the build derive the bytes rather than trust
them.

The library itself is NOT vendored: the build links against the
`libggml-base.so` inside the digest-pinned engine image, so the code and the
library it binds to come from the same pinned artifact.

## Keeping them honest

Two checks, because a header/library mismatch is undefined behaviour rather than
an error:

1. `metal/build-image.mjs` compares `VERSION` against the `libggml-base.so.0.X.Y`
   the pinned image actually ships and **fails the build** if they differ. That
   is the loud one, and it fires at the moment the engine image is repinned.
2. `GGML_BACKEND_API_VERSION` (2 at this version) is compiled into the backend's
   registration struct, and ggml refuses to load a module whose value disagrees
   with the runtime's. That is the backstop if check 1 is ever bypassed.

## Refreshing after an engine bump

```
V=<new version>            # from ggml/CMakeLists.txt in the engine's source tree
for h in include/ggml.h include/ggml-backend.h include/ggml-alloc.h include/gguf.h \
         src/ggml-backend-impl.h src/ggml-impl.h; do cp "$GGML_SRC/ggml/$h" .; done
printf '%s\n' "$V" > VERSION
sha256sum *.h | sed 's|.*/||' > SHA256SUMS
```

Then rebuild the image; if the version does not match the repinned engine, the
build says so by name rather than crashing a tenant later.

Upstream: <https://github.com/ggml-org/llama.cpp> (`ggml/`), MIT.
