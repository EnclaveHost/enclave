#!/usr/bin/env bash
# Install a pinned, checksum-verified tinfoil-cli into ~/.local/bin if the
# binary is not already on PATH. Shared by tinfoil-update-fleet.sh and
# autoscale.yml — these run holding a Tinfoil admin key, so no `curl | sh`
# of a moving branch. Bump CLI_VERSION and the checksums together.
set -euo pipefail

CLI_VERSION=0.14.7

command -v tinfoil >/dev/null && exit 0

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS $(uname -s)" >&2; exit 2 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 2 ;; esac
plat="${os}_${arch}"
case "$plat" in
  linux_amd64)  sum=5092dff20b5b34af7958d7dbebd5427566beda27e9a6d6a4fccbee31b8187b3b ;;
  linux_arm64)  sum=e1fb893c0d6392aee936a1fb046c15f6125e4d9dd6faad4fd7ed5a066235c281 ;;
  darwin_amd64) sum=1fd2de7d876d726cc0c5f46169f0d60a1f62ca420ed144eee433167edd106f03 ;;
  darwin_arm64) sum=9464bc2f4018e16f118d24d3e28688039be8aea63d3b8372fdbb7fbba8afa57a ;;
esac

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
curl -fsSL -o "$dir/cli.tar.gz" \
  "https://github.com/tinfoilsh/tinfoil-cli/releases/download/v${CLI_VERSION}/tinfoil-cli_${CLI_VERSION}_${plat}.tar.gz"
if command -v sha256sum >/dev/null; then
  echo "$sum  $dir/cli.tar.gz" | sha256sum -c - >/dev/null
else
  echo "$sum  $dir/cli.tar.gz" | shasum -a 256 -c - >/dev/null
fi
tar -xzf "$dir/cli.tar.gz" -C "$dir" tinfoil
mkdir -p "$HOME/.local/bin"
install -m 0755 "$dir/tinfoil" "$HOME/.local/bin/tinfoil"
echo "installed tinfoil-cli v${CLI_VERSION} (${plat}) to $HOME/.local/bin"
