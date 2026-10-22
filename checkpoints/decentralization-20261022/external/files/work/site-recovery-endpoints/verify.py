"""Download complete CARs over verified literal-IP TLS and validate every reachable block."""
import datetime
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
plan = json.loads((ROOT / "plan.json").read_text())
hosts = sys.argv[1:] or list(plan["hosts"])
for host in hosts:
    ip = plan["hosts"][host]["ip"]
    result = {"host": host, "ip": ip, "cars": [], "checks": []}
    for cid, expected in plan["sites"].items():
        out = ROOT / f"{host}.download.car"
        headers = ROOT / f"{host}.headers"
        r = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--max-time", "150",
             "--max-filesize", "50000000", "--dump-header", str(headers), "--output", str(out),
             "--write-out", "%{json}", f"https://{ip}/ipfs/{cid}?format=car"],
            capture_output=True, text=True, timeout=155)
        if r.returncode:
            raise RuntimeError(f"{host} download failed: {r.stderr}")
        transfer = json.loads(r.stdout)
        assert transfer["http_code"] == 200 and transfer["ssl_verify_result"] == 0
        assert transfer["remote_ip"] == ip and transfer["num_redirects"] == 0
        hdr = headers.read_text().lower()
        assert "content-type: application/vnd.ipld.car" in hdr
        assert "access-control-allow-origin: *" in hdr
        proof = json.loads(subprocess.check_output(
            ["node", str(ROOT / "verify-car.mjs"), str(out), cid, expected["sha256"]],
            timeout=30))
        assert proof["bytes"] == expected["bytes"]
        proof.update(tlsVerified=True, dnsRequired=False, redirects=0, url=transfer["url_effective"])
        result["cars"].append(proof)
        out.unlink()
        print(json.dumps({"host": host, **proof}), flush=True)
    for path, method, status in [
        ("/v1/network/providers", "GET", "200"),
        ("/ipfs/not-a-published-site?format=car", "GET", "404"),
        (f"/ipfs/{next(iter(plan['sites']))}?format=car", "POST", "404"),
    ]:
        code = subprocess.check_output(
            ["curl", "--silent", "--show-error", "--max-time", "20", "--output", "/dev/null",
             "--write-out", "%{http_code}", "--request", method, f"https://{ip}{path}"],
            text=True, timeout=25)
        assert code == status, (host, path, code, status)
        result["checks"].append({"path": path, "method": method, "status": int(code)})
    dashboard = subprocess.check_output(
        ["curl", "--fail", "--silent", "--show-error", "--max-time", "20",
         "--resolve", f"enclave.host:443:{ip}", "https://enclave.host/dashboard"],
        timeout=25)
    assert b"Dashboard" in dashboard and b"Page Not Found" not in dashboard
    result["dashboardPreserved"] = True
    result["verifiedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (ROOT / f"{host}.verification.json").write_text(json.dumps(result, indent=2) + "\n")
