#!/bin/sh
# Cut a per-app-tier DOMAIN RELEASE from an image commit, the way release 79c5ecf2 (aa6c985c) was cut: init linked
# against musl, the production front, reproducible. It builds TWICE from a clean worktree (the second time with a cold
# Go cache) and requires the two to be byte-identical, then checks the third-party bytes against the reference release.
# It installs nothing, deploys nothing and publishes nothing: the release directory it writes is for the predictor
# (enclave-e3) and for the publication artifact (make-artifact.sh), and the box install is someone else's step.
#
#   usage: cut-release.sh <image commit> <outdir> [--musl-prefix <dir>] [--firmware <OVMF.amdsev.fd>]
#                         [--reference <release dir> --reference-id <id>]
#
# Defaults: musl is built into <outdir>/musl by the commit's own isolation/m2/build-musl.sh (source sha256 and release
# signature checked); the firmware is the cached one m1/domain.env names; the reference is the rollback release 5c3561f9
# (0181bce3). Output: <outdir>/release-<commit8> (the release), <outdir>/rebuild (the second build, kept for review),
# <outdir>/CUT.txt (id, commit, toolchain, the comparisons).
set -e
umask 022
commit=${1:?usage: cut-release.sh <image commit> <outdir> [--musl-prefix dir] [--firmware fd] [--reference dir --reference-id id]}
out=${2:?usage: cut-release.sh <image commit> <outdir> [--musl-prefix dir] [--firmware fd] [--reference dir --reference-id id]}
shift 2
musl= fw= ref="$HOME/enclave-prod/release-0181bce3" refid=5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2
while [ $# -gt 0 ]; do
  case "$1" in
    --musl-prefix) musl=$2; shift 2 ;;
    --firmware) fw=$2; shift 2 ;;
    --reference) ref=$2; shift 2 ;;
    --reference-id) refid=$2; shift 2 ;;
    *) echo "cut-release.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
full=$(git -C "$repo" rev-parse --verify "$commit^{commit}")
c8=$(echo "$full" | cut -c1-8)
[ ! -e "$out" ] || [ -z "$(ls -A "$out")" ] || { echo "cut-release.sh: $out is not empty" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)
log="$out/CUT.txt"
say() { echo "$*" | tee -a "$log"; }

say "== image commit $full"
git -C "$repo" worktree add -q --detach "$out/src" "$full"
trap 'git -C "$repo" worktree remove --force "$out/src" 2>/dev/null || true' EXIT
[ -z "$(git -C "$out/src" status --porcelain)" ] || { echo "cut-release.sh: the worktree is not clean" >&2; exit 1; }
[ -f "$out/src/isolation/m2/build-musl.sh" ] || { echo "cut-release.sh: $c8 has no isolation/m2/build-musl.sh: not a musl-init commit" >&2; exit 2; }

if [ -z "$musl" ]; then
  say "== musl, by $c8's own build-musl.sh"
  sh "$out/src/isolation/m2/build-musl.sh" "$out/musl" | tee -a "$log"
  musl="$out/musl"
fi
musl=$(cd "$musl" && pwd)
say "musl prefix $musl: $(grep -E '^(musl|sha256|signature|libc.a)' "$musl/SOURCE" | tr '\n' ';')"

# a PRODUCTION front and init, whatever the caller's environment says
unset ISOLATION_LAB_FRONT; export GOFLAGS= GOTOOLCHAIN=local MUSL_PREFIX="$musl"
[ -z "$fw" ] || export OVMF="$(cd "$(dirname "$fw")" && pwd)/$(basename "$fw")"

build() { # dir gocache
  (cd "$out/src" && GOCACHE="$2" sh isolation/m4/domain-release.sh "$1") | awk '/^release /{print $2}'
}
say "== build 1"
id1=$(build "$out/release-$c8" "$out/gocache-1")
say "== build 2 (cold Go cache)"
id2=$(build "$out/rebuild" "$out/gocache-2")
rm -rf "$out/gocache-1" "$out/gocache-2"
say "build 1: release $id1"
say "build 2: release $id2"
[ -n "$id1" ] && [ "$id1" = "$id2" ] || { say "DIFFERENT: the two builds give different ids"; exit 1; }
(cd "$out/release-$c8" && find . -printf '%y %m %p\n' | LC_ALL=C sort -k3; find . -type f | LC_ALL=C sort | xargs sha256sum) > "$out/b1.txt"
(cd "$out/rebuild" && find . -printf '%y %m %p\n' | LC_ALL=C sort -k3; find . -type f | LC_ALL=C sort | xargs sha256sum) > "$out/b2.txt"
cmp -s "$out/b1.txt" "$out/b2.txt" || { say "DIFFERENT: the two builds differ in a file, the tree or a mode"; diff "$out/b1.txt" "$out/b2.txt" | head -20; exit 1; }
say "REPRODUCED: the two builds are byte-identical (every file, the tree, the modes)"
python3 "$out/src/isolation/m4/release-manifest.py" verify "$out/release-$c8" --expect "$id1" | tee -a "$log"

say "== third-party bytes against the reference $refid"
python3 "$here/check-third-party.py" "$out/release-$c8" --expect "$id1" "$ref" --reference-id "$refid" | tee -a "$log"

say "== toolchain"
say "go: $(go version); gcc: $(gcc --version | head -1)"
say "packages: $(pacman -Q linux glibc gcc libgcc go wasmtime 2>/dev/null | tr '\n' ';')"
say "RELEASE $id1 image commit $full dir $out/release-$c8"
say "next: enclave-e3 predicts and admits it; make-artifact.sh $c8 <outdir> --expect $out/release-$c8 --notices <notes dir> for the publication artifact"
