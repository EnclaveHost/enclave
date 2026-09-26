#!/usr/bin/env bash
# The FIXED-release relaunch's proofs for ONE canary (derived from e4-proofs.sh): the five proofs against 52156652 (the
# measurement = the prediction recorded before the restart = the relay's answer now), and for hookbin a SIXTH (enclave-87):
# a HEAD request to an app that answers HEAD with a body leaves NONE of its bytes on the serial: after it, the serial
# holds no "Unsolicited response" line and at least one "DOM front: unsolicited upstream response (N bytes withheld)"
# (the control: the 79c5ecf2 serial held "Unsolicited response", checked by e5-restart.sh). Then the 10-min observe.
# Started DETACHED by e5-restart.sh (never sees the key). Any failure HOLDs (exit 25), changing nothing. Rollback, by a
# human: the S5 tree switch's rollback (guestd back on iso-aa6c985c), then the owner's restart of that canary (79c5ecf2).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh
trap '' HUP PIPE
ID=${1:?}; canary "$ID" || exit 2
# detached through e5-restart.sh only; every step here only READS (guestd, the node and relay journals, public TLS)
# except 5e's own state/, and proof 6's one public HEAD request
grep -qE "^0::/.*/e5-proofs-$ID-[0-9]{8}T[0-9]{6}Z\.service\$" /proc/self/cgroup || { say "REFUSING: run through e5-restart.sh"; exit 2; }
B=$ST/$ID-before.json; [ -r $B ] || { say "no $B"; exit 2; }
jb() { python3 -c "import json; print(json.load(open('$B'))['$1'])"; }
T0=$(jb t0); OLDID=$(jb oldId); OLDKEY=$(jb oldKey); OLDSERIAL=$(jb oldSerial)
[ "$(jb relm)" = "$RELM" ] && [[ "$RELM" =~ ^[0-9a-f]{96}$ ]] || { say "the recorded prediction in $B is not the pinned ${RELM:0:12}"; exit 2; }
hold() { say "5e $ID HOLD: $* (nothing changed by this checker; rollback = s5t-rollback.sh, which needs OVERRIDE=<reason> once any canary is accepted on 52156652, then the owner's restart of $ID)"; exit 25; }
# ---- the new guest: a different guest for this deployment, running
newg() { vms4 >/dev/null && E=$(entry4 $FULL) && python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['id']!='$OLDID' and e['status']=='running' else 1)" "$E"; }
wait_for 900 newg || hold "no new running guest for $ID within 15 min of the restart"
E=$(entry4 $FULL); NEWID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E")
say "5e $ID: new guest $NEWID running (the legacy one was $OLDID)"
# ---- proof 2: guestd's view: release, attested, the relay's 79c5ecf2 image
python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e.get('release') is True and e.get('verdict')=='attested' and e['measurement']=='$RELM' else 1)" "$E" \
  || hold "proof 2: guestd's entry is not release:true / verdict attested / measurement ${RELM:0:12} ($(python3 -c "import json,sys; e=json.loads(sys.argv[1]); print(e.get('release'), e.get('verdict'), e['measurement'][:12])" "$E"))"
