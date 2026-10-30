# sourced: input locations (read-only) and helpers shared by the reproduction jobs
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022; F=$B/rpc-runtime-final-integration
R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/native-provenance-audit-stage/reproduce
SCRIPT=$F/repo/scripts/rpc-runtime/build-binaries.sh; TAR=$F/closure/src/base-5476069f.tar.gz
HREPO=$B/witness-failover/helios; LREPO=$B/rpc-gossip-bridge/listener; CHL=$F/closure/cargo-home-listener
# git refuses repositories owned by "another" uid inside the user namespace; reading them is all this does
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' GIT_OPTIONAL_LOCKS=0
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; exit 9; fi; }
treehash() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64; }
offline() { local ifs; ifs=$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\n' ' ')
  need "offline: interfaces = lo only ($ifs)" [ "$ifs" = "lo " ]; need "offline: no IPv4 route" [ -z "$(tail -n +2 /proc/self/net/route)" ]; }
toolchain() { echo "[tool] $(rustc +1.96.0 -vV | tr '\n' ' ')"; echo "[tool] $(cargo +1.96.0 -V)"
  echo "[tool] rustc $(sha256sum < "$(rustup which --toolchain 1.96.0 rustc)" | cut -c1-16) cargo $(sha256sum < "$(rustup which --toolchain 1.96.0 cargo)" | cut -c1-16) cc $(cc --version | head -1)"; }
