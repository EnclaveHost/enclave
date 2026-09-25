#!/usr/bin/env python3
"""hvlab.py - a LOCAL stand-in for the NucBox launcher (windows/vbslike/host, Rust), so the guest runtime that runs
inside a Hyper-V partition can be exercised end to end on a Linux KVM host before it is handed to the Windows owner.

It is a test fixture, not a backend. It does on vsock what vbslike-host does on hv_sock, and nothing more:
  signer  host vsock port 9001: the monitor's -report-host backend. Signs report_data in the launcher's format
          (report.rs: Ed25519 over "vbslike-report-v1\\n" || canonical(doc)) ONLY when its app half is an ID this
          fixture loaded into THAT guest (by vsock CID), exactly the launcher's rule. It says what it is:
          platform.partition names a KVM fixture, hostExcluded false, tier T0-hv.
  load    host -> guest vsock port 9000: the monitor's `load` (JSON line + the bundle's bytes); records the AppID
          the monitor computed for that CID and refuses to go on if it differs from this side's hash.
  relay   127.0.0.1:<port> -> guest vsock <port>: bytes only; TLS ends in the domain.

  usage:  hvlab.py signer <state dir>                 (foreground; the key is <state dir>/launcher.key, made once)
          hvlab.py load <state dir> <cid> <bundle> [label] [name]   prints the monitor's answer (JSON); name = the
                                                    deployment name the domain may certify (<8 hex>.<zone>)
          hvlab.py destroy <cid> <domain id>                 the monitor's destroy (the domain ends, its port closes)
          hvlab.py relay <cid> <vsock port> <tcp port>       (foreground)
          hvlab.py pubkey <state dir>                 prints the fixture launcher's public key (base64)
"""
import base64, hashlib, json, os, socket, sys, threading, time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

SIGN_DOMAIN = b"vbslike-report-v1\n"
FORMAT, TIER = "hyperv-partition-domain/v1", "T0-hv"
BOUNDARY = "tier=T0-hv partition=kvm-plain-fixture isolation=none host_excluded=no signer=hvlab-fixture-on-host"
CID_ANY, CID_HOST = 0xFFFFFFFF, 2


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def key(state):
    p = os.path.join(state, "launcher.key")
    if not os.path.exists(p):
        k = Ed25519PrivateKey.generate()
        with open(p, "wb") as f:
            f.write(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))
        os.chmod(p, 0o600)
    return Ed25519PrivateKey.from_private_bytes(open(p, "rb").read())


