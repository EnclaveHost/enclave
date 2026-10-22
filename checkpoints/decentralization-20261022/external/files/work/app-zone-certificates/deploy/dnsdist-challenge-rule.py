#!/usr/bin/env python3
"""Hash-guarded transform of a provider DNS front's dnsdist.conf (not applied here):
  python3 dnsdist-challenge-rule.py <dnsdist.conf> <expected base sha256> <out>
Routes `_acme-challenge.*.app.enclave.host` TXT/ANY to the LOCAL route replica pool ('routes', 127.0.0.1:1053) instead of
the control pool. The replica answers its own accepted app-zone challenges AND merges the control store's values
(APP_CHALLENGE_UPSTREAM), so existing relay issuance keeps validating. Exactly one line changes; refuses otherwise.
Reverse: swap the two strings back (the inverse transform, same guard)."""
import hashlib, sys
src, want, out = sys.argv[1], sys.argv[2], sys.argv[3]
b = open(src, 'rb').read()
if hashlib.sha256(b).hexdigest() != want:
    sys.exit('refused: dnsdist.conf is not the reviewed base')
old = "addAction(AndRule({SuffixMatchNodeRule(app), RegexRule('^_acme-challenge\\\\..*'), OrRule({QTypeRule(DNSQType.TXT), QTypeRule(DNSQType.ANY)})}), PoolAction('control'))"
new = old.replace("PoolAction('control'))", "PoolAction('routes'))")
t = b.decode()
if t.count(old) != 1:
    sys.exit('refused: the challenge rule is not exactly the reviewed one')
r = t.replace(old, new).encode()
open(out, 'xb').write(r)
print(hashlib.sha256(b).hexdigest(), hashlib.sha256(r).hexdigest())
