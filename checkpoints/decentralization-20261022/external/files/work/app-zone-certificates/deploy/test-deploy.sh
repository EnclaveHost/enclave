#!/usr/bin/env bash
# Deployment-closure checks (no host touched): the Caddy transform on each LIVE literal-IP Caddyfile (read-only copies in
# ../live-baseline, 2026-10-20, hashes in live.sha256; they include root's later platform-policy route) validated by the exact deployed
# Caddy v2.11.4 binary and idempotent; the dnsdist transform on a config rebuilt from the live front's rule lines
# changes exactly the challenge rule. Run via the shared queue (256 MiB).
set -uo pipefail
cd "$(dirname "$0")"
DHA=../../directory-https-activation; CADDY=$DHA/test/bin/caddy-2.11.4; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; rc=0
declare -A IP=([us-west]=134.199.235.187 [eu-central]=134.209.248.172 [ap-southeast]=165.245.191.129 [ca-east]=146.190.246.39)
for h in us-west eu-central ap-southeast ca-east; do
  python3 caddy-appzone.py ../live-baseline/$h.Caddyfile ${IP[$h]} $T/$h.Caddyfile > $T/$h.hash || { echo "FAIL transform $h"; rc=1; continue; }
  python3 caddy-appzone.py $T/$h.Caddyfile ${IP[$h]} $T/$h.again > /dev/null && cmp -s $T/$h.Caddyfile $T/$h.again || { echo "FAIL idempotence $h"; rc=1; }
  if XDG_DATA_HOME=$T/d XDG_CONFIG_HOME=$T/c HOME=$T $CADDY validate --config $T/$h.Caddyfile --adapter caddyfile > $T/$h.v 2>&1; then echo "VALID $h $(cat $T/$h.hash)"; else echo "INVALID $h"; tail -3 $T/$h.v; rc=1; fi
  diff ../live-baseline/$h.Caddyfile $T/$h.Caddyfile | grep -c '^>' | xargs -I{} echo "  $h: +{} lines, removed: $(diff ../live-baseline/$h.Caddyfile $T/$h.Caddyfile | grep -c '^<')"
done
cat > $T/dnsdist.conf <<'CONF'
setLocal('134.199.235.187:53')
newServer({address='127.0.0.1:1053', pool='routes', checkName='app.enclave.host.', checkType='SOA'})
newServer({address='127.0.0.1:31053', pool='control', tcpOnly=true, checkTCP=true, tcpConnectTimeout=2, tcpSendTimeout=2, tcpRecvTimeout=2, retries=1, checkName='app.enclave.host.', checkType='SOA'})
addAction(MaxQPSIPRule(50, 32, 64, 200), DropAction())
addAction(NotRule(QClassRule(1)), RCodeAction(DNSRCode.REFUSED))
addAction(AndRule({SuffixMatchNodeRule(app), RegexRule('^_acme-challenge\\..*'), OrRule({QTypeRule(DNSQType.TXT), QTypeRule(DNSQType.ANY)})}), PoolAction('control'))
addAction(SuffixMatchNodeRule(app), PoolAction('routes'))
addAction(QNameRule('ip.enclave.host.'), PoolAction('routes'))
addAction(SuffixMatchNodeRule(raw), PoolAction('control'))
addAction(AllRule(), RCodeAction(DNSRCode.REFUSED))
CONF
base=$(sha256sum $T/dnsdist.conf | cut -c1-64)
if python3 dnsdist-challenge-rule.py $T/dnsdist.conf $base $T/dnsdist.new > /dev/null && [ "$(diff $T/dnsdist.conf $T/dnsdist.new | grep -c '^[<>]')" = 2 ] \
   && grep -q "QTypeRule(DNSQType.ANY)})}), PoolAction('routes'))" $T/dnsdist.new && grep -q "SuffixMatchNodeRule(raw), PoolAction('control'))" $T/dnsdist.new; then
  echo "dnsdist transform: exactly the challenge rule moved to the local replica pool"
else echo "FAIL dnsdist transform"; rc=1; fi
python3 dnsdist-challenge-rule.py $T/dnsdist.conf 0000000000000000000000000000000000000000000000000000000000000000 $T/x 2>/dev/null && { echo "FAIL dnsdist guard"; rc=1; } || echo "dnsdist guard refuses a different base"
echo "[deploy] exit=$rc"; exit $rc
