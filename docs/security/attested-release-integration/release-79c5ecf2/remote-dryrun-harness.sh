#!/bin/bash
# inside the container, as root
set -u
rm -rf /opt/enclave-predict   # the image carries an earlier staging (my memory test): start clean
mkdir -p /etc/nan-relay /opt/enclave-predict/829c09adb176/work /opt/enclave-predict/829c09adb176/releases /opt/enclave-predict/rel-79c5ecf24eb4
cp /t/release-manifest.py /opt/enclave-predict/829c09adb176/work/
for d in release-0181bce3 release-6757d139 release-17e182a8; do cp -a /r/$d /opt/enclave-predict/829c09adb176/releases/$d; done
cp -a /r/release-aa6c985c /opt/enclave-predict/rel-79c5ecf24eb4/release
cp /t/dest/* /opt/enclave-predict/rel-79c5ecf24eb4/
cp /t/systemctl /usr/local/bin/systemctl
mk() { { echo "FOO=1"; echo "SECRETS_KEY=not-a-real-key"; cat /t/predict11.env; } > /etc/nan-relay/api-relay.env; chmod 600 /etc/nan-relay/api-relay.env; }
mk; cp -p /etc/nan-relay/api-relay.env /root/env.orig
E="DEST=/opt/enclave-predict/rel-79c5ecf24eb4 NEW_SHA=6f816b31766403acb439ccdc6bffde2cc32ecbfbd775d4cc2534d3d1163d5c55 OLD_SHA=b3f4a67aa76fe9aed4c724ae7d890c9b4883eb586bb470967d735bc719288fd7"
run() { env $E MODE=$1 STAMP=$2 bash -s < /t/rs-4-remote.sh; echo "rc=$?"; }
echo "== 1 apply"; run apply T1
echo "   diff vs original:"; diff /root/env.orig /etc/nan-relay/api-relay.env | cut -c1-110; stat -c '%a %U' /etc/nan-relay/api-relay.env; ls /etc/nan-relay/; cat /tmp/restarts 2>/dev/null | wc -l
echo "== 2 apply again (must refuse)"; run apply T2
echo "== 3 rollback"; run rollback T3
cmp /root/env.orig /etc/nan-relay/api-relay.env && echo "   env byte-identical to the original after rollback"; stat -c '%a %U' /etc/nan-relay/api-relay.env
echo "== 4 release ON (must refuse)"; echo "SECRETS_ATTESTED_RELEASE=1" >> /etc/nan-relay/api-relay.env; run apply T4; mk
echo "== 5 tampered new lines (must refuse)"; cp -p /opt/enclave-predict/rel-79c5ecf24eb4/predict-lines.env /tmp/pl; sed -i 's/79c5ecf2/79c5ecf3/2' /opt/enclave-predict/rel-79c5ecf24eb4/predict-lines.env; run apply T5; cp -p /tmp/pl /opt/enclave-predict/rel-79c5ecf24eb4/predict-lines.env
echo "== 6 env mode 0644 (must refuse)"; chmod 644 /etc/nan-relay/api-relay.env; run apply T6; chmod 600 /etc/nan-relay/api-relay.env
echo "== 7 relay down (must refuse, before any write)"; touch /tmp/down; run apply T7; rm /tmp/down; cmp /root/env.orig /etc/nan-relay/api-relay.env && echo "   env unchanged"
echo "== 8 duplicate key (must refuse)"; echo "SECRETS_RELEASE_DOMAIN_RELEASES=x" >> /etc/nan-relay/api-relay.env; run apply T8; mk
echo "restarts total: $(cat /tmp/restarts 2>/dev/null | wc -l) (expected 2: apply + rollback)"; ls /etc/nan-relay/
