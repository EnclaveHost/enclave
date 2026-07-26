#!/usr/bin/env bash
# release-cli.sh — cut a PINNED, CHECKSUMMED CLI release.
#
# The `curl … | sh` / `irm … | iex` installers (cli/install.sh, cli/install.ps1)
# no longer build the moving main tip: they download a release tarball/zipball
# plus its SHA256SUMS and refuse to build unless the checksum matches. This
# script produces exactly those assets and publishes the GitHub release.
#
#   ./scripts/release-cli.sh cli-v0.5.0            # tag (created from HEAD if absent) + release
#   TAG_FROM=<ref> ./scripts/release-cli.sh cli-v0.5.0
#   DRY_RUN=1 ./scripts/release-cli.sh cli-v0.5.0  # build assets locally, no tag/push/release
#
# Deterministic: assets come from `git archive` of the TAG (not GitHub's
# auto-archives, which aren't byte-stable), prefixed enclave-<tag>/ so the
# installers' `*/cli` glob resolves. Auth: `gh` logged in with repo write.
#
# After releasing, bump the installers' default if you pin an exact version
# (they otherwise resolve the latest cli-* release automatically), and redeploy
# the hosted install.sh/install.ps1 to get.enclave.host.
set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: $0 <tag>  (e.g. cli-v0.5.0)" >&2; exit 1; }
case "$TAG" in cli-*) ;; *) echo "error: tag must start with 'cli-' (installers resolve latest cli-* release)" >&2; exit 1;; esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
DRY_RUN="${DRY_RUN:-0}"
TAG_FROM="${TAG_FROM:-HEAD}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
say(){ printf '\033[1;36m[release-cli]\033[0m %s\n' "$*"; }

# Create the tag if it doesn't exist yet (annotated, from TAG_FROM).
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY_RUN: would create tag $TAG from $TAG_FROM"; REF="$TAG_FROM"
  else
    # SIGN the tag when a signing key is configured. The release assets are
    # git archive of this tag, so a signed tag is the one artifact an attacker
    # who can publish a GitHub release still cannot forge — SHA256SUMS ships
    # from the same release as the tarball and proves nothing against them.
    if git config --get user.signingkey >/dev/null 2>&1; then
      say "creating SIGNED tag $TAG from $TAG_FROM"
      git tag -s "$TAG" "$TAG_FROM" -m "enclave CLI $TAG"
    else
      say "creating tag $TAG from $TAG_FROM (UNSIGNED — set user.signingkey to sign it)"
      git tag -a "$TAG" "$TAG_FROM" -m "enclave CLI $TAG"
    fi
    REF="$TAG"
  fi
else
  REF="$TAG"
fi

TARBALL="enclave-cli-$TAG.tar.gz"
ZIPBALL="enclave-cli-$TAG.zip"
say "git archive -> $TARBALL + $ZIPBALL (prefix enclave-$TAG/)"
git archive --format=tar.gz --prefix="enclave-$TAG/" "$REF" -o "$OUT/$TARBALL"
git archive --format=zip    --prefix="enclave-$TAG/" "$REF" -o "$OUT/$ZIPBALL"

say "SHA256SUMS"
( cd "$OUT" && sha256sum "$TARBALL" "$ZIPBALL" > SHA256SUMS && cat SHA256SUMS )