def pub_b64(k):
    return base64.b64encode(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()


def loaded(state):
    try:
        return json.load(open(os.path.join(state, "loaded.json")))
    except FileNotFoundError:
        return {}


def signer(state):
    k, started = key(state), int(time.time() * 1000)
    image = hashlib.sha256(open(os.environ["HVLAB_IMAGE"], "rb").read()).hexdigest() if os.environ.get("HVLAB_IMAGE") else ""
    kern = hashlib.sha256(open(os.environ["HVLAB_KERNEL"], "rb").read()).hexdigest() if os.environ.get("HVLAB_KERNEL") else ""
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.bind((CID_ANY, 9001))
    s.listen(16)
    print(f"HVLAB signer on vsock 9001, launcher key {pub_b64(k)}", flush=True)
    while True:
        c, (cid, _) = s.accept()
        threading.Thread(target=sign_one, args=(c, cid, state, k, started, image, kern), daemon=True).start()


def sign_one(c, cid, state, k, started, image, kern):
    with c:
        c.settimeout(10)
        buf = b""
        while not buf.endswith(b"\n") and len(buf) < 4096:
            b = c.recv(4096)
            if not b:
                break
            buf += b
        try:
            req = json.loads(buf)
            rd = bytes.fromhex(req["reportData"])
            assert len(rd) == 64
        except Exception as e:
            c.sendall((json.dumps({"error": f"bad request: {e}"}) + "\n").encode())
            return
        rec = loaded(state).get(str(cid))
        app = rd[32:].hex()
        if not rec or app != rec["appSha256"]:
            print(f"HVLAB signer REFUSED cid={cid}: app {app[:16]}... was not loaded into this guest", flush=True)
            c.sendall((json.dumps({"error": "this launcher did not load that app into this partition"}) + "\n").encode())
            return
        doc = {"format": FORMAT, "tier": TIER,
               "platform": {"os": "linux", "hypervisor": "kvm", "partition": "kvm-plain-fixture (hvlab, NOT Hyper-V)",
                            "isolation": "none", "hostExcluded": False},
               "launcher": {"key": pub_b64(k), "startedMs": started},
               "partition": {"vmId": f"hvlab-cid-{cid}", "guestImageSha256": image, "kernelSha256": kern,
                             "vcpus": 1, "memMiB": rec.get("memMiB", 0)},
               "domain": {"label": rec.get("label", ""), "appSha256": app},
               "reportData": rd.hex(), "boundary": BOUNDARY, "issuedMs": int(time.time() * 1000)}
        sig = k.sign(SIGN_DOMAIN + canonical(doc).encode())
        c.sendall((json.dumps({"report": {"doc": doc, "sig": base64.b64encode(sig).decode()}}) + "\n").encode())
        print(f"HVLAB signed cid={cid} app={app[:16]}...", flush=True)


def load(state, cid, bundle, label="", name=""):
    data = open(bundle, "rb").read()
    mine = hashlib.sha256(data).hexdigest()
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(120)
    s.connect((int(cid), 9000))
    req = {"cmd": "load", "label": label, "size": len(data), **({"name": name} if name else {})}
    s.sendall((json.dumps(req) + "\n").encode() + data)
    buf = b""
    while not buf.endswith(b"\n"):
        b = s.recv(65536)
        if not b:
            break
        buf += b
    ans = json.loads(buf)
    if "error" in ans:
        sys.exit(f"HVLAB load refused: {ans['error']}")
    if ans.get("appSha256") != mine:
        sys.exit(f"HVLAB hash disagreement: fixture {mine} guest {ans.get('appSha256')}")
    st = loaded(state)
    st[str(cid)] = {"appSha256": mine, "label": label, "memMiB": ans.get("memMiB", 0)}
    json.dump(st, open(os.path.join(state, "loaded.json"), "w"))
    print(json.dumps(ans))


def destroy(cid, dom_id):
    """the monitor's own `destroy`: the domain's process tree ends and its port closes (a lease end, a relaunch)"""
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(60)
    s.connect((int(cid), 9000))
    s.sendall((json.dumps({"cmd": "destroy", "id": int(dom_id)}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        b = s.recv(4096)
        if not b:
            break
        buf += b
    ans = json.loads(buf or b"{}")
    if "destroyed" not in ans:
        sys.exit(f"HVLAB destroy refused: {ans.get('error', 'no answer')}")
    print(json.dumps(ans))


def relay(cid, vport, tport):
    l = socket.socket()
    l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    l.bind(("127.0.0.1", int(tport)))
    l.listen(64)
    print(f"HVLAB relay 127.0.0.1:{tport} -> vsock {cid}:{vport}", flush=True)

    def pump(a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                b.sendall(d)
        except OSError:
            pass
        for x in (a, b):
            try:
                x.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    while True:
        c, _ = l.accept()
        try:
            v = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
            v.connect((int(cid), int(vport)))
        except OSError:
            c.close()
            continue
        threading.Thread(target=pump, args=(c, v), daemon=True).start()
        threading.Thread(target=pump, args=(v, c), daemon=True).start()


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["signer"]:
        signer(a[1])
    elif a[:1] == ["load"]:
        load(*a[1:])
    elif a[:1] == ["destroy"]:
        destroy(*a[1:])
    elif a[:1] == ["relay"]:
        relay(*a[1:])
    elif a[:1] == ["pubkey"]:
        print(pub_b64(key(a[1])))
    else:
        sys.exit(__doc__)
