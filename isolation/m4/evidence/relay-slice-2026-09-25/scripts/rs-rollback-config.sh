#!/usr/bin/env bash
# Config rollback: remove EXACTLY the 11 appended lines (line-wise, never the whole file: the file must equal the backup
# plus those lines), remove predict.conf, daemon-reload, restart the api-relay. The predictor is then off: expected-guest
# 503, release 503. Code rollback is rs-rollback-code.sh.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
STAMP=$(cat $RS/stamp.txt); BAK=$ENVF.bak-slice-$STAMP
$NAN "set -euo pipefail; ENVF=$ENVF; BAK=$BAK; DROPIN=$DROPIN; LINES_SHA=$LINES_SHA
  n0=\$(wc -l < \$BAK); n=\$(wc -l < \$ENVF)
  if [ \$n -eq \$((n0+11)) ] && head -n \$n0 \$ENVF | cmp -s - \$BAK && [ \"\$(tail -n 11 \$ENVF | sha256sum | cut -c1-64)\" = \$LINES_SHA ]; then
    ( umask 077; head -n \$n0 \$ENVF > \$ENVF.new ); chmod 600 \$ENVF.new; mv \$ENVF.new \$ENVF; echo 'env: the 11 lines removed'
  elif cmp -s \$ENVF \$BAK; then echo 'env: already the backup'
  else echo 'REFUSING: the env file is neither the backup nor the backup + the 11 lines: resolve by hand'; exit 3; fi
  rm -f \$DROPIN; systemctl daemon-reload; systemctl restart enclave-api-relay; sleep 3
  systemctl is-active enclave-api-relay; grep -cE '^SECRETS_(RELEASE|ATTESTED)' \$ENVF || true"
say "config rolled back on nan (env line-wise, drop-in removed, api-relay restarted)"
