#!/usr/bin/env bash
# Local only: validate r5e's route-dns block with the PATCHED role (a5 ttree) -> the exact launch env names added; and show
# that the BASE role (r5 as deployed) refuses the new key (so r5e needs the composed package, never the old bundle).
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority
node --input-type=module -e "
import fs from 'node:fs';
const cfg=JSON.parse(fs.readFileSync('final/host-services.r5e.json','utf8')).services.find(s=>s.role==='route-dns').config;
for (const t of ['ttree','ttree-base']) {
  const {ROLES}=await import(process.cwd()+'/'+t+'/network/host-services/roles.mjs');
  try { const env=ROLES['route-dns'].launch(ROLES['route-dns'].validate(cfg)).env;
    console.log(t,'VALID; CHALLENGE_TXT_UPSTREAM=',env.CHALLENGE_TXT_UPSTREAM,'DNS_READ_ONLY=',env.DNS_READ_ONLY,'NS_NAMES=',env.NS_NAMES); }
  catch(e){ console.log(t,'REFUSED:',e.message); }
}"