# Detached Ed25519 signature over SHA256SUMS. This is the part a stolen publish
# token cannot forge: the checksum file ships from the same release as the
# tarball, so whoever can publish writes both. ENCLAVE_RELEASE_KEY points at the
# PRIVATE key (scripts/release-key.mjs gen) and must NOT live in CI - the whole
# value is that it is somewhere a compromised runner is not.
SIGNED=0
if [ -n "${ENCLAVE_RELEASE_KEY:-}" ]; then
  [ -f "$ENCLAVE_RELEASE_KEY" ] || { echo "error: ENCLAVE_RELEASE_KEY=$ENCLAVE_RELEASE_KEY does not exist" >&2; exit 1; }
  say "signing SHA256SUMS"
  node "$REPO_ROOT/scripts/release-key.mjs" sign "$ENCLAVE_RELEASE_KEY" "$OUT/SHA256SUMS" >/dev/null
  PUB="$(node "$REPO_ROOT/scripts/release-key.mjs" pub "$ENCLAVE_RELEASE_KEY")"
  # verify what we are about to publish, with the same code the installer runs
  node "$REPO_ROOT/cli/verify-sig.mjs" "$OUT/SHA256SUMS" "$OUT/SHA256SUMS.sig" "$PUB" \
    || { echo "error: the signature we just produced does not verify — refusing to publish" >&2; exit 1; }
  # and refuse to ship a signature the SHIPPED installers will reject
  PINNED="$(sed -n 's/^ENCLAVE_RELEASE_PUBKEY="${ENCLAVE_RELEASE_PUBKEY:-\(.*\)}"$/\1/p' "$REPO_ROOT/cli/install.sh")"
  if [ -n "$PINNED" ] && [ "$PINNED" != "$PUB" ]; then
    echo "error: signing key ($PUB) is not the key pinned in cli/install.sh ($PINNED)" >&2
    echo "       every installer in the wild would refuse this release. Update the pin deliberately." >&2
    exit 1
  fi
  [ -n "$PINNED" ] || say "NOTE: cli/install.sh pins no key yet, so installers will not check this signature"
  SIGNED=1
else
  say "NOT SIGNING (ENCLAVE_RELEASE_KEY unset) — SHA256SUMS will ship unsigned"
fi

if [ "$DRY_RUN" = "1" ]; then
  say "DRY_RUN: built assets (not published), left for inspection:"
  DEST="${TMPDIR:-/tmp}/enclave-cli-$TAG"
  mkdir -p "$DEST"; cp "$OUT/$TARBALL" "$OUT/$ZIPBALL" "$OUT/SHA256SUMS" "$DEST/"
  [ "$SIGNED" = "1" ] && cp "$OUT/SHA256SUMS.sig" "$DEST/"
  ls -l "$DEST"
  exit 0
fi

command -v gh >/dev/null || { echo "error: gh CLI required to publish the release" >&2; exit 1; }
git push origin "$TAG"
say "gh release create $TAG"
# --prerelease is LOAD-BEARING: the Tinfoil verifier resolves this repo's
# /releases/latest for tinfoil.hash, and a CLI release sitting there (no such
# asset) breaks attestation verification platform-wide until the next enclave
# release buries it. Prereleases are excluded from /releases/latest; the
# installers are unaffected (they resolve cli-* TAGS via git/matching-refs).
# shellcheck disable=SC2086 # $SIG_ASSET is deliberately word-split (empty = omit)
SIG_ASSET=""
[ "$SIGNED" = "1" ] && SIG_ASSET="$OUT/SHA256SUMS.sig"
gh release create "$TAG" "$OUT/$TARBALL" "$OUT/$ZIPBALL" "$OUT/SHA256SUMS" $SIG_ASSET \
  --prerelease \
  --title "enclave CLI $TAG" \
  --notes "$(cat <<NOTES
Pinned CLI release. Install: \`curl -fsSL https://get.enclave.host | sh\` (resolves the latest cli-* release and checks SHA256SUMS before building).

**What that checksum does and does not prove.** SHA256SUMS ships from this same
release, so it establishes you got the bytes the release holds — a truncated
download, a lying mirror. It is not a defence against whoever can publish a
release here, because they would write both files.

**The independent check.** These assets are \`git archive\` of the tag, which is
byte-deterministic. Reproduce them from a clone and compare:

\`\`\`
git fetch --tags && git tag -v $TAG          # if the tag is signed
git archive --format=tar.gz --prefix=enclave-$TAG/ $TAG | sha256sum
\`\`\`

That hash must equal the \`$TARBALL\` line in SHA256SUMS. It ties the artifact to
the git history rather than to whoever uploaded it.
NOTES
)"
say "done: $TAG published with $TARBALL, $ZIPBALL, SHA256SUMS"
