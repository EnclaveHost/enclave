#!/usr/bin/env bash
# Validate both candidate configs with the DEPLOYED G3 role code (g3-final-package/tree roles.mjs bf27ddd9), every service.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/hs2-r6
T=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package/tree
sha256sum $T/network/host-services/roles.mjs host-services.r6*.json | cut -c1-16,65-
node --input-type=module -e "
import fs from 'node:fs';
const {ROLES}=await import('$T/network/host-services/roles.mjs');
for (const f of ['live-47f3e1f.json','host-services.r6-upstream.json','host-services.r6.json']) {
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  for (const s of d.services) { try { const c=ROLES[s.role].validate(s.config); const env=s.role==='route-dns'?ROLES[s.role].launch(c).env:null;
      console.log(f, s.role, 'VALID', env?('CHALLENGE_TXT_UPSTREAM='+env.CHALLENGE_TXT_UPSTREAM+' NS_NAME='+env.NS_NAME+' TRANSPORT='+(env.DNS_RL_TRANSPORT_PER_SEC||'-')):'', s.role==='service-tls'?('orders='+s.config.orders):''); }
    catch(e){ console.log(f, s.role, 'REFUSED', e.message); process.exitCode=1; } }
}"
