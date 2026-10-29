// Operator inputs for the native launcher. These public pins select a build;
// they do not authorize an owner-secret release or attest GPU execution.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {validateDesktopAdmission} from './desktop-admission.mjs';
import {checkPin} from './egress.mjs';
import {shieldedCard} from '../../node/shieldedcard.mjs';

export function loadDesktopConfig(file, pin) {
  if (!file || typeof file !== 'string' || typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin))
    throw new Error('desktop config needs a path and SHA256 pin');
  if (fs.statSync(file).size > 65536) throw new Error('desktop config exceeds 64 KiB');
  const bytes=fs.readFileSync(file);
  if (bytes.length > 65536 || createHash('sha256').update(bytes).digest('hex') !== pin)
    throw new Error('desktop config differs from its pin');
  const cfg=JSON.parse(bytes.toString('utf8'));
  const keys=['imagePath','platform','runtime','bridge','workerPort','workerBudgetGb'];
  if (!cfg || Array.isArray(cfg) || Object.keys(cfg).sort().join() !== keys.sort().join())
    throw new Error('desktop config requires exactly imagePath, platform, runtime, bridge, workerPort and workerBudgetGb');
  const admission=validateDesktopAdmission({platform:cfg.platform,runtime:cfg.runtime});
  if (typeof cfg.imagePath !== 'string' || !cfg.imagePath || cfg.imagePath.includes('\0')) throw new Error('desktop image path is required');
  if (!Number.isInteger(cfg.workerPort) || cfg.workerPort < 1 || cfg.workerPort > 65535
      || typeof cfg.workerBudgetGb !== 'number' || cfg.workerBudgetGb <= 0 || !Number.isSafeInteger(cfg.workerBudgetGb * 2 ** 30))
    throw new Error('desktop worker port or budget is invalid');
  if (!cfg.bridge || Object.keys(cfg.bridge).sort().join() !== 'exe,sha256') throw new Error('desktop needs the pinned worker bridge');
  if (typeof cfg.bridge.exe !== 'string' || !cfg.bridge.exe || cfg.bridge.exe.includes('\0')
      || typeof cfg.bridge.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cfg.bridge.sha256))
    throw new Error('desktop worker bridge path or pin is invalid');
  checkPin(cfg.bridge.exe,cfg.bridge.sha256,'the native desktop worker bridge');
  const freeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;};
  return freeze({...cfg,admission});
}

export async function probeDesktopWorker(cfg, readCard=shieldedCard) {
  const card=await readCard({port:cfg.workerPort});
  // The worker represents its version as a JSON integer triple, normalized
  // by shieldedCard to comma-separated text. Protocol 1.3 introduced leases.
  if (!/^1,(?:[3-9]|[1-9][0-9]+),(?:0|[1-9][0-9]*)$/.test(card?.protocol)
      || card.vramBudgetGb !== cfg.workerBudgetGb)
    throw new Error('native worker protocol or budget differs from its configuration');
  return card;
}
