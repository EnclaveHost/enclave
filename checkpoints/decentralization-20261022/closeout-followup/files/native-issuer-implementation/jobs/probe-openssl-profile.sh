#!/usr/bin/env bash
# Probe (no network, throwaway keys): the leaf profile the EXISTING issuance tool's openssl command produces, under a test CA
# shaped like the live native CA (P-256, CA:TRUE pathlen:0, critical name constraint DNS:enclavehost.eth, multi-RDN subject).
set -euo pipefail
ssh probe 2>&1 | head -1 || true
openssl version
w=$(mktemp -d); trap 'rm -rf "$w"' EXIT; cd "$w"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -subj '/O=Probe Org/CN=Probe ENS Service CA' -days 30 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' -addext 'nameConstraints=critical,permitted;DNS:enclavehost.eth' 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out leaf.key 2>/dev/null; openssl pkey -in leaf.key -pubout -out pub.pem
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.enclavehost.eth,DNS:mcp.enclavehost.eth\n' > ext
openssl x509 -new -force_pubkey pub.pem -subj /CN=api.enclavehost.eth -CA ca.pem -CAkey ca.key -set_serial 0x1234 -days 7 -sha256 -extfile ext -out leaf.pem
echo "--- CA"; openssl x509 -in ca.pem -noout -text | sed -n '/X509v3 extensions/,/Signature Algorithm/p'
echo "--- LEAF"; openssl x509 -in leaf.pem -noout -text | sed -n '/Version/,/Subject Public Key Info/p;/X509v3 extensions/,/Signature Algorithm/p'
echo "--- LEAF DER"; openssl asn1parse -in leaf.pem | head -40
openssl verify -CAfile ca.pem -verify_hostname api.enclavehost.eth leaf.pem
echo PROBE-DONE
