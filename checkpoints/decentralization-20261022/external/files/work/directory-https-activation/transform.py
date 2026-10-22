#!/usr/bin/env python3
"""Deterministic Caddyfile transform: the public signed-record directory on the literal-IP HTTPS site.

  python3 transform.py <baseline Caddyfile> <literal IPv4> [<out>]

Inserts FRAGMENT into the `https://<ip> {` site block, immediately before its `@recovery` matcher, so that
credential-free GET/POST (and their CORS preflight) of exactly the public signed-record grammar
(network/directory-client.mjs read/publish paths and management-host.mjs /v1/network/management) are answered
by this host's local directory (127.0.0.1:8188), never by the control tunnel (127.0.0.1:30443).
Every other byte of the file is unchanged. Idempotent: an input that already holds the exact fragment is
returned unchanged; a partial or different fragment is refused. Pure function of (input bytes, ip).
"""
import hashlib
import ipaddress
import sys

BEGIN = "    # BEGIN public signed-record directory (work/directory-https-activation)\n"
END = "    # END public signed-record directory\n"
# network/directory-client.mjs checkPath (read + publish), plus /v1/network/management (management-host.mjs publisher).
GRAMMAR = r"^/v1/network/(providers|qualifications|routes|records|management|policy/0x[0-9a-f]{64})$"
RECOVERY = "    @recovery path /native/* /recovery-health /v1/* /health /enclaves /availability /route /t/* /mcp\n"

FRAGMENT = (
    BEGIN
    + "    # Credential-free GET and POST of the public signed-record grammar are answered by THIS host's\n"
    "    # local directory (127.0.0.1:8188, network/directory-server.mjs), never by the control tunnel below.\n"
    "    # The directory checks every signature/owner/lease itself. Legacy compatibility only (@recovery):\n"
    "    # /v1/network/{byo,status}/*, other policy-id spellings, other methods, Authorization/Cookie requests.\n"
    "    # Dialed from 127.0.0.2: public traffic must not use the directory's loopback-reserved DNS budget.\n"
    "    @publicDirectory {\n"
    "        method GET POST\n"
    "        path_regexp " + GRAMMAR + "\n"
    "        not header Authorization *\n"
    "        not header Cookie *\n"
    "    }\n"
    "    handle @publicDirectory {\n"
    "        # Set once here (also on Caddy's own 413/502); the directory's copy is dropped below.\n"
    "        header Access-Control-Allow-Origin \"*\"\n"
    "        request_body {\n"
    "            max_size 65536\n"
    "        }\n"
    "        reverse_proxy 127.0.0.1:8188 {\n"
    "            header_up -Authorization\n"
    "            header_up -Cookie\n"
    "            header_down -Access-Control-Allow-Origin\n"
    "            header_down -Access-Control-Allow-Credentials\n"
    "            header_down -Set-Cookie\n"
    "            header_down -X-Content-Type-Options\n"
    "            transport http {\n"
    "                local_address 127.0.0.2\n"
    "                dial_timeout 3s\n"
    "                response_header_timeout 15s\n"
    "            }\n"
    "        }\n"
    "    }\n"
    "    @publicDirectoryPreflight {\n"
    "        method OPTIONS\n"
    "        path_regexp " + GRAMMAR + "\n"
    "        header_regexp Access-Control-Request-Method ^(GET|POST)$\n"
    "        not header Access-Control-Request-Headers *authorization*\n"
    "        not header Cookie *\n"
    "    }\n"
    "    handle @publicDirectoryPreflight {\n"
    "        header Access-Control-Allow-Origin \"*\"\n"
    "        header Access-Control-Allow-Methods \"GET, POST\"\n"
    "        header Access-Control-Allow-Headers \"content-type\"\n"
    "        header Access-Control-Max-Age \"600\"\n"
    "        respond 204\n"
    "    }\n"
    "    # Any other /v1/network/* path is not a public record: answered 404 here, never by the control tunnel, so an\n"
    "    # origin advertised as a directory cannot pass off a legacy answer. Legacy-only API paths stay below.\n"
    "    @publicDirectoryUnknown {\n"
    "        path_regexp (?i)^/v1/network/\n"
    "        not path /v1/network/byo/* /v1/network/status/* /v1/network/policy/*\n"
    "        not path_regexp " + GRAMMAR + "\n"
    "    }\n"
    "    handle @publicDirectoryUnknown {\n"
    "        header Access-Control-Allow-Origin \"*\"\n"
    "        header Content-Type application/json\n"
    "        respond `{\"error\":\"not a public-record path\"}` 404\n"
    "    }\n"
    + END
)


def transform(text: str, ip: str) -> str:
    ip = str(ipaddress.IPv4Address(ip))
    head = "\nhttps://" + ip + " {\n"
    if text.count(head) != 1:
        raise SystemExit("refused: expected exactly one literal-IP site block for " + ip)
    start = text.index(head) + 1
    end = text.find("\n}\n", start)
    if end < 0:
        raise SystemExit("refused: unterminated literal-IP site block")
    block = text[start:end + 3]
    if BEGIN in text or END in text:
        if text.count(FRAGMENT) == 1 and FRAGMENT in block and block.index(FRAGMENT) + len(FRAGMENT) == block.index(RECOVERY):
            return text
        raise SystemExit("refused: a different or partial directory fragment is present")
    if text.count(RECOVERY) != 1 or block.count(RECOVERY) != 1:
        raise SystemExit("refused: the literal-IP @recovery matcher is not the reviewed one")
    if "@publicDirectory" in text or "local_address" in text:
        raise SystemExit("refused: conflicting matcher names or transport already present")
    at = start + block.index(RECOVERY)
    return text[:at] + FRAGMENT + text[at:]


def main():
    src, ip = sys.argv[1], sys.argv[2]
    data = open(src, "rb").read()
    out = transform(data.decode("utf-8"), ip).encode("utf-8")
    if len(sys.argv) > 3:
        with open(sys.argv[3], "xb") as f:
            f.write(out)
    print(hashlib.sha256(data).hexdigest(), hashlib.sha256(out).hexdigest(), len(out))


if __name__ == "__main__":
    main()
