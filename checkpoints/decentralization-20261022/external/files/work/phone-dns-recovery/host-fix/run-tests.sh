#!/bin/bash
# RelayDial candidate tests + the deployed-Ws negative control. Exit status = the real javac/java statuses.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/host-fix
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cd "$T"
for n in relay other doh; do
  keytool -genkeypair -alias $n -keyalg EC -groupname secp256r1 -dname "CN=$n.enclave.test" -ext "SAN=dns:$n.enclave.test" \
    -validity 2 -keystore $n.p12 -storetype PKCS12 -storepass testpass -keypass testpass >/dev/null 2>&1
  keytool -exportcert -alias $n -keystore $n.p12 -storepass testpass -file $n.crt >/dev/null 2>&1
  keytool -importcert -noprompt -alias $n -file $n.crt -keystore trust.p12 -storetype PKCS12 -storepass testpass >/dev/null 2>&1
done
APP=$H/candidate/shielded/anchor/avf/host/app; BASE=$H/base/shielded/anchor/avf/host/app
mkdir cand base
echo "== candidate: javac RelayDial.java Ws.java RelayDialTest.java"
javac --release 17 -d cand $APP/RelayDial.java $APP/Ws.java $H/test/RelayDialTest.java
java -Xmx128m -cp cand host.enclave.anchor.avf.RelayDialTest "$T"
echo "== negative control: the deployed Ws.java (base) unchanged"
javac --release 17 -d base $BASE/Ws.java $H/test/BaseWsControl.java
java -Xmx128m -Djavax.net.ssl.trustStore="$T/trust.p12" -Djavax.net.ssl.trustStorePassword=testpass -Djavax.net.ssl.trustStoreType=PKCS12 \
  -cp base host.enclave.anchor.avf.BaseWsControl "$T"
echo "ALL DONE"
