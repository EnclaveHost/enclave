#!/usr/bin/env bash
# READ-ONLY public acceptance (root runs it after the fronts are ACTIVE; through the queue, 256). GET/HEAD only, HTTP/2,
# bounded. Per front (--resolve to each public IP): the probe path, root, dag-pb child, raw child, CAR. Then through
# DNS: ipfs.enclave.host, and the public gateways a visitor would use (Rainbow: dweb.link/ipfs.io; ENS: eth.limo/eth.link).
# Prints one line per check; exit 0 only if every front check passes (gateway checks are reported, see RESULT.txt).
set -u
ROOT=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou; PB=bafybeihfvjxr5eyx6ux3yj5gefhi4wkex2haf4xxe7qgoc3ycwqiwcdyke
RAW=bafkreih6jphyfe2ustt2byckoodtngsv4o5pcm3va45gujfmpuxac3hwfu; IDX=fe4bcf82935494e7a0e04a7387369a55e3baf13375073a6a24ac7d2e016cf62d
declare -A IP=([us-west]=134.199.235.187 [ca-east]=146.190.246.39 [ap-southeast]=165.245.191.129 [eu-central]=134.209.248.172)
declare -A WANT=([probe]="200 2 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" [root]="200 2 1680 94bcfd5c735c335930f48ef3098f5fafedc34d31f1e5d48b573ae882474f2075"
  [pb]="200 2 120 e5aa6f1e9317f52fbc27a6214e8e5944be8e02f2f727e0670b7815a08b087851" [raw]="200 2 41718 $IDX" [car]="200 2 35127042 ad7867eccffd23f2e4e874a5149c4c904e5acc8d5ded367cb561dbec6845f0d9")
get() {  # url [curl args...] -> "status httpver bytes sha256"
  local u=$1; shift; local f; f=$(mktemp)
  local r; r=$(curl -sS --http2 --max-time 60 -o "$f" -w '%{http_code} %{http_version} %{size_download}' "$@" "$u" 2>/dev/null || echo "000 0 0")
  echo "$r $(sha256sum "$f" | cut -c1-64)"; rm -f "$f"
}
fail=0
for a in us-west ca-east ap-southeast eu-central; do
  R=(--resolve "ipfs.enclave.host:443:${IP[$a]}" -H 'Accept: application/vnd.ipld.raw')
  hd=$(curl -sS --http2 -I --max-time 30 "${R[@]}" -o /dev/null -w '%{http_code} %{http_version}' "https://ipfs.enclave.host/ipfs/bafkqaaa?format=raw" 2>/dev/null)
  for spec in "probe|/ipfs/bafkqaaa?format=raw" "root|/ipfs/$ROOT?format=raw" "pb|/ipfs/$PB?format=raw" "raw|/ipfs/$RAW?format=raw" "car|/ipfs/$ROOT?format=car"; do
    k=${spec%%|*}; p=${spec#*|}
    if [ $k = car ]; then got=$(get "https://ipfs.enclave.host$p" --resolve "ipfs.enclave.host:443:${IP[$a]}" -H 'Accept: application/vnd.ipld.car'); else got=$(get "https://ipfs.enclave.host$p" "${R[@]}"); fi
    [ "$got" = "${WANT[$k]}" ] && s=PASS || { s=FAIL; fail=1; }
    echo "$s front=$a $k: $got"
  done
  [ "$hd" = "200 2" ] && echo "PASS front=$a probe_head: $hd" || { echo "FAIL front=$a probe_head: $hd"; fail=1; }
done
echo "--- public paths (informational: gateways may cache an earlier failure; boxo's per-host cooldown is 1 min)"
echo "ipfs.enclave.host (DNS) probe: $(get 'https://ipfs.enclave.host/ipfs/bafkqaaa?format=raw' -H 'Accept: application/vnd.ipld.raw')"
echo "dweb.link index.html:   $(get "https://$ROOT.ipfs.dweb.link/index.html") (want sha $IDX)"
echo "ipfs.io index.html:     $(get "https://ipfs.io/ipfs/$ROOT/index.html") (want sha $IDX)"
echo "eth.limo index.html:    $(get 'https://enclavehost.eth.limo/index.html') (want sha $IDX)"
echo "eth.link index.html:    $(get 'https://enclavehost.eth.link/index.html') (want sha $IDX)"
echo "=== FRONTS $([ $fail = 0 ] && echo ALL PASS || echo FAILED)"; exit $fail
