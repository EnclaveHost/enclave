#!/bin/sh
# musl, for the per-app guest's init (m2/dominit.c, linked by m4/app-image-template.sh): a NON-COPYLEFT libc (MIT) for
# the one static binary Enclave links itself (Codex, 2026-09-25; Enclave's LICENSE unchanged). Built from a PINNED
# source, checked twice - its sha256, and musl's release signature by the key whose fingerprint is pinned below - into
# this user's cache, like the verifying firmware (build-verifying-firmware.sh). No host package is installed and nothing
# outside the prefix is written.
#
#   usage: sh isolation/m2/build-musl.sh [prefix]     (default $HOME/.cache/enclave-isolation/musl-1.2.6)
#
# The prefix then holds lib/libc.a, the crt objects, include/ and lib/musl-gcc.specs (the compiler driver's view of
# musl), plus COPYRIGHT (musl's MIT licence text) and SOURCE (what was built, from what, with what). The compiler is
# the host's /usr/bin/gcc, named explicitly: the image's init bytes are a function of musl's source AND that gcc, and
# guestd's rebuild of the template is held to the release's bytes by the install's reproduction gate (1d), so a gcc
# that changed fails there, closed.
set -e
V=1.2.6
URL=https://musl.libc.org/releases/musl-$V.tar.gz
SHA=d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a
FPR=836489290BB6B70F99FFDA0556BCDB593020450F   # musl libc <musl@libc.org>, the release key (https://musl.libc.org/musl.pub)
CC_REAL=/usr/bin/gcc
PREFIX=${1:-${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-$V}}
[ ! -e "$PREFIX" ] || { echo "build-musl.sh: $PREFIX exists; a prefix is built once (remove it to rebuild)" >&2; exit 2; }
[ -x "$CC_REAL" ] || { echo "build-musl.sh: no $CC_REAL" >&2; exit 2; }
w=$(mktemp -d)
trap 'rm -rf "$w"' EXIT
curl -sfSL -o "$w/musl.tar.gz" "$URL"
curl -sfSL -o "$w/musl.tar.gz.asc" "$URL.asc"
curl -sfSL -o "$w/musl.pub" https://musl.libc.org/musl.pub
echo "$SHA  $w/musl.tar.gz" | sha256sum -c --quiet || { echo "build-musl.sh: the tarball is not the pinned one" >&2; exit 1; }
export GNUPGHOME="$w/gnupg"; mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import "$w/musl.pub" 2>/dev/null
gpg --batch --with-colons --fingerprint | grep -q "^fpr:::::::::$FPR:" || { echo "build-musl.sh: the signing key is not the pinned one" >&2; exit 1; }
gpg --batch --status-fd 1 --verify "$w/musl.tar.gz.asc" "$w/musl.tar.gz" 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG $FPR " \
  || { echo "build-musl.sh: the signature does not verify under the pinned key" >&2; exit 1; }
tar -xzf "$w/musl.tar.gz" -C "$w"
cd "$w/musl-$V"
# static only: init is the one consumer, and a shared musl would put a loader in the prefix nothing may use
CC=$CC_REAL ./configure --prefix="$PREFIX" --disable-shared > "$w/configure.log" 2>&1 || { cat "$w/configure.log" >&2; exit 1; }
make -j"$(nproc)" > "$w/make.log" 2>&1 || { tail -30 "$w/make.log" >&2; exit 1; }
make install > "$w/install.log" 2>&1
cp COPYRIGHT "$PREFIX/COPYRIGHT"
{ echo "musl $V"
  echo "source $URL"
  echo "sha256 $SHA"
  echo "signature VALIDSIG by $FPR"
  echo "configure CC=$CC_REAL --prefix=<prefix> --disable-shared"
  echo "compiler $($CC_REAL --version | head -1)"
  echo "libc.a sha256 $(sha256sum "$PREFIX/lib/libc.a" | cut -c1-64)"
} > "$PREFIX/SOURCE"
cat "$PREFIX/SOURCE"
