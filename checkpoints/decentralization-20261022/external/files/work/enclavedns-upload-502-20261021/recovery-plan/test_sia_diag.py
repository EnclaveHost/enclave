"""LOCAL test (no network): sia-diag.py's signed request verifies under a line-by-line port of sia-s3 0.1.8's
sigv4.rs verify (canonical request from the RECEIVED path/query/headers), with dummy credentials; a wrong secret fails."""
import hashlib, hmac, importlib.util, json, sys
sp = importlib.util.spec_from_file_location("d", "sia-diag.py"); d = importlib.util.module_from_spec(sp); sp.loader.exec_module(d)
cap = {}
class FakeConn:
    def __init__(self, *a, **k): pass
    def request(self, m, target, headers): cap.update(m=m, target=target, headers=headers)
    def getresponse(self):
        class R: status = 200
        R.read = staticmethod(lambda: b"{}"); return R
d.http.client.HTTPSConnection = FakeConn
d.signed_get({"sia-diag": "", "limit": "60", "timeout": "20"}, "AKDUMMY", "SKDUMMY")
def aws_encode(s): return "".join(c if (c.isascii() and c.isalnum()) or c in "-_.~" else "%%%02X" % ord(c) for c in s)
def verify(method, target, headers, secret):   # sigv4.rs verify, ported
    path, _, query = target.partition("?")
    pairs = sorted((aws_encode(k), aws_encode(v)) for k, _, v in (p.partition("=") for p in query.split("&") if p))
    auth = headers["Authorization"]; cred = auth.split("Credential=")[1].split(",")[0]; ak, date, region, svc, _ = cred.split("/")
    signed = auth.split("SignedHeaders=")[1].split(",")[0].split(";"); sig = auth.split("Signature=")[1]
    h = {k.lower(): v for k, v in headers.items()}; payload = h["x-amz-content-sha256"]
    canon = f"{method}\n{path}\n" + "&".join(f"{k}={v}" for k, v in pairs) + "\n" + "".join(f"{x}:{' '.join(h[x].split())}\n" for x in signed) + "\n" + ";".join(signed) + "\n" + payload
    sts = f"AWS4-HMAC-SHA256\n{h['x-amz-date']}\n{date}/{region}/s3/aws4_request\n{hashlib.sha256(canon.encode()).hexdigest()}"
    k = hmac.new(f"AWS4{secret}".encode(), date.encode(), hashlib.sha256).digest()
    for part in (region, "s3", "aws4_request"): k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    return hmac.new(k, sts.encode(), hashlib.sha256).hexdigest() == sig and "host" in signed and h["x-amz-date"].startswith(date)
ok = verify(cap["m"], cap["target"], cap["headers"], "SKDUMMY"); bad = verify(cap["m"], cap["target"], cap["headers"], "WRONG")
print(json.dumps({"target": cap["target"], "signedHeaders": cap["headers"]["Authorization"].split("SignedHeaders=")[1].split(",")[0], "verifies": ok, "wrongSecretRejected": not bad}))
sys.exit(0 if ok and not bad else 1)
