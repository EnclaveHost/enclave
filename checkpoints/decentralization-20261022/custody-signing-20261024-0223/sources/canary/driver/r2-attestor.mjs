// Called only after CLI checkRepo verifies HEAD, tracked files and every configured source hash.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {R2} from './plan.mjs';
import {attestR2Custodian,checkR2Manifest} from './attestation.mjs';
const FILES=['relay/snp-verify.mjs','custody/v2/member.mjs','custody/v2/digests.mjs','custody/rules.mjs'];
export async function loadR2Attestor(pins) {
 if(pins.repo?.commit!==R2.commit)throw Error('attestor requires reviewed r2 source');
 for(const rel of FILES){
  const want=pins.repo.files?.[rel];
  if(!/^[0-9a-f]{64}$/.test(want??'')||createHash('sha256').update(fs.readFileSync(path.join(pins.repo.path,rel))).digest('hex')!==want)
   throw Error('attestor source is missing its verified file pin');
 }
 const file=pins.custodian?.manifestFile;
 if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==file||!fs.statSync(file).isFile()||fs.statSync(file).size>1024*1024)throw Error('attestor requires an absolute regular manifest file');
 const manifestBytes=fs.readFileSync(file);checkR2Manifest(manifestBytes);
 const verifier=await import(pathToFileURL(path.join(pins.repo.path,'relay/snp-verify.mjs')).href);
 const {machineBinding}=await import(pathToFileURL(path.join(pins.repo.path,'custody/v2/member.mjs')).href);
 return ()=>attestR2Custodian({endpoint:pins.custodian.endpoint,manifestBytes,verifier,bindingOf:machineBinding});
}