M=$(expected_rel $FULL) && [ "$M" = "$RELM" ] || hold "proof 2: the relay's expected-guest image under 52156652 is now '${M:-none}', not the independently computed ${RELM:0:12}"
NEWKEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['transportKeySha256'])" "$E")
[[ "$NEWKEY" =~ ^[0-9a-f]{64}$ ]] && [ "$NEWKEY" != "$OLDKEY" ] || hold "proof 2: the new guest's key is not a new 64-hex key"
say "5e $ID proof 2 ok: release:true, attested, measurement ${RELM:0:16} = the independently computed 52156652 value = the relay's prediction, new key ${NEWKEY:0:16}"
# ---- proof 3: the serial: release, no app config, serving on the new key; none of the app's own output
SER=$PROD/guestd-root/$NEWID/$NEWID.serial
serving() { [ -r "$SER" ] && serial_clean "$SER" | grep -qE '^DOM serving vsock=443 spki_sha256=[0-9a-f]{64} '; }
wait_for 300 serving || hold "proof 3: the new guest's serial never reached DOM serving"
cp "$SER" $ST/$ID-new.serial; C=$(serial_clean $ST/$ID-new.serial)
rl=$(grep -nE "^DOM release: deployment 0x$ID\.\.\. envelope [^ ]{1,16}\.\.\. 1 allowed origin\(s\), 0 refused, config $CFGB bytes\$" <<<"$C" | cut -d: -f1 || true)
cl=$(grep -nx "DOM app config: $CFGB bytes (ENCLAVE_CONFIG)" <<<"$C" | cut -d: -f1 || true)
sl=$(grep -nE '^DOM serving vsock=443 spki_sha256=[0-9a-f]{64} ' <<<"$C" | cut -d: -f1 || true)
[[ "$rl" =~ ^[0-9]+$ ]] && [[ "$cl" =~ ^[0-9]+$ ]] && [[ "$sl" =~ ^[0-9]+$ ]] && [ "$rl" -lt "$cl" ] && [ "$cl" -lt "$sl" ] \
  || hold "proof 3: the serial lacks, doubles or misorders DOM release (1 origin, config $CFGB bytes: ${rl:-none}) / app config $CFGB bytes (${cl:-none}) / serving (${sl:-none})"
SPKI=$(sed -nE "${sl}s/^DOM serving vsock=443 spki_sha256=([0-9a-f]{64}) .*/\1/p" <<<"$C")
ENV16=$(sed -nE "${rl}s/^DOM release: deployment 0x$ID\.\.\. envelope ([^ .]{1,16})\.\.\. .*/\1/p" <<<"$C")
[ "$SPKI" = "$NEWKEY" ] || hold "proof 3: the serial serves key ${SPKI:0:16}, not guestd's ${NEWKEY:0:16}"
! grep -qE "$MARK" <<<"$C" || hold "proof 3: the app's own output ($MARK) is in the release guest's serial"
F=$(serial_foreign $ST/$ID-new.serial); [ -z "$F" ] || { echo "$F" > $ST/$ID-new-foreign.txt; hold "proof 3: $(grep -c . <<<"$F") line(s) in the serial that are neither the front's, init's nor the kernel's ($ID-new-foreign.txt)"; }
say "5e $ID proof 3 ok: DOM release (1 origin = the relay, config $CFGB bytes = the version's _media config) (envelope tag $ENV16) < app config $CFGB bytes < serving on ${SPKI:0:16}; no app output"
# ---- proof 1 (restated, enclave-87; its shape enclave-bf's, from relay/secrets-release.mjs): EXACTLY ONE release to a
# verified guest on runtime ccadb38a; no REFUSED (:458, :473), no burned ticket (:357 "ticket burned", :346 "ticket for
# <id> presented ... burned"); "(ticket kept)" lines (:357 warming, :433 collateral) ONLY strictly before the release and
# within 60 s of it: the relay's cold prediction after a restart answers 503 and KEEPS the ticket (enclave-e3). Ordered by
# the journal's own timestamps. (A ticket re-presented AFTER its consumption is a silent 403 the relay never logs: no log
# check can see it, and this one does not claim to; a second release needs a second ticket and shows as a second line.)
RJ=$($NANX "journalctl -u enclave-api-relay --since '$T0 UTC' --no-pager -o short-iso-precise") || hold "proof 1: the relay's journal on nan could not be read"
grep -iE "\[secrets-release\] ($FULL:|ticket for $FULL |ticket for 0x[0-9a-f]{64} presented for $FULL:)" <<<"$RJ" > $ST/$ID-relay-lines.txt || true
p1=$(python3 - $ST/$ID-relay-lines.txt "$FULL" "$RUNTIME" <<'PY1'
import sys,re,datetime
f,full,rt=sys.argv[1:]; full=full.lower(); rel=[]; kept=[]; bad=[]
for l in open(f).read().splitlines():
    m=re.match(r'^(\S+) \S+ [^:]+: \[secrets-release\] (.*)$', l)
    if not m: bad.append("unparsed: "+l[:120]); continue
    ts=datetime.datetime.fromisoformat(m.group(1)); msg=m.group(2); low=msg.lower()
    if low.startswith("ticket for "+full+" "): bad.append("a ticket presented for another id or after expiry (burned)"); continue
    if low.startswith("ticket for ") and (" presented for "+full+":") in low: bad.append("another deployment's ticket presented for this id (burned)"); continue
    if not low.startswith(full+":"): bad.append("unexpected: "+msg[:120]); continue
    body=msg[len(full)+1:].strip()
    if body.startswith("released to a verified guest on ") and ("(runtime "+rt) in body: rel.append(ts)
    elif "evidence REFUSED" in body or body.startswith("REFUSED:"): bad.append("refused: "+body[:120])
    elif "ticket burned" in body: bad.append("burned: "+body[:120])
    elif body.endswith("(ticket kept)") or body.startswith("no prediction (ticket kept)") or "(ticket kept)" in body: kept.append(ts)
    else: bad.append("unknown: "+body[:120])
if len(rel)!=1: print("not exactly one release (%d)" % len(rel)); sys.exit(1)
if bad: print("; ".join(bad)); sys.exit(1)
late=[k for k in kept if not (k < rel[0] and (rel[0]-k).total_seconds() <= 60)]
if late: print("%d '(ticket kept)' line(s) not strictly before the release within 60 s" % len(late)); sys.exit(1)
print("one release at %s; %d '(ticket kept)' warming/collateral line(s) before it (%s)" % (rel[0].strftime('%H:%M:%S'), len(kept), ", ".join("%.1f s before" % (rel[0]-k).total_seconds() for k in kept) or "none"))
PY1
) || hold "proof 1: the relay's lines for $ID since T0 are not the accepted shape: ${p1:-unreadable} ($ID-relay-lines.txt)"
NJ=$(journalctl --user -u enclave-metal-iso.service --since "$T0 UTC" --no-pager -o cat) || hold "proof 1: the node journal could not be read"
grep -F "[isolation] 0x$ID:" <<<"$NJ" > $ST/$ID-node-lines.txt || true
[ "$(grep -cF "release ticket handed to guest $NEWID" $ST/$ID-node-lines.txt || [ $? = 1 ])" = 1 ] \
  && ! grep -qE 'did not take the release ticket|release ticket pump for|release ticket for ' $ST/$ID-node-lines.txt \
  || hold "proof 1: the node's ticket lines for $ID are not exactly one 'release ticket handed to guest $NEWID' ($ID-node-lines.txt)"
