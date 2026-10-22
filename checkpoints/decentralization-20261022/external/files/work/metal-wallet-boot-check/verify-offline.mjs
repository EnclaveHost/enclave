import fs from 'node:fs/promises';
import {createHash,X509Certificate,verify} from 'node:crypto';
import {parseSnpReport,vcekMatchesReport,checkMinTcb,seedCertChain} from '../enclave/relay/snp-verify.mjs';
const doc=JSON.parse(await fs.readFile(new URL('./rad.json',import.meta.url)));
const report=Buffer.from(doc.body,'base64'),parsed=parseSnpReport(report);
const root=new URL('../../',import.meta.url),out=new URL('outputs/metal-host-policy-delivery/',root);
const candidates=['../enclave/test/fixtures/verifier/turin-m4a-app-2026-10-17/vcek-kds-amd.der','../enclave/test/fixtures/verifier/turin-m4a/vcek-kds-amd.der'];
let cert,source;
for(const file of candidates){const bytes=await fs.readFile(new URL(file,import.meta.url));if(!vcekMatchesReport(bytes,'Turin',parsed)){cert=new X509Certificate(bytes);source=file;break;}}
if(!cert)throw Error('no matching cached public VCEK');
const chain=await fs.readFile(new URL('../enclave/test/fixtures/amd/Turin-cert_chain.pem',import.meta.url),'utf8');
const [ask,ark]=seedCertChain('Turin',chain); // independently enforces AMD pinned root
const signature=Buffer.concat([Buffer.from(report.subarray(0x2a0,0x2d0)).reverse(),Buffer.from(report.subarray(0x2e8,0x318)).reverse()]);
if(!verify('sha384',report.subarray(0,0x2a0),{key:cert.publicKey,dsaEncoding:'ieee-p1363'},signature)||!cert.verify(ask.publicKey)||!ask.verify(ark.publicKey)||!ark.verify(ark.publicKey))throw Error('AMD signature chain failed');
const m=JSON.parse(await fs.readFile(new URL('../metal-wallet-control-image/manifest.json',import.meta.url)));
if(parsed.measurement.toString('hex')!==m.expectedMeasurement.byVcpus['2'])throw Error('measurement mismatch');
if(parsed.vmpl!==0 || parsed.policy&((1n<<19n)|(1n<<18n)))throw Error('unacceptable guest policy');
const bound=createHash('sha256').update(Buffer.from(doc.transportKey,'base64')).digest();
if(!bound.equals(parsed.reportData.subarray(0,32)))throw Error('transport key binding mismatch');
const tcb=checkMinTcb(JSON.parse(await fs.readFile(new URL('./min-tcb.json',import.meta.url))),'Turin',parsed);
if(!tcb.ok||!tcb.checked)throw Error('firmware floor not satisfied: '+tcb.reason);
const result={verifiedAt:new Date().toISOString(),ok:true,hardwareSignatureVerified:true,amdPinnedRootVerified:true,vcekChipAndTcbMatch:true,measurement:parsed.measurement.toString('hex'),expectedMeasurementMatched:true,vmpl:parsed.vmpl,debugAllowed:false,migrationAgentAllowed:false,staticTransportKeyBindingVerified:true,freshChallengeVerified:false,tcb,certificateSource:source,networkUsed:false,productionActivation:false};
await fs.writeFile(new URL('control-attestation-verification.json',out),JSON.stringify(result,null,2)+'\n');
await fs.writeFile(new URL('control-vcek.der',out),cert.raw);await fs.writeFile(new URL('control-amd-chain.pem',out),chain);
console.log(JSON.stringify(result));
