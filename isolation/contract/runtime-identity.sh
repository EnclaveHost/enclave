#!/bin/sh
# Emit the runtime identity for a domain image, as isolation/contract/runtime.go RuntimeIdentity JSON.
#
# ABI/2 binds this into report_data[0:32] (RUNTIME.md rule 6): the app is one portable WebAssembly
# component compiled INSIDE the domain, so a report that named only the bundle would not say what
# compiled it. The file is written into the image at build time, which puts it in the launch measurement
# on the kernel-hashes path - the host does not supply it at boot - and the front checks it against the
# domain before stating it (isolation/m2/front/runtime.go): a domain that may not hold an executable page
# cannot claim execution=jit, and a domain holding a writable-and-executable mapping cannot claim W^X.
#
# The fields are what this launcher ACTUALLY does, not what would read best:
#   execution jit     the Linux domains compile to their own ISA; wasmtime holds no W+X mapping while
#                     serving (measured: its code region is anonymous r-xp), so W^X is enforced
#   cpuFeatures       "host-detected": the launcher passes no target or feature flags, so Cranelift
#                     enables what CPUID reports on the host it runs on. That is a weaker statement than a
#                     pinned list - the code depends on the chip, which the report's VCEK does name - and
#                     pinning an explicit policy is the open item in RUNTIME.md's status.
#   cache none        the launchers pass -C cache=n. wasmtime's module cache is ON by default (measured,
#                     with a control: without the flag $HOME/.cache/wasmtime/modules appears, with it
#                     nothing does), and m3's domains even run with HOME=/tmp, so without that flag every
#                     domain would keep an unauthenticated compiled cache - which rule 5 refuses.
#
# usage: runtime-identity.sh <wasmtime-binary>   (writes JSON to stdout)
set -e
W=${1:?usage: runtime-identity.sh <wasmtime-binary>}
[ -x "$W" ] || { echo "runtime-identity.sh: $W is not executable" >&2; exit 2; }
# "wasmtime 48.0.1 (7bac2c277 2026-08-24)" -> 48.0.1
ver=$("$W" --version | head -1 | awk "{print \$2}")
case "$ver" in
  [0-9]*) ;;
  *) echo "runtime-identity.sh: $W does not report a wasmtime version (read '$ver')" >&2; exit 2 ;;
esac
case $(uname -m) in
  x86_64) isa=x86_64 ;;
  aarch64|arm64) isa=aarch64 ;;
  *) echo "runtime-identity.sh: $(uname -m) is not an ISA the contract names" >&2; exit 2 ;;
esac
# one fixed field order, so the same inputs give the same image bytes and the same launch measurement
# (the identity DIGEST is order-independent - contract.Canonical sorts - but the file in the image is not)
printf '{"name":"wasmtime","version":"%s","execution":"jit","targetIsa":"%s","hostIsa":"%s","cpuFeatures":"host-detected","wx":"enforced","cache":"none"}\n' \
  "$ver" "$isa" "$isa"