say "5e $ID proof 1 ok: $p1; one ticket handed to $NEWID"
# ---- proof 4: the certificate for the NEW key through the expected-guest gate; no refusal for this id
certd() { NJ=$(journalctl --user -u enclave-metal-iso.service --since "$T0 UTC" --no-pager -o cat) && grep -qF "[isolation] 0x$ID: certificate for $HOST installed in guest $NEWID (key ${SPKI:0:16}…" <<<"$NJ"; }
wait_for 600 certd || hold "proof 4: no certificate installed for $HOST in $NEWID on key ${SPKI:0:16} within 10 min"
grep -F "[isolation] 0x$ID:" <<<"$NJ" > $ST/$ID-node-lines.txt || true
grep -F "installed in guest $NEWID" $ST/$ID-node-lines.txt | grep -qF '; guest attested)' || hold "proof 4: the certificate line does not say 'guest attested'"
! grep -qE 'REFUSED|not an eligible|is no predicted image' $ST/$ID-node-lines.txt || hold "proof 4: a refusal line for $ID ($ID-node-lines.txt)"
say "5e $ID proof 4 ok: certificate installed in $NEWID for key ${SPKI:0:16}, guest attested; no refusal ($(grep -c 'no certificate for' $ST/$ID-node-lines.txt || [ $? = 1 ]) retry line(s))"
# ---- proof 5: public TLS via us-west with the NEW certificate on the NEW key
[ "$(getent ahostsv4 $HOST | awk '{print $1}' | sort -u | paste -sd,)" = 5.78.85.108 ] || hold "proof 5: $HOST does not resolve to us-west (5.78.85.108) alone"
wait_for 300 pub1 $ID "$SPKI" || hold "proof 5: https://$HOST/ is not 200 over valid TLS on the new key"
NS=$(cert_serial $HOST); [ -n "$NS" ] && [ "$NS" != "$OLDSERIAL" ] || hold "proof 5: the public certificate's serial is '${NS:-none}' (old $OLDSERIAL)"
cert_names $HOST | grep -qF "$HOST" || hold "proof 5: the public certificate does not name $HOST"
say "5e $ID proof 5 ok: https://$HOST/ 200 via us-west, new serial $NS on key ${SPKI:0:16}"
# ---- proof 6 (hookbin): a HEAD whose answer carries a body leaves none of the app's bytes on the host's console
if [ "$ID" = 0ddbd824 ]; then
  u0=$(serial_clean "$SER" | grep -c 'Unsolicited response' || [ $? = 1 ]); w0=$(serial_clean "$SER" | grep -c '^DOM front: unsolicited upstream response (' || [ $? = 1 ])
  [ "$u0" = 0 ] || hold "proof 6: the new serial already holds $u0 'Unsolicited response' line(s)"
  hc=$(curl -sS -m 20 -I -o /dev/null -w '%{http_code}' https://$HOST/) || true
  hs() { [ "$(serial_clean "$SER" | grep -c '^DOM front: unsolicited upstream response (' || [ $? = 1 ])" -gt "$w0" ]; }
  wait_for 30 hs || hold "proof 6: after HEAD ($hc) the serial shows no 'DOM front: unsolicited upstream response' line (the front did not see the body, or the test is not exercising the path)"
  u1=$(serial_clean "$SER" | grep -c 'Unsolicited response' || [ $? = 1 ]); [ "$u1" = 0 ] || hold "proof 6: after HEAD the serial holds $u1 'Unsolicited response' line(s): the app's bytes reached the console"
  cp "$SER" $ST/$ID-new-after-head.serial
  say "5e $ID proof 6 ok: HEAD -> $hc; the serial withholds the body ($(serial_clean "$SER" | grep -m1 '^DOM front: unsolicited upstream response (' )), 0 'Unsolicited response' lines (79c5ecf2's control had them)"
fi
# ---- the other two canaries untouched
python3 - $B $ST/.guestd.json "$FULL" <<'PY' || hold "the other two canaries' guests changed"
import json,sys
b=json.load(open(sys.argv[1])); vms=json.load(open(sys.argv[2]))[1]["body"]["vms"]
now=sorted([v["name"],v["id"],v["createdAt"],v["transportKeySha256"]] for v in vms if v["name"].lower()!=sys.argv[3].lower())
sys.exit(0 if now==b["others"] else 1)
PY
# ---- 4e's expected state gets this canary's NEW key; then the 10-minute observe against it
python3 - $TSV4 $KEYS4 "$FULL" "$ID" "$NEWKEY" <<'PY'
import sys,os
tsv,keys,full,lab,k=sys.argv[1:]
rows=[l.split("\t") for l in open(tsv).read().strip().split("\n")]; n=0
for r in rows:
    if r[0].lower()==full.lower(): r[5]=k; n+=1
assert n==1
kl=[l.split() for l in open(keys).read().strip().split("\n")]; m=0
for r in kl:
    if r[0]==lab: r[1]=k; m+=1
assert m==1
for p,t in ((tsv,"\n".join("\t".join(r) for r in rows)+"\n"),(keys,"\n".join(" ".join(r) for r in kl)+"\n")):
    open(p+".new","w").write(t); os.replace(p+".new",p)
PY
say "5e $ID: ALL PROOFS PASS; 4e's expected key for $ID is now ${NEWKEY:0:16}; the 10-min observe"
start=$(date +%s); end=$((start + 600)); round=0
while :; do
  round=$((round+1))
  if public_ok4 && relay_row_ok && check_guestd4 >/dev/null; then say "5e $ID observe r$round: 3/3 canaries 200 on 4e's keys, relay serving, guestd as expected"
  else hold "the observe failed in round $round"; fi
  now=$(date +%s); [ $now -ge $end ] && break
  while [ $(date +%s) -lt $((now + 120)) ] && [ $(date +%s) -lt $end ]; do sleep 5; done
done
touch $ST/accepted-$ID
say "5e $ID ACCEPTED: five proofs + the observe ($round rounds over $(( $(date +%s) - start )) s). Next canary: $(case $ID in 0ddbd824) echo 395bed3e;; 395bed3e) echo 4e62e60d;; *) echo none: the fixed-release relaunch is done, then step 6;; esac)"
