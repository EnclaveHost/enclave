#!/bin/bash
# the scenario matrix against <site root> (default: this tree's site/); development probe for site-browser-rpc-closure
set -uo pipefail
cd "$(dirname "$0")/../repo"
root=${1:-site}
for s in '{"state":"on","book":true}' '{"state":"on","down":[0]}' '{"state":"on","down":[0,1,2]}' '{"state":"invalid","badProfile":true}' \
  '{"state":"unconfirmed"}' '{"state":"changed","sessions":true}' '{"state":"off","sessions":true}' '{"state":"appeared"}' \
  '{"state":"on","book":true,"rpcs":4,"quorum":3,"down":[0]}' '{"state":"on","book":true,"rpcs":4,"quorum":3,"downAfterLoad":[0,1]}'; do
  echo "### $s"; timeout -k 5 90 node test/helpers/browser-rpc-scenario.mjs "$root" "$s" 2>&1 | tail -c 4000; echo "rc=$?"
done
