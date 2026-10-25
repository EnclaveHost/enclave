#!/bin/sh
# read-only: does the pinned base binary embed h2 / reqwest 0.13.4 source paths (panic locations)?
sha256sum "../../fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base" | cut -c1-64
for p in 'h2-0.4.15/src' 'reqwest-0.13.4/src' 'reqwest-0.13.4/src/async_impl/client.rs' 'h2-0.4.15/src/client.rs' 'hyper-util'; do printf '%s %s\n' "$p" "$(grep -a -o -F "$p" "../../fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base" | wc -l)"; done
