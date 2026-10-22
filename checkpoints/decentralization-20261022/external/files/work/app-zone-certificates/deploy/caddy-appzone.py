#!/usr/bin/env python3
"""Hash-guarded transform of a provider's literal-IP HTTPS Caddyfile (not applied here):
  python3 caddy-appzone.py <Caddyfile> <literal IPv4> <out>
Adds POST/DELETE /v1/app-challenge (credential-free, <= 32 KiB) -> the local route replica's push API 127.0.0.1:8154,
before the public signed-record directory block (and so before @recovery's /v1/* to the control tunnel). Guests and peer
replicas reach it as https://<ip>/v1/app-challenge with the IP's public certificate. Idempotent; refuses any other shape."""
import hashlib, ipaddress, sys
MARK_DIR = "    # BEGIN public signed-record directory (work/directory-https-activation)\n"
BEGIN = "    # BEGIN app-zone challenge push (work/app-zone-certificates)\n"
FRAGMENT = (BEGIN +
"    # Signed, attested app-zone DNS-01 pushes for the local route replica (relay/dns-relay.js APP_CHALLENGE_AUTH), which\n"
"    # verifies each one itself (pinned measurement, HOST_DATA, current lease, registry host, catalog). Nothing else.\n"
"    @appZoneChallenge {\n"
"        method POST DELETE\n"
"        path_regexp ^/v1/app-challenge$\n"
"        not header Authorization *\n"
"        not header Cookie *\n"
"    }\n"
"    handle @appZoneChallenge {\n"
"        request_body {\n"
"            max_size 32768\n"
"        }\n"
"        reverse_proxy 127.0.0.1:8154 {\n"
"            header_up -Authorization\n"
"            header_up -Cookie\n"
"            header_down -Set-Cookie\n"
"            transport http {\n"
"                local_address 127.0.0.2\n"
"                dial_timeout 3s\n"
"                response_header_timeout 30s\n"
"            }\n"
"        }\n"
"    }\n"
"    # END app-zone challenge push\n")
def transform(text, ip):
    ip = str(ipaddress.IPv4Address(ip))
    head = "\nhttps://" + ip + " {\n"
    if text.count(head) != 1: raise SystemExit("refused: expected one literal-IP site block")
    start = text.index(head) + 1; end = text.find("\n}\n", start); block = text[start:end + 3]
    if BEGIN in text:
        if text.count(FRAGMENT) == 1 and FRAGMENT in block: return text
        raise SystemExit("refused: a different app-zone fragment is present")
    if text.count(MARK_DIR) != 1 or block.count(MARK_DIR) != 1: raise SystemExit("refused: the directory route is not the activated one")
    at = start + block.index(MARK_DIR)
    return text[:at] + FRAGMENT + text[at:]
if __name__ == "__main__":
    data = open(sys.argv[1], "rb").read(); out = transform(data.decode(), sys.argv[2]).encode()
    open(sys.argv[3], "xb").write(out); print(hashlib.sha256(data).hexdigest(), hashlib.sha256(out).hexdigest())
