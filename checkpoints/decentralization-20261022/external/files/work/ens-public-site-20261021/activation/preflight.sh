#!/usr/bin/env bash
# READ-ONLY preflight of the four fronts: (1) each front over ssh (front-readonly.sh); (2) each front's PUBLIC answers
# for ipfs.enclave.host via --resolve to that front's IP (GET/HEAD only, HTTP/2): the probe path, the root block, a child
# block, the CAR, an unrelated CID, and the front's site-root. Bounded timeouts. Writes preflight/<alias>.txt.
set -u
cd "$(dirname "$0")"; mkdir -p preflight
declare -A IP=([us-west]=134.199.235.187 [eu-central]=134.209.248.172 [ap-southeast]=165.245.191.129 [ca-east]=146.190.246.39)
ROOT=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou; CHILD=bafkreih6jphyfe2ustt2byckoodtngsv4o5pcm3va45gujfmpuxac3hwfu
OTHER=bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy   # sha256("hello world\n") raw: not a site block
for a in us-west ca-east ap-southeast eu-central; do
  o=preflight/$a.txt; echo "at=$(date -u +%FT%TZ) alias=$a ip=${IP[$a]}" > $o
  timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=15 $a 'bash -s' < front-readonly.sh >> $o 2>&1; echo "ssh_rc=$?" >> $o
  for spec in "probe_head|HEAD|/ipfs/bafkqaaa?format=raw|raw" "probe_get|GET|/ipfs/bafkqaaa?format=raw|raw" "root_raw|GET|/ipfs/$ROOT?format=raw|raw" \
              "child_raw|GET|/ipfs/$CHILD?format=raw|raw" "child_accept|GET|/ipfs/$CHILD|raw" "car|GET|/ipfs/$ROOT?format=car|car" "other_raw|GET|/ipfs/$OTHER?format=raw|raw" "site_root|GET|/site-root|-"; do
    IFS='|' read -r name m p acc <<< "$spec"
    h=(); [ "$acc" = raw ] && h=(-H 'Accept: application/vnd.ipld.raw'); [ "$acc" = car ] && h=(-H 'Accept: application/vnd.ipld.car')
    f=$(mktemp); if [ "$m" = HEAD ]; then extra=(-I); else extra=(); fi
    r=$(curl -sS --http2 "${extra[@]}" --max-time 30 --resolve "ipfs.enclave.host:443:${IP[$a]}" "${h[@]}" -o "$f" -D /tmp/pfh.$$ -w '%{http_code} h%{http_version} %{size_download}' "https://ipfs.enclave.host$p" 2>&1)
    srv=$(grep -i '^server:' /tmp/pfh.$$ 2>/dev/null | tr -d '\r' | cut -c9- | head -1); ct=$(grep -i '^content-type:' /tmp/pfh.$$ 2>/dev/null | tr -d '\r' | cut -c15- | head -1)
    echo "http_$name=$r sha256=$(sha256sum $f | cut -c1-64) server=$srv ctype=$ct" >> $o; rm -f "$f" /tmp/pfh.$$
  done
done
echo done
