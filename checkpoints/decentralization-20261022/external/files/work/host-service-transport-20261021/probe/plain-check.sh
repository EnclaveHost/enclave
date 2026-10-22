#!/bin/bash
# the rev4 PLAIN provider table (with the static DNS gate) loads on this kernel (private user+net namespace)
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
unshare -r -n -- bash -euo pipefail -c "nft -f '$H/native-g2/frozen/ruleset-plain.nft' && nft list chain inet enclave_net forward | sed -n '2,4p' && echo PLAIN-REV4-LOADED"
