#!/bin/bash
# Run deploy.yml's own detect `case` block (extracted verbatim) over path lists
# and print whether each path sets wasm=true. Usage:
#   simulate-deploy-detect.sh DEPLOY_YML PATH...
yml=$1; shift
block=$(awk '/case "\$f" in/{on=1} on{print} /^ *esac$/{if(on){exit}}' "$yml")
[ -n "$block" ] || { echo "no case block found in $yml"; exit 2; }
for f in "$@"; do
  eval "site=false relay=false registry=false deployments=false catalog=false enclavepay=false paymentrouter=false sup=false worker=false mps=false wasm=false metal=false config_touched=false
$block"
  printf '  wasm=%-5s %s\n' "$wasm" "$f"
done
