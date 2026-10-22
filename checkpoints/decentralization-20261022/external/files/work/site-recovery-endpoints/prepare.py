"""Expose two already-public, verified site CARs on existing literal-IP HTTPS origins."""
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
SITES = {
    "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou": {
        "sha256": "ad7867eccffd23f2e4e874a5149c4c904e5acc8d5ded367cb561dbec6845f0d9",
        "bytes": 35127042,
    },
    "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y": {
        "sha256": "16c498f396856a9b2dc70f6182bdae73fe2069d753e6bd390627168d7769c18b",
        "bytes": 39856744,
    },
}
HOSTS = {
    "us-west": "134.199.235.187",
    "eu-central": "134.209.248.172",
    "ap-southeast": "165.245.191.129",
    "ca-east": "146.190.246.39",
}
BEGIN = "    # BEGIN immutable site CAR recovery\n"
END = "    # END immutable site CAR recovery\n"
MARKER = "    @recovery path /native/* /recovery-health /v1/* /health /enclaves /availability /route /t/* /mcp\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def transform(data, ip):
    ipaddress.IPv4Address(ip)
    text = data.decode()
    fragment = BEGIN
    for i, cid in enumerate(SITES):
        fragment += f"""    @siteRecoveryCar{i} {{
        method GET HEAD
        path /ipfs/{cid}
        query format=car
    }}
    handle @siteRecoveryCar{i} {{
        root * /opt/enclave-site/{cid}
        rewrite * /site.car
        header {{
            Content-Type application/vnd.ipld.car
            Access-Control-Allow-Origin *
            Cache-Control "public, max-age=31536000, immutable"
            Content-Security-Policy "default-src 'none'; sandbox"
        }}
        file_server
    }}
"""
    fragment += END
    if BEGIN in text or END in text:
        if text.count(fragment) != 1:
            raise ValueError("different or partial recovery fragment")
        return data
    vhost = f"https://{ip} {{\n"
    assert text.count(vhost) == 1
    start = text.index(vhost)
    assert text.count(MARKER) == 1 and text.index(MARKER) > start
    # Existing literal-IP vhost is the last vhost. Do not modify any domain routes.
    assert "\n}\n" not in text[start:text.index(MARKER)]
    return text.replace(MARKER, fragment + MARKER).encode()


if __name__ == "__main__":
    manifest = {"sites": SITES, "hosts": {}}
    for name, ip in HOSTS.items():
        baseline = subprocess.check_output(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", name,
             "cat /etc/enclave-bootstrap-tls/Caddyfile"], timeout=30)
        candidate = transform(baseline, ip)
        assert transform(candidate, ip) == candidate
        (ROOT / f"{name}.before.caddy").write_bytes(baseline)
        (ROOT / f"{name}.candidate.caddy").write_bytes(candidate)
        manifest["hosts"][name] = {
            "ip": ip, "beforeSha256": sha(baseline), "candidateSha256": sha(candidate)
        }
    (ROOT / "plan.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
