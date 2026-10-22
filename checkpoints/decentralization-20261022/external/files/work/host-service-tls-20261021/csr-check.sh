#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021; C=$H/compose; F=network/host-services/acme-http01.mjs
cd "$C"
SERVICE_TLS_TMP=$H/logs node --test --test-timeout=120000 test/service-tls.test.mjs > "$H/logs/csr-fixed.out" 2>&1; echo "fixed rc=$? $(grep -E '^# (pass|fail)' "$H/logs/csr-fixed.out" | tr '\n' ' ')"
# control: the OLD subject (CN = first name, 76 bytes)
sed -i "s|  const subject = cn ? derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(cn)))) : derSeq();|  const subject = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(names[0]))));|" "$F"
cmp -s "$H/tree/$F" "$F" && echo "control sed NOT applied"
SERVICE_TLS_TMP=$H/logs node --test --test-timeout=120000 test/service-tls.test.mjs > "$H/logs/csr-control.out" 2>&1; echo "control(old CN) rc=$? $(grep -E '^# (pass|fail)' "$H/logs/csr-control.out" | tr '\n' ' ') failing: $(grep '^not ok' "$H/logs/csr-control.out" | cut -c1-60 | tr '\n' '|')"
cp "$H/tree/$F" "$F"; cmp "$H/tree/$F" "$F" && echo restored
