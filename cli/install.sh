#!/bin/sh
# enclave CLI installer (Linux/macOS). Two ways in, same artifact out:
#
#   curl -fsSL https://get.enclave.host | sh          # hosted one-liner (also: enclave.host/install.sh)
#   ./cli/install.sh                                   # from a checkout
#   PREFIX=/usr/local ./cli/install.sh
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into a single executable and drops it
# on your PATH. This is a KEY-HOLDING signing binary, so the hosted mode does
# NOT build the moving branch tip: it downloads a PINNED release tarball plus its
# SHA256SUMS and REFUSES to build unless the checksum matches. Pin an exact tag
# with ENCLAVE_CLI_VERSION=cli-vX.Y.Z; unset resolves the latest cli-* release.
#
# BE HONEST ABOUT WHAT THAT CHECKSUM PROVES. SHA256SUMS ships from the SAME
# release as the tarball, so it establishes that you got the bytes the release
# holds — transport corruption, a lying mirror, a truncated download. It does
# NOT defend against whoever can PUBLISH a release (a stolen token, a
# compromised maintainer account): they write both files.
#
# A detached SIGNATURE over SHA256SUMS closes that, and the machinery is here:
# set ENCLAVE_RELEASE_PUBKEY below and this script REQUIRES a valid signature by
# that key before it will build. It is empty until the project's release key
# exists (scripts/release-key.mjs gen), and while empty this script says so on
# every run rather than implying a guarantee it is not making. The key is PINNED
# here, never fetched — a key downloaded from the same host as the artifact
# proves nothing.
#
# What you CAN do today, with no key involved: the release assets are
# `git archive` of the tag, which is byte-deterministic, so anyone with a clone
# can reproduce them and tie the artifact to the git history instead of to
# whoever uploaded it (verified against the live cli-v1.1.0 release):
#
#   git fetch --tags && git tag -v <tag>     # if the tag is signed
#   git archive --format=tar.gz --prefix=enclave-<tag>/ <tag> | sha256sum
#
# That hash must equal the tarball line in the release's SHA256SUMS.
# ENCLAVE_CLI_CHANNEL=edge is an explicit, UNVERIFIED escape hatch that builds the
# current main tip (dev only). No prebuilt binary is ever downloaded.
#
# Needs node >= 20 and npm; hosted mode also needs tar and curl or wget.
# Windows: irm https://get.enclave.host/install.ps1 | iex  (or npm install -g ./cli)
set -eu

# Ed25519 public key (base64, 32 raw bytes) whose signature over SHA256SUMS is
# REQUIRED before a hosted install will build. Empty = unsigned releases are
# accepted with a loud warning, which is where this started. Fill it from
# `node scripts/release-key.mjs gen` and keep the private half off CI.
ENCLAVE_RELEASE_PUBKEY="${ENCLAVE_RELEASE_PUBKEY:-}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 1; }; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "error: curl or wget is required" >&2; exit 1
  fi
}

# fetch to a file, failing the script (set -e) on any HTTP/transport error.
fetch_to() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "error: curl or wget is required" >&2; exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "error: sha256sum or shasum is required to verify the download" >&2; exit 1
  fi
}

