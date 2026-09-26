#!/bin/bash
set -u
mkdir -p /etc/nan-relay /opt/nan-relay; cp -r /t/relay/. /opt/nan-relay/; cp /t/systemctl /usr/local/bin/systemctl
sleep 3600 & echo $! > /tmp/pid
mk() { { echo "FOO=1"; echo "SECRETS_KEY=not-a-real-key"; echo "METAL_VBS_ENCLAVE_MEASUREMENTS=aa,bb"; echo "BAR=2"; echo "METAL_VBS_ALLOW_TESTSIGNING=0"; echo "LAST=3"; } > /etc/nan-relay/api-relay.env; chmod 600 /etc/nan-relay/api-relay.env; }
mk; cp -p /etc/nan-relay/api-relay.env /root/orig
run() { rm -f /tmp/restarted; MODE=$1 STAMP=$2 bash -s < /t/hv-attach-remote.sh; echo "rc=$?"; }
echo "== 1 on"; run on T1; echo "   env now:"; cut -d= -f1 /etc/nan-relay/api-relay.env | tr '\n' ' '; echo; stat -c '%a %U' /etc/nan-relay/api-relay.env
echo "== 2 on again (must refuse)"; run on T2
echo "== 3 off"; run off T3; cut -d= -f1 /etc/nan-relay/api-relay.env | tr '\n' ' '; echo
echo "== 4 off again (must refuse)"; run off T4
echo "== 5 on with the EK bundle missing (must refuse, nothing changed)"; mv /opt/nan-relay/fixtures/tpm-roots.pem /tmp/pem; cp -p /etc/nan-relay/api-relay.env /root/before5; run on T5; cmp /root/before5 /etc/nan-relay/api-relay.env && echo "   env unchanged"; mv /tmp/pem /opt/nan-relay/fixtures/tpm-roots.pem
echo "== 6 on with a tampered certs.js (must refuse)"; echo "//x" >> /opt/nan-relay/certs.js; run on T6; cp /t/relay/certs.js /opt/nan-relay/certs.js
echo "== 7 on, the relay crashes after the restart (must roll back instantly)"; cp -p /etc/nan-relay/api-relay.env /root/before7; touch /tmp/crash; run on T7; cmp /root/before7 /etc/nan-relay/api-relay.env && echo "   env is the pre-flip copy again"; stat -c '%a %U' /etc/nan-relay/api-relay.env
echo "== 8 env 0644 (must refuse)"; chmod 644 /etc/nan-relay/api-relay.env; run on T8; chmod 600 /etc/nan-relay/api-relay.env
echo "restarts total: $(wc -l < /tmp/restarts) (expected 4: on, off, the crashing on + its rollback)"
