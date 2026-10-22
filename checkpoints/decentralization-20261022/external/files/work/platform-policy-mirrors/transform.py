"""Add only a public, static policy mirror to an existing literal-IP HTTPS site."""
import ipaddress

BEGIN = "    # BEGIN platform policy mirror\n"
END = "    # END platform policy mirror\n"
ANCHOR = "    # BEGIN public signed-record directory (work/directory-https-activation)\n"
GRAMMAR = r"^/platform-policy/(0x[0-9a-f]{64}|latest|ready)\.json$"
FRAGMENT = BEGIN + """    # Untrusted public transport. Clients verify the administrator signature and chain anchor.
    @platformPolicyRead {
        method GET HEAD
        path_regexp policyMirror """ + GRAMMAR + """
    }
    handle @platformPolicyRead {
        root * /var/lib/enclave-platform-policy
        uri strip_prefix /platform-policy
        header Access-Control-Allow-Origin "*"
        header Cache-Control "no-cache"
        header X-Content-Type-Options "nosniff"
        file_server
    }
    @platformPolicyPreflight {
        method OPTIONS
        path_regexp policyMirrorPreflight """ + GRAMMAR + """
        header_regexp Access-Control-Request-Method ^(GET|HEAD)$
    }
    handle @platformPolicyPreflight {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Allow-Methods "GET, HEAD"
        respond 204
    }
    @platformPolicyUnknown {
        path_regexp ^/platform-policy/
    }
    handle @platformPolicyUnknown {
        header Access-Control-Allow-Origin "*"
        respond 404
    }
""" + END


def transform(text, ip):
    ip = str(ipaddress.IPv4Address(ip))
    header = "\nhttps://" + ip + " {\n"
    if text.count(header) != 1:
        raise ValueError("expected one literal-IP site")
    start = text.index(header) + 1
    end = text.find("\n}\n", start)
    if end < 0:
        raise ValueError("unterminated literal-IP site")
    block = text[start:end + 3]
    if BEGIN in text or END in text:
        if text.count(FRAGMENT) == 1 and FRAGMENT + ANCHOR in block:
            return text
        raise ValueError("different or partial policy mirror fragment")
    if "@platformPolicy" in text or "/platform-policy" in text:
        raise ValueError("conflicting policy mirror configuration")
    if text.count(ANCHOR) != 1 or block.count(ANCHOR) != 1:
        raise ValueError("expected existing public directory inside literal-IP site")
    at = start + block.index(ANCHOR)
    return text[:at] + FRAGMENT + text[at:]
