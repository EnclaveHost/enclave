# Read-only: a signed HEAD of the scheduler's state object in its storage.
# Prints the status and the object's metadata; never the object, its name or
# a credential. The owner runs it (it reads the scheduler's storage keys):
#
#   python3 -I cron-state-head.py /path/to/cron-config.json
#
# What the answer says about a scheduler that stays at
# "Scheduler storage unavailable; recovering safely" (cron/src/store.rs):
#   200 with an ETag  the object is readable; the scheduler then fails on the
#                     lease it reads in it, on opening it, or on its write
#   404               the scheduler would start from an empty state
#   403               these are not the keys the running scheduler uses
#   5xx / no answer   storage cannot serve the object
import sys, json, hashlib, hmac, datetime, urllib.parse, http.client, ssl

cfg = json.load(open(sys.argv[1]))["storage"]
u = urllib.parse.urlparse(cfg["endpoint"])
path = "/" + urllib.parse.quote(cfg["bucket"], safe="") + "/" + urllib.parse.quote(cfg["key"], safe="-_.~/")


def signed(method):
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    empty = hashlib.sha256(b"").hexdigest()
    hdr = {"host": u.netloc, "x-amz-content-sha256": empty, "x-amz-date": amz}
    names = ";".join(sorted(hdr))
    canon = "\n".join([method, path, "", "".join(f"{k}:{hdr[k]}\n" for k in sorted(hdr)), names, empty])
    scope = f"{day}/{cfg['region']}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = ("AWS4" + cfg["secret_key"]).encode()
    for part in (day, cfg["region"], "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    hdr["authorization"] = f"AWS4-HMAC-SHA256 Credential={cfg['access_key']}/{scope}, SignedHeaders={names}, Signature={sig}"
    return hdr


c = http.client.HTTPSConnection(u.netloc, timeout=130, context=ssl.create_default_context())
t0 = datetime.datetime.now(datetime.timezone.utc)
c.request("HEAD", path, headers=signed("HEAD"))
r = c.getresponse()
r.read()
t1 = datetime.datetime.now(datetime.timezone.utc)
print("asked", t0.strftime("%H:%M:%SZ"), "answered in", round((t1 - t0).total_seconds(), 2), "s")
print("status", r.status)
for h in ("date", "last-modified", "content-length"):
    print(h, "=", r.getheader(h))
e = r.getheader("etag") or ""
print("etag:", "present" if e else "absent", "| length", len(e), "| multipart form" if "-" in e else "| plain form")
