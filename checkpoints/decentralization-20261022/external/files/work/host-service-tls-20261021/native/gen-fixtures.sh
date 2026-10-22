#!/usr/bin/env bash
# Fixture PKI for the native Windows G3 harness (generated on Linux; Windows needs no openssl):
# root CA -> intermediate CA -> leaf (SAN = the two derived names of host 0x11..11 in zone native-test.invalid),
# plus a NON-CA intermediate and a leaf under it (must be refused by the TLS verifier). Valid 60 days from generation.
set -euo pipefail
D=$(dirname "$0")/fixtures; rm -rf "$D"; mkdir -p "$D"; cd "$D"
N1=dir-ceirceirceirceirceirceirceirceirceirceirceirceirceiq.native-test.invalid
N2=boot-ceirceirceirceirceirceirceirceirceirceirceirceirceiq.native-test.invalid
ec() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key"; }
ec root; openssl req -x509 -new -key root.key -subj "/CN=G3 native fixture root" -days 60 -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -out root.pem
for i in int int-noca; do
  ec $i; openssl req -new -key $i.key -subj "/CN=G3 native $i" -out $i.csr
  ca=TRUE; [ $i = int-noca ] && ca=FALSE
  printf 'basicConstraints=critical,CA:%s\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\n' $ca > $i.ext
  openssl x509 -req -in $i.csr -CA root.pem -CAkey root.key -set_serial 0x$(openssl rand -hex 8) -days 60 -extfile $i.ext -out $i.pem
done
for i in int int-noca; do
  ec leaf-$i; openssl req -new -key leaf-$i.key -subj "/O=G3 native fixture leaf" -out leaf-$i.csr
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s,DNS:%s\n' $N1 $N2 > leaf-$i.ext
  openssl x509 -req -in leaf-$i.csr -CA $i.pem -CAkey $i.key -set_serial 0x$(openssl rand -hex 8) -days 30 -extfile leaf-$i.ext -out leaf-$i.pem
  openssl pkcs8 -topk8 -nocrypt -in leaf-$i.key -out leaf-$i.p8.pem
done
node -e "
const fs=require('fs');const r=f=>fs.readFileSync(f,'utf8');
fs.writeFileSync('fixtures.json',JSON.stringify({names:['$N1','$N2'],root:r('root.pem'),
 good:{keyPem:r('leaf-int.p8.pem'),chainPem:r('leaf-int.pem')+r('int.pem')},
 nonCa:{keyPem:r('leaf-int-noca.p8.pem'),chainPem:r('leaf-int-noca.pem')+r('int-noca.pem')},
 notAfter:new (require('crypto').X509Certificate)(r('leaf-int.pem')).validTo},null,1));"
rm -f *.key *.csr *.ext root.pem int*.pem leaf-*.pem; ls; echo "fixture leaf notAfter: $(node -e "console.log(require('./fixtures.json').notAfter)")"
