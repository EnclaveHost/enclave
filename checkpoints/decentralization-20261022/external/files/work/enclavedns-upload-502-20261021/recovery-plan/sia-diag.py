#!/usr/bin/env python3
"""READ-ONLY, ROOT-RUN: sia-s3's own signed per-host diagnostic, GET /?sia-diag (live 0.1.8, src/diag.rs).
It asks the indexer for the offered hosts and dials each through the SAME egress the uploads use. Per host it reports the
stage that failed (tcp | mux | settings), the error text and the time taken. Nothing is uploaded, pinned, paid or changed.
The settings RPC is free.

  SIA_S3_AK=... SIA_S3_SK=... python3 sia-diag.py [--limit 60] [--timeout 20] [--resolve <front IPv4>] [--out <file>]

- Credentials: one of sia-s3's configured S3 access keys (the adapter's). They are read from the environment and never
  printed or written.
- The SigV4 signer is s3check.py's (work/sia-readback/scripts/s3check.py 183f2b55, used against sia-s3 in the storage
  e2e), with path "/" and the diag query.
- Output: the full JSON to --out (default sia-diag-<UTC>.json, no secrets: host keys, addresses, stages, error strings)
  and a summary on stdout.
"""
import argparse, collections, datetime, hashlib, hmac, http.client, json, os, socket, ssl, sys, urllib.parse

HOST = "ef514ed3.app.enclave.host"          # sia-s3 0.1.8, deployment 0xef514ed3, its public label
REGION = os.environ.get("SIA_S3_REGION", "auto")

def enc(s): return urllib.parse.quote(s, safe="-_.~")

def canonical_query(q):                      # == sigv4.rs canonical_query: pairs aws-encoded, sorted, "k=v" joined by &
    return "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(q.items()))

def signed_get(q, ak, sk, resolve=None, timeout=300):
    qs = canonical_query(q)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    ph = hashlib.sha256(b"").hexdigest()
    headers = {"host": HOST, "x-amz-date": amz, "x-amz-content-sha256": ph}
    signed = sorted(headers)
    canon = "\n".join(["GET", "/", qs, "".join(f"{h}:{headers[h]}\n" for h in signed), ";".join(signed), ph])
    scope = f"{day}/{REGION}/s3/aws4_request"
    sts = f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
    k = hmac.new(("AWS4" + sk).encode(), day.encode(), hashlib.sha256).digest()
    for part in (REGION, "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={';'.join(signed)}, "
                                f"Signature={hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()}")
    # --resolve: connect to one front's address, keep SNI/Host = the label (curl --resolve semantics)
    ctx = ssl.create_default_context()
    c = http.client.HTTPSConnection(resolve or HOST, 443, timeout=timeout, context=ctx)
    if resolve:
        c.sock = ctx.wrap_socket(socket.create_connection((resolve, 443), timeout=timeout), server_hostname=HOST)
    c.request("GET", "/?" + qs, headers=headers)
    r = c.getresponse()
    return r.status, r.read()

def main():
    a = argparse.ArgumentParser(); a.add_argument("--limit", type=int, default=60); a.add_argument("--timeout", type=int, default=20)
    a.add_argument("--resolve"); a.add_argument("--out")
    o = a.parse_args()
    if not (1 <= o.limit <= 200 and 5 <= o.timeout <= 45): sys.exit("--limit 1..200, --timeout 5..45 (each stage per host)")
    ak, sk = os.environ.get("SIA_S3_AK"), os.environ.get("SIA_S3_SK")
    if not ak or not sk: sys.exit("set SIA_S3_AK and SIA_S3_SK (not printed)")
    at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # the probes run in parallel; each of the 3 stages may take up to --timeout s
    status, body = signed_get({"sia-diag": "", "limit": str(o.limit), "timeout": str(o.timeout)}, ak, sk, o.resolve, timeout=4 * o.timeout + 60)
    out = o.out or f"sia-diag-{at.replace(':', '')}.json"
    try: j = json.loads(body)
    except Exception: j = {"unparsed": body[:2000].decode("utf-8", "replace")}
    with open(out, "x") as f: json.dump({"at": at, "status": status, "via": o.resolve or "dns", "result": j}, f, indent=1)
    errs = collections.Counter((p.get("stage"), (p.get("err") or "")[:120]) for p in j.get("probes", []) if not p.get("ok"))
    print(json.dumps({"at": at, "status": status, "egress": j.get("egress"), "hostsOffered": j.get("hostsOffered"),
                      "withoutSiamux": j.get("withoutSiamux"), "ok": j.get("ok"), "failedByStage": j.get("failedByStage"),
                      "elapsedMs": j.get("elapsedMs"), "error": j.get("error") or j.get("unparsed"),
                      "topErrors": [{"stage": s, "err": e, "hosts": n} for (s, e), n in errs.most_common(8)], "file": out}, indent=1))
    return 0 if status == 200 else 1

if __name__ == "__main__":
    sys.exit(main())
