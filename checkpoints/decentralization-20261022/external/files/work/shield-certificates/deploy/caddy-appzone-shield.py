#!/usr/bin/env python3
"""Hash-guarded transform of a provider's literal-IP HTTPS Caddyfile AFTER work/app-zone-certificates/deploy/caddy-appzone.py
(not applied here):  python3 caddy-appzone-shield.py <Caddyfile> <literal IPv4> <out>
Adds POST /v1/app-zone/shield-session/{challenge,attest} (credential-free; challenge <= 796108 bytes, attest <= 12591104
bytes = relay/dns-challenge-shield.mjs SHIELD_CHALLENGE_MAX_BYTES / SHIELD_ATTEST_MAX_BYTES) -> the local route replica's
push API 127.0.0.1:8154, directly before the app-zone challenge push fragment (so before @recovery's /v1/* to the control
tunnel). A Windows Shield host reaches it as https://<ip>/v1/app-zone/shield-session/... with the IP's public certificate.
The replica answers it only with APP_CHALLENGE_SHIELD_POLICY set; otherwise 405 (read-only). Idempotent; refuses any
other shape (no app-zone fragment, a different Shield fragment)."""
import hashlib, ipaddress, sys
APPZONE = "    # BEGIN app-zone challenge push (work/app-zone-certificates)\n"
BEGIN = "    # BEGIN app-zone Shield host sessions (work/shield-certificates)\n"
def route(name, path, cap):
    return ("    @" + name + " {\n"
            "        method POST\n"
            "        path_regexp ^/v1/app-zone/shield-session/" + path + "$\n"
            "        not header Authorization *\n"
            "        not header Cookie *\n"
            "    }\n"
            "    handle @" + name + " {\n"
            "        request_body {\n"
            "            max_size " + str(cap) + "\n"
            "        }\n"
            "        reverse_proxy 127.0.0.1:8154 {\n"
            "            header_up -Authorization\n"
            "            header_up -Cookie\n"
            "            header_down -Set-Cookie\n"
            "            transport http {\n"
            "                local_address 127.0.0.2\n"
            "                dial_timeout 3s\n"
            "                response_header_timeout 60s\n"
            "            }\n"
            "        }\n"
            "    }\n")
FRAGMENT = (BEGIN +
"    # A Windows Shield host's TPM boot session at the local route replica (network/app-zone-shield.mjs): the replica's own\n"
"    # nonce and credential, the host's quote, boot log and registered operator's signature. Public evidence only.\n" +
route("appZoneShieldChallenge", "challenge", 796108) + route("appZoneShieldAttest", "attest", 12591104) +
"    # END app-zone Shield host sessions\n")
def transform(text, ip):
    ip = str(ipaddress.IPv4Address(ip))
    head = "\nhttps://" + ip + " {\n"
    if text.count(head) != 1: raise SystemExit("refused: expected one literal-IP site block")
    start = text.index(head) + 1; end = text.find("\n}\n", start); block = text[start:end + 3]
    if BEGIN in text:
        if text.count(FRAGMENT) == 1 and FRAGMENT in block: return text
        raise SystemExit("refused: a different app-zone Shield fragment is present")
    if text.count(APPZONE) != 1 or block.count(APPZONE) != 1: raise SystemExit("refused: the app-zone challenge route (caddy-appzone.py) is not in place")
    at = start + block.index(APPZONE)
    return text[:at] + FRAGMENT + text[at:]
if __name__ == "__main__":
    data = open(sys.argv[1], "rb").read(); out = transform(data.decode(), sys.argv[2]).encode()
    open(sys.argv[3], "xb").write(out); print(hashlib.sha256(data).hexdigest(), hashlib.sha256(out).hexdigest())
