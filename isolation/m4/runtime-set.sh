#!/bin/sh
# The runtime directory a plane executes from, and the digest the SVSM must be built to admit it under.
#
#   runtime-set.sh compose <rtdir>   create rtdir and fill it: the wasmtime ELF, every shared library ldd resolves
#                                    for it, the ELF interpreter, and runtime.json (the RuntimeID's source)
#   runtime-set.sh digest <rtdir>    print "rtset <sha256> bytes=<n> members=<k> elf=<e>" - the sha256 is the
#                                    ENCLAVE_RUNTIME_SHA256 entry for the plane that carries this directory as /rt
#
# ONE composition, used by build-plane-guest.sh, build-admit-guest.sh and test-rtset.sh, so the test covers the
# directory the guests actually carry. The digest is computed by m4/rtset.c, which is guest/rtset.h built for the
# host - the same code the plane stages the set with - so the digest the SVSM is built with and the bytes the plane
# hands it come from one implementation. See guest/rtset.h for the format.
#
# ldd decides the library list here, and ldd is only the build host's opinion. What the plane actually maps is
# checked where it counts, inside the running plane (planeinit's maps check): every executable file the runtime
# maps must be a member, and every ELF member must be mapped - so a library this list missed, or one it carries
# that nothing loads, stops the plane from serving rather than going unnoticed.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cmd=${1:-}; rt=${2:-}
[ -n "$rt" ] || { echo "usage: runtime-set.sh compose|digest <rtdir>" >&2; exit 2; }

case "$cmd" in
compose)
  # The set is the WHOLE directory, so it must start empty: a leftover file would be admitted with the rest.
  if [ -e "$rt" ] && [ -n "$(ls -A "$rt")" ]; then
    echo "runtime-set.sh: $rt is not empty; the set is every file in it, so it must start empty" >&2; exit 2
  fi
  mkdir -p "$rt"
  W=$(command -v wasmtime)
  cp -L "$W" "$rt/wasmtime"
  "$here/../contract/runtime-identity.sh" "$W" > "$rt/runtime.json"
  # "=> not found" makes $3 the word "not", and the cp of it fails the build, which is the right outcome.
  ldd "$W" | awk '/=>/ {print $3}' | while read -r lib; do cp -L "$lib" "$rt/"; done
  cp -L /lib64/ld-linux-x86-64.so.2 "$rt/" 2>/dev/null || cp -L /lib/ld-linux-x86-64.so.2 "$rt/"
  ;;
digest)
  [ -d "$rt" ] || { echo "runtime-set.sh: no directory $rt" >&2; exit 2; }
  t=$(mktemp -d)
  trap 'rm -rf "$t"' EXIT
  gcc -O2 -Wall -Wextra -Werror -o "$t/rtset" "$here/rtset.c"
  "$t/rtset" encode "$rt" > "$t/enc" || { echo "runtime-set.sh: the set in $rt was REFUSED (above)" >&2; exit 1; }
  "$t/rtset" list "$rt" > "$t/list"
  sha=$(sha256sum "$t/enc" | cut -c1-64)
  bytes=$(stat -c %s "$t/enc")
  set -- $(tail -1 "$t/list")      # total <n> members <k> elf <e>
  [ "$2" = "$bytes" ] || { echo "runtime-set.sh: encoded $bytes bytes, the scan said $2" >&2; exit 1; }
  echo "rtset $sha bytes=$bytes members=$4 elf=$6"
  ;;
*) echo "usage: runtime-set.sh compose|digest <rtdir>" >&2; exit 2 ;;
esac
