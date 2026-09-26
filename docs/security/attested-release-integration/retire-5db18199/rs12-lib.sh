# rs-12's NucBox checks (enclave-87: "nucbox-k11 attach ACCEPTED" when a relay window runs mid-soak), as rs-11 ran them
HV=nucbox-k11
hv_row() { curl -sS -m 20 https://api.enclave.host/enclaves | python3 -c '
import json, sys
r = [e for e in json.load(sys.stdin).get("enclaves", []) if e.get("name") == sys.argv[1]]
if not r: print("absent"); sys.exit(0)
e = r[0]; print(e.get("mode") or "-", "true" if e.get("ownerOnly") is True else "false", *sorted(d.get("id", "") for d in (e.get("servesDeployments") or [])))' "${1:-$HV}"; }
hv_attach_line() { $NAN "journalctl _SYSTEMD_INVOCATION_ID=$1 --no-pager -o short-iso-precise | grep -m1 -F '[tunnel] ${2:-$HV} attached via attestation(hv-node)'" || true; }
