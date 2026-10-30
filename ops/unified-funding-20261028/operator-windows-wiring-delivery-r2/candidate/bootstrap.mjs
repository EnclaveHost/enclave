import fs from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import path from 'node:path';
const [role,pin,...args]=process.argv.slice(2),root=path.dirname(fileURLToPath(import.meta.url));
if(!['manager','router','verify'].includes(role)||!/^[0-9a-f]{64}$/.test(pin||''))throw Error('pinned service role required');
const hash=b=>createHash('sha256').update(b).digest('hex'),raw=fs.readFileSync(path.join(root,'source-manifest.json'));
if(hash(raw)!==pin)throw Error('source manifest differs');
const m=JSON.parse(raw);
for(const [name,p] of Object.entries(m.files)){const b=fs.readFileSync(path.join(root,'control',name));if(b.length!==p.bytes||hash(b)!==p.sha256)throw Error('source file differs: '+name);}
for(const p of [{"path": "C:\\Program Files\\Enclave\\control\\windows\\node\\fetch-cid.py", "sha256": "729e6a0c252d9f45823df1d065bcfedda22d9e9e75b36f2c580af1107c32a6f6", "bytes": 2231}, {"path": "C:\\Program Files\\Enclave\\control\\windows\\node\\ipfs_fetch.py", "sha256": "93334ad552a124a05780d7447495f51d7caeb6665511df0beb60aba1b49067af", "bytes": 10467}, {"path": "C:\\ProgramData\\Enclave\\shield-config.cmd", "sha256": "d688c172b44b21267067ed390803aff1c957f01e13549e6d82f1bd4e01496047", "bytes": 2499}]){const b=fs.readFileSync(p.path);if(b.length!==p.bytes||hash(b)!==p.sha256)throw Error("external input differs: "+p.path);}
if(role==='verify'){console.log(JSON.stringify({sourceVerified:true,externalInputsVerified:true}));process.exit(0);}
process.argv=[process.argv[0],process.argv[1],...args];
await import('./control/windows/vbslike/'+role+'/main.mjs');
