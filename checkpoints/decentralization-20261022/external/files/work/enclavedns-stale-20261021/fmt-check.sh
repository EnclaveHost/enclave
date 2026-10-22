#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/tree/enclavedns
for f in src/resolver.rs src/net.rs; do rustfmt --edition 2021 --check --config max_width=140 $f >/dev/null 2>&1 && echo "$f fmt-clean (max_width 140)" || echo "$f fmt-diff"; git -C /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/../enclave-apps show HEAD:enclavedns/$f > /tmp/orig-fmt.rs; rustfmt --edition 2021 --check --config max_width=140 /tmp/orig-fmt.rs >/dev/null 2>&1 && echo "  canonical $f fmt-clean" || echo "  canonical $f also fmt-diff"; done
