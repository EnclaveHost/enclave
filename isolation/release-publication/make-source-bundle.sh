#!/bin/sh
# Pack the CORRESPONDING SOURCE (fetch-corresponding-source.sh's directory) into one deterministic tar, to be
# distributed ALONGSIDE the release tarball(s) it covers, from the same place: GPL-2.0 section 3(a) and LGPL-2.1
# section 6(a) are met by the source accompanying the binaries, which pointers to kernel.org, GitHub or Arch's gitlab
# are not (enclave-e3). Where the two are hosted is the publisher's decision; this script publishes nothing.
#
#   usage: make-source-bundle.sh <sources dir> <outdir> <release id>...
#
# The bundle holds every file SHA256SUMS lists (each checked first), SHA256SUMS itself, and README.txt naming the
# releases it is the source for. Its members are already compressed, so the tar is not. It is named after the sha256
# of SHA256SUMS, so a different set of sources can never carry the same name.
set -e
umask 022
src=${1:?usage: make-source-bundle.sh <sources dir> <outdir> <release id>...}
out=${2:?usage: make-source-bundle.sh <sources dir> <outdir> <release id>...}
shift 2
[ $# -gt 0 ] || { echo "make-source-bundle.sh: name the release id(s) it covers" >&2; exit 2; }
src=$(cd "$src" && pwd)
(cd "$src" && sha256sum -c --quiet SHA256SUMS) || { echo "make-source-bundle.sh: $src does not match its SHA256SUMS" >&2; exit 1; }
listed=$(mktemp); { awk '{print $2}' "$src/SHA256SUMS"; echo SHA256SUMS; } > "$listed"
extra=$(cd "$src" && ls -A | grep -v -x -F -f "$listed" || true); rm -f "$listed"
[ -z "$extra" ] || { echo "make-source-bundle.sh: files not in SHA256SUMS: $extra" >&2; exit 1; }
[ ! -e "$out" ] || [ -z "$(ls -A "$out")" ] || { echo "make-source-bundle.sh: $out is not empty" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)
id=$(sha256sum "$src/SHA256SUMS" | cut -c1-12)
name=enclave-guest-corresponding-source-$id
mkdir -p "$out/pack/$name"
cp "$src"/* "$out/pack/$name/"
{ echo "Corresponding source of the third-party components of these Enclave guest domain releases:"
  for r in "$@"; do echo "  release id $r"; done
  echo
  echo "Each file's sha256 is in SHA256SUMS. What each file is, and how to rebuild the binaries from it, is in the"
  echo "release tarball's SOURCES.md and INVENTORY.md."
} > "$out/pack/$name/README.txt"
chmod 0644 "$out/pack/$name"/*
(cd "$out/pack" && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=posix \
   --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime -cf "$out/$name.tar" "$name")
rm -rf "$out/pack"
(cd "$out" && sha256sum "$name.tar" > "$name.tar.sha256" && cat "$name.tar.sha256")
