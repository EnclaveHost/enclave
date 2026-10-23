#!/usr/bin/env python3
"""Operator PKI for ONE role's export (l1 or base). There is a private CA per role, so an l1 client can never be
accepted by the base export, and the reverse is also refused.

  pki.py init-ca      --role R --ca CADIR [--days N]                            desktop, operator-only directory
  pki.py issue-server --role R --ca CADIR --name enclave-rpc-hdd-R.<x> --ip A --out SERVERDIR   desktop
  pki.py client-key   --role R --out CLIENTDIR                                   inside the VM: the key never leaves it
  pki.py sign-client  --role R --ca CADIR --csr FILE --out CERT                   desktop, after the CSR is copied over
  pki.py install-client --role R --cert CERT --ca-cert CA --dir CLIENTDIR         inside the VM

Every output directory or file must not already exist (no overwrite). Keys are written 0600 in 0700 directories. The
repository holds no key. Uses only the installed `openssl`.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ORG = "Enclave RPC HDD"


def sh(*argv, **kw):
    r = subprocess.run(argv, capture_output=True, timeout=120, **kw)
    if r.returncode != 0:
        sys.exit(f"{argv[0]} {' '.join(argv[1:3])}: {r.stderr.decode(errors='replace').strip()[:400]}")
    return r.stdout.decode(errors="replace")


def fresh_dir(d):
    if os.path.lexists(d):
        sys.exit(f"{d} already exists; nothing is overwritten")
    os.makedirs(d, mode=0o700)
    os.chmod(d, 0o700)


def keygen(path):
    old = os.umask(0o077)
    try:
        sh("openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path)
    finally:
        os.umask(old)
    os.chmod(path, 0o600)


def role_ok(r):
    if r not in ("l1", "base"):
        sys.exit("--role must be l1 or base")
    return r


def ext_file(text):
    f = tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False)
    f.write(text); f.close()
    return f.name


def client_subject(role):
    return f"/O={ORG}/CN=enclave-rpc-{role}-client"


def qemu_dn(cert):
    """The DN in the form qemu 11.1.2's authz-simple compares: certificate (forward) RDN order, comma-separated. Observed
    in its own refusal log, "TLS x509 authz check for O=Enclave RPC HDD,CN=enclave-rpc-l1-client is denied". It is NOT
    the RFC 4514 reversed form that certtool -i prints."""
    out = sh("openssl", "x509", "-in", cert, "-noout", "-subject", "-nameopt", "sep_comma_plus,esc_2253,esc_ctrl,esc_msb,utf8,sname").strip()
    return out.split("subject=", 1)[1].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["init-ca", "issue-server", "client-key", "sign-client", "install-client"])
    ap.add_argument("--role", required=True)
    for k in ("ca", "name", "ip", "out", "csr", "cert", "ca-cert", "dir"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--days", type=int, default=825)
    a = ap.parse_args()
    role = role_ok(a.role)
    if a.cmd == "init-ca":
        fresh_dir(a.ca)
        keygen(os.path.join(a.ca, "ca-key.pem"))
        x = ext_file("[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n")
        sh("openssl", "req", "-new", "-x509", "-key", os.path.join(a.ca, "ca-key.pem"), "-subj", f"/O={ORG}/CN=enclave-rpc-hdd-{role}-ca",
           "-days", str(a.days), "-sha256", "-config", x, "-extensions", "v3", "-out", os.path.join(a.ca, "ca-cert.pem"))
        os.unlink(x)
        print(os.path.join(a.ca, "ca-cert.pem"))
    elif a.cmd == "issue-server":
        if not (a.name or "").startswith(f"enclave-rpc-hdd-{role}.") or not re.fullmatch(r"[a-z0-9.-]{1,200}", a.name):
            sys.exit(f"--name must be enclave-rpc-hdd-{role}.<domain> (lowercase)")
        if not re.fullmatch(r"[0-9a-fA-F.:]{2,45}", a.ip or ""):
            sys.exit("--ip must be the literal address the export binds")
        fresh_dir(a.out)
        key = os.path.join(a.out, "server-key.pem")
        keygen(key)
        csr = os.path.join(a.out, "server.csr")
        sh("openssl", "req", "-new", "-key", key, "-subj", f"/O={ORG}/CN={a.name}", "-out", csr)
        x = ext_file(f"[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
                     f"subjectAltName=DNS:{a.name},IP:{a.ip}\n")
        sh("openssl", "x509", "-req", "-in", csr, "-CA", os.path.join(a.ca, "ca-cert.pem"), "-CAkey", os.path.join(a.ca, "ca-key.pem"),
           "-CAcreateserial", "-days", str(a.days), "-sha256", "-extfile", x, "-extensions", "v3", "-out", os.path.join(a.out, "server-cert.pem"))
        os.unlink(x); os.unlink(csr)
        shutil.copyfile(os.path.join(a.ca, "ca-cert.pem"), os.path.join(a.out, "ca-cert.pem"))
        for f in ("server-cert.pem", "ca-cert.pem"):
            os.chmod(os.path.join(a.out, f), 0o644)
        print(a.out)
    elif a.cmd == "client-key":
        fresh_dir(a.out)
        key = os.path.join(a.out, "client-key.pem")
        keygen(key)
        sh("openssl", "req", "-new", "-key", key, "-subj", client_subject(role), "-out", os.path.join(a.out, "client.csr"))
        print(os.path.join(a.out, "client.csr"))
    elif a.cmd == "sign-client":
        if os.path.lexists(a.out):
            sys.exit(f"{a.out} exists; nothing is overwritten")
        sh("openssl", "req", "-in", a.csr, "-noout", "-verify")
        subj = sh("openssl", "req", "-in", a.csr, "-noout", "-subject", "-nameopt", "compat").strip()
        if subj != f"subject={client_subject(role)}":
            sys.exit(f"CSR subject {subj!r} is not exactly {client_subject(role)!r}; refusing to sign")
        x = ext_file("[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n")
        sh("openssl", "x509", "-req", "-in", a.csr, "-CA", os.path.join(a.ca, "ca-cert.pem"), "-CAkey", os.path.join(a.ca, "ca-key.pem"),
           "-CAcreateserial", "-days", str(a.days), "-sha256", "-extfile", x, "-extensions", "v3", "-out", a.out)
        os.unlink(x)
        print(f"clientIdentity (export config tls.clientIdentity): {qemu_dn(a.out)}")
    elif a.cmd == "install-client":
        d = a.dir
        if not os.path.isfile(os.path.join(d, "client-key.pem")):
            sys.exit(f"{d}/client-key.pem missing: run client-key first")
        for src, dst in ((a.cert, "client-cert.pem"), (a.ca_cert, "ca-cert.pem")):
            if os.path.lexists(os.path.join(d, dst)):
                sys.exit(f"{d}/{dst} exists; nothing is overwritten")
            shutil.copyfile(src, os.path.join(d, dst)); os.chmod(os.path.join(d, dst), 0o644)
        os.unlink(os.path.join(d, "client.csr")) if os.path.exists(os.path.join(d, "client.csr")) else None
        print(d)


if __name__ == "__main__":
    main()
