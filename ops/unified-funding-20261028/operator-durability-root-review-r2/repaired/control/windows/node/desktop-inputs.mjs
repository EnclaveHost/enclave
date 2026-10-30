// Public bytes for privacy-agent enrollment. The same host planner used before
// purchase supplies configuration; the controller is rehashed even when cached.
import fs from 'node:fs';
import path from 'node:path';
import { fetchArtifact } from './apprun.mjs';
import { deriveApprovedDesktop } from '../../relay/shield-desktop-release.mjs';
import { DESKTOP_DERIVATION } from '../../relay/shield-desktop-derive.mjs';

export async function nativeEnrollmentInputs(host, row, version, { fetchComponent = fetchArtifact } = {}) {
  const plan = await host.isolationVerdict(row.id,row,version,{
    envRead:true,envOpts:host.envelopeOf(row.configCid,row.gpuMilli) });
  if (!plan.ok || plan.derivation !== DESKTOP_DERIVATION)
    throw new Error(`native enrollment plan refused: ${plan.input || 'derivation'} ${plan.why || ''}`);
  const record = plan.spawn.derive;
  const artifact = await fetchComponent({cid:record.cid,dir:path.join(host.cfg.dir,'desktop-public'),
    python:host.cfg.python,gateway:host.cfg.gateway,maxBytes:256<<20});
  const fd = fs.openSync(artifact.path,fs.constants.O_RDONLY|(fs.constants.O_NONBLOCK??0));
  let component;
  try {
    const size=fs.fstatSync(fd);
    if(!size.isFile()||size.size<8||size.size>(256<<20))throw new Error('native controller must be a bounded regular file');
    const bytes=Buffer.alloc(size.size+1);let length=0;
    while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
    if(length!==size.size)throw new Error('native controller changed size during read');
    component=bytes.subarray(0,length);
  } finally {fs.closeSync(fd);}
  deriveApprovedDesktop({release:host.desktopRelease,record,component});
  return {config:Buffer.from(record.configBase64,'base64').toString('utf8'),component};
}