main() {
  need node
  node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
    || { echo "error: node >= 20 required (found $(node -v))" >&2; exit 1; }

  # checkout mode: this script sits in cli/ next to enclave.mjs. Piped through
  # `curl | sh` there is no script path, so fetch the repo and build from that.
  CLI_DIR="$(cd "$(dirname -- "$0")" 2>/dev/null && pwd || true)"
  TMP=""
  if [ ! -f "$CLI_DIR/enclave.mjs" ]; then
    need tar; need npm
    GH="https://github.com/EnclaveHost/enclave"
    API="https://api.github.com/repos/EnclaveHost/enclave"
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/enclave-install.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT INT TERM

    if [ "${ENCLAVE_CLI_CHANNEL:-}" = "edge" ]; then
      # explicit, UNVERIFIED dev path: build the current main tip, no checksum.
      echo "WARNING: ENCLAVE_CLI_CHANNEL=edge builds the UNVERIFIED main tip (no checksum). Dev use only." >&2
      fetch "$GH/archive/refs/heads/main.tar.gz" | tar -xzf - -C "$TMP"
    else
      # pinned + checksum-verified release. ENCLAVE_CLI_VERSION pins an exact tag;
      # unset resolves the latest cli-* release. Resolution uses the tag-prefix
      # refs API, NOT /releases: that endpoint only returns the newest page of
      # releases, and enclave (non-CLI) releases land many per day, so the
      # latest cli-* release is quickly buried pages deep.
      ver="${ENCLAVE_CLI_VERSION:-}"
      if [ -z "$ver" ]; then
        ver="$(fetch "$API/git/matching-refs/tags/cli-v" 2>/dev/null \
          | grep -o '"refs/tags/cli-v[0-9][^"]*"' \
          | sed -nE 's|^"refs/tags/cli-v([0-9]+)\.([0-9]+)\.([0-9]+)"$|\1 \2 \3 cli-v\1.\2.\3|p' \
          | sort -k1,1n -k2,2n -k3,3n | awk 'END{print $4}' || true)"
        [ -n "$ver" ] || { echo "error: no cli-* release found (and ENCLAVE_CLI_VERSION unset). Set ENCLAVE_CLI_VERSION=cli-vX.Y.Z, or ENCLAVE_CLI_CHANNEL=edge for an unverified dev build." >&2; exit 1; }
      fi
      base="$GH/releases/download/$ver"
      tarname="enclave-cli-$ver.tar.gz"
      echo "fetching $ver (checksum-verified)…"
      fetch_to "$base/$tarname"    "$TMP/cli.tar.gz"
      fetch_to "$base/SHA256SUMS"  "$TMP/SHA256SUMS"
      # Signature first: the checksum below is only as trustworthy as the file
      # it is read from, so establish WHO wrote SHA256SUMS before believing what
      # it says about the tarball.
      if [ -n "$ENCLAVE_RELEASE_PUBKEY" ]; then
        fetch_to "$base/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" \
          || { echo "error: $ver publishes no SHA256SUMS.sig, but this installer pins a release key — refusing to build" >&2; exit 1; }
        # Inlined ON PURPOSE. The verifier cannot come from the tarball it is
        # verifying, and this script is what the user actually fetched, so the
        # check has to live here. cli/verify-sig.mjs is the same algorithm as a
        # readable module for release-cli.sh and the tests, and
        # test/release-signing.test.mjs runs BOTH over the same vectors so the
        # two copies cannot drift apart.
        node -e 'const f=require("fs"),c=require("crypto");const a=process.argv.slice(1);const r=Buffer.from(a[2].trim(),"base64");const k=c.createPublicKey({key:r.length===32?Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),r]):r,format:"der",type:"spki"});if(k.asymmetricKeyType!=="ed25519")process.exit(1);const t=f.readFileSync(a[1]);const s=t.length===64?t:Buffer.from(t.toString("utf8").trim(),"base64");if(s.length!==64)process.exit(1);process.exit(c.verify(null,f.readFileSync(a[0]),k,s)?0:1);' \
          "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig" "$ENCLAVE_RELEASE_PUBKEY" \
          || { echo "error: SHA256SUMS for $ver is not signed by the pinned release key — refusing to build" >&2; exit 1; }
        echo "  signature ok (pinned release key)"
      else
        echo "  NOTE: no release key pinned in this installer, so SHA256SUMS is trusted as published." >&2
        echo "        It proves the bytes match the release, NOT who published it. Reproduce instead:" >&2
        echo "        git archive --format=tar.gz --prefix=enclave-$ver/ $ver | sha256sum" >&2
      fi
      want="$(awk -v f="$tarname" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS")"
      got="$(sha256_of "$TMP/cli.tar.gz")"
      [ -n "$want" ] && [ "$want" = "$got" ] || { echo "error: checksum mismatch for $ver (want=$want got=$got) — refusing to build" >&2; exit 1; }
      tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
    fi

    set -- "$TMP"/*/cli
    CLI_DIR="$1"
    [ -f "$CLI_DIR/enclave.mjs" ] || { echo "error: download did not contain cli/enclave.mjs" >&2; exit 1; }
  fi

  BIN_DIR="${PREFIX:-$HOME/.local}/bin"
  OUT="$BIN_DIR/enclave"

  # bundle deps: the repo root has them; a bare checkout of cli/ installs its own
  if [ ! -d "$CLI_DIR/../node_modules/viem" ] && [ ! -d "$CLI_DIR/node_modules/viem" ]; then
    need npm
    echo "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)…"
    # Prefer `npm ci` — it installs the EXACT versions from the checked-in
    # package-lock.json (this is a key-holding signing binary; floating caret
    # ranges have no place in it). Fall back to `npm install` only if the lockfile
    # is missing (e.g. an old checkout).
    if [ -f "$CLI_DIR/package-lock.json" ]; then
      npm --prefix "$CLI_DIR" ci --no-fund --no-audit
    else
      echo "note: no package-lock.json found — falling back to 'npm install' (unpinned)" >&2
      npm --prefix "$CLI_DIR" install --no-fund --no-audit
    fi
  fi

  mkdir -p "$BIN_DIR"
  node "$CLI_DIR/build.mjs" "$OUT"

  echo "installed $OUT"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not on your PATH" ;; esac
  "$OUT" version >/dev/null && echo "try: enclave help"
}

# the function wrapper forces sh to read the whole script before running any of
# it - piped installs would otherwise race commands below against the download
# (a command that reads stdin would eat the rest of the script).
main "$@" </dev/null
