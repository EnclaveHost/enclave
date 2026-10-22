#!/usr/bin/env bash
for h in ap-southeast us-west; do echo "=== $h"; timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 $h 'systemctl list-units --type=service --state=running --no-pager --plain | grep -iE "enclave|wg|relay|dns|router|provider" | cut -c1-120' ; done
