#!/bin/bash
# nft acceptance of the provider rulesets by the real kernel, in a private user+network namespace (no root, no host change)
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
unshare -r -n -- bash -euo pipefail -c "
nft -f '$D/ruleset-plain.nft'; echo PLAIN-LOADED; nft flush ruleset
nft -c -f '$D/ruleset-dns.nft'; echo DNS-CHECKED
nft -f '$D/ruleset-dns.nft'; echo DNS-LOADED
nft list table inet enclave_net | grep -E 'dns|limit|count' "
