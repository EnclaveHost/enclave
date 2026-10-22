#!/usr/bin/env bash
# READ-ONLY on each front: the resolver lines of /etc/resolv.conf (nameserver/search/options only), the systemd-resolved
# upstream (if any), and what the front itself resolves 7ae476a3.app.enclave.host to, 5 times 2 s apart (getent, the
# libc path Caddy's Go resolver mirrors). No config bodies.
date -u +%FT%TZ
for h in eu-central us-west ap-southeast ca-east; do
  echo "== $h"
  timeout 60 ssh -n -o BatchMode=yes -o ConnectTimeout=15 $h 'grep -E "^(nameserver|search|options)" /etc/resolv.conf | tr "\n" ";"; echo; (resolvectl dns 2>/dev/null | head -3 | tr "\n" ";"); echo; for i in 1 2 3 4 5; do printf "%s " "$(getent ahostsv4 7ae476a3.app.enclave.host | awk "{print \$1}" | sort -u | tr "\n" ",")"; sleep 2; done; echo'
done
