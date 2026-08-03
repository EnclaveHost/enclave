#!/bin/bash
# mm18 fleet canary: golden diff + 3-sample throughput on the bench
# deployment, comparing plain / lk4 (branch-commit) / lk4rs (rewind-commit).
# Usage: fleet-bench.sh golden|multi
# Assumes the fleet engine is mm18 and llm-chat-bench 0.34.0 is live on ID.
set -u
S=$(cd "$(dirname "$0")" && pwd)
OLD=$HOME/.cache/specbench-deps
ID=0xed05dd0468e32a3a379f33b1ef5f11224d49d8dd550dd40351edde04676e045d
URL=https://api.enclave.host/x/$ID
CLI="node /home/steven/Projects/enclave/cli/enclave.mjs"
MODE=${1:-multi}
cd "$S"
P_PROSE="Explain why the sky is blue, why sunsets are red, and why clouds are white, in about three paragraphs."
P_QUOTE="Here is a short policy: 'All deployments must pin their base images by digest. All secrets must rotate every 90 days. All services must emit structured logs.' Go through the policy sentence by sentence: quote each sentence exactly, then give one concrete example of following it."

mint() { node "$OLD/session.mjs" https://api.enclave.host > "$S/bearer.txt" 2>/dev/null; B=$(cat "$S/bearer.txt"); }
wait_app() {
  for j in $(seq 1 40); do
    curl -s -m 45 -H "authorization: Bearer $B" -H "content-type: application/json" \
      -X POST "$URL/title" -d '{"messages":[{"role":"user","content":"ping"}]}' 2>/dev/null | grep -q title && return 0
    sleep 12
  done
  return 1
}
setcfg() {
  timeout 150 $CLI config set "$ID" --file "$S/$1" --yes >/dev/null 2>&1
  sleep 55; mint; wait_app
}

timeout 150 $CLI resume $ID --yes >/dev/null 2>&1
for i in $(seq 1 120); do
  st=$(timeout 60 $CLI status $ID 2>/dev/null | grep '^status' | awk '{print $2}')
  [ "$st" = "running" ] && break; sleep 30
done
[ "${st:-}" = "running" ] || { echo NEVER_CLAIMED; exit 1; }
mint; wait_app || { echo APP_DOWN; exit 1; }

if [ "$MODE" = golden ]; then
  gen() { # cfg prompt tag
    setcfg "$1" || { echo "[$3] app down"; return 1; }
    local txt
    txt=$(curl -s -m 300 -H "authorization: Bearer $B" -H "content-type: application/json" \
      -X POST "$URL/chat" -d "$(python3 -c 'import json,sys;print(json.dumps({"messages":[{"role":"user","content":sys.argv[1]}],"max_tokens":384,"temperature":0,"effort":"low"}))' "$2")" 2>/dev/null \
      | grep -o '"delta":"[^"]*"' | sed 's/"delta":"//;s/"$//' | tr -d '\n')
    printf '%s\t%s\t%s\n' "$3" "$(printf '%s' "$txt" | sha256sum | cut -c1-24)" "${#txt}"
    printf '%s\n' "$txt" > "$S/fgold-$3.txt"
  }
  echo "== mm18 golden =="
  # the previous campaign's exact plain leg, byte-diffable against
  # $OLD/golden-mm14-plain.txt (plain has matched on every build since)
  gen cfg-plain.json  "Explain in detail why the sky is blue and why sunsets are red." plain-legacy
  if cmp -s "$S/fgold-plain-legacy.txt" "$OLD/golden-mm14-plain.txt"; then
    echo "plain-legacy: BYTE-IDENTICAL to mm14 archive"
  else
    echo "plain-legacy: DIFFERS from mm14 archive (investigate before trusting anything else)"
  fi
  gen cfg-plain.json  "$P_QUOTE" plain-q
  gen cfg-lk4.json    "$P_QUOTE" lk4-q
  gen cfg-lk4rs.json  "$P_QUOTE" lk4rs-q
  gen cfg-plain.json  "$P_PROSE" plain-p
  gen cfg-lk4rs.json  "$P_PROSE" lk4rs-p
else
  for cfg in ${CFGS:-plain lk4 lk4rs}; do
    setcfg "cfg-$cfg.json" || { echo "$cfg down"; continue; }
    for r in 1 2 3; do
      curl -s -m 420 -H "authorization: Bearer $B" -H "content-type: application/json" \
        -X POST "$URL/chat" -d "$(python3 -c 'import json,sys;print(json.dumps({"messages":[{"role":"user","content":sys.argv[1]}],"max_tokens":256,"effort":"low"}))' "$P_QUOTE")" 2>/dev/null \
        | grep '"done":true' | tail -1 > "$S/fm-$cfg-q$r.json"
    done
    for r in 1 2 3; do
      curl -s -m 420 -H "authorization: Bearer $B" -H "content-type: application/json" \
        -X POST "$URL/chat" -d "$(python3 -c 'import json,sys;print(json.dumps({"messages":[{"role":"user","content":sys.argv[1]}],"max_tokens":256,"effort":"low"}))' "$P_PROSE")" 2>/dev/null \
        | grep '"done":true' | tail -1 > "$S/fm-$cfg-p$r.json"
    done
  done
  python3 - "$S" <<'PY'
import json,os,sys,statistics
S=sys.argv[1]
for cfg in os.environ.get('CFGS','plain lk4 lk4rs').split():
    for pk,label in (('q','quote'),('p','prose')):
        tps=[];dec=[];acc=[]
        for r in (1,2,3):
            f=f'{S}/fm-{cfg}-{pk}{r}.json'
            raw=open(f).read().strip().replace('data: ','') if os.path.exists(f) else ''
            if not raw: continue
            d=json.loads(raw); v=d.get('verb_us',{}) or {}
            tps.append(d.get('tok_per_s',0))
            e=v.get('feed_all#decode') or v.get('feed_all_mtp#decode')
            if e: dec.append(e['us']/1000/max(e['n'],1))
            if d.get('draft_tokens'): acc.append(f"{d.get('draft_accepted',0)}/{d.get('draft_tokens',0)}")
        if tps:
            m=statistics.mean(tps); sd=statistics.pstdev(tps) if len(tps)>1 else 0
            line=f'{cfg:6s} {label:5s} tok_s: {" ".join(f"{t:.1f}" for t in tps)}  mean={m:.1f} sd={sd:.1f}'
            if dec: line+=f'  vdec: {" ".join(f"{x:.1f}" for x in dec)}'
            if acc: line+=f'  acc: {" ".join(acc)}'
            print(line)
PY
fi
timeout 150 $CLI stop $ID --yes >/dev/null 2>&1 && echo "bench suspended"
echo "FLEET_${MODE}_DONE"
