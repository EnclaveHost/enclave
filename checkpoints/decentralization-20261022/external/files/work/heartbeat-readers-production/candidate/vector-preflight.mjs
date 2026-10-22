import fs from 'node:fs';
import {makePredictor,predictorEnv} from './measurement-predict.mjs';
const root='/opt/enclave-predict/rollout-vector-20260927';
const env={};for(const l of fs.readFileSync('/etc/nan-relay/api-relay.env','utf8').split('\n')) {const i=l.indexOf('=');if(i<0)continue;const k=l.slice(0,i);if(!/^SECRETS_RELEASE_(PREDICT_|DOMAIN_RELEASES$|CERT_RELEASES$|SEV_SNP_MEASURE)/.test(k))continue;env[k]=l.slice(i+1).replace(/^(['"])(.*)\1$/,'$2');}
const rid='c427ef6351b62a190eff7d0361c641268211e8eeee26c986388ec52463d17b48';
env.SECRETS_RELEASE_PREDICT_COMMIT='ffb5b3e8f208bfef29ad1aae6300af2a807e4880';
env.SECRETS_RELEASE_PREDICT_RELEASES+=','+rid+'='+root+'/release';
env.SECRETS_RELEASE_DOMAIN_RELEASES+=','+rid;env.SECRETS_RELEASE_CERT_RELEASES+=','+rid;
env.SECRETS_RELEASE_PREDICT_WORK=root+'/preflight-work';env.SECRETS_RELEASE_PREDICT_SEED+=':'+'/opt/enclave-predict/rollout-shield-20260927/seed';
const p=makePredictor({...predictorEnv(env),readCatalog:async()=>({app:{active:true},version:{cid:'bafkreia22f5ulyjkvppmrsqikogodu5hswt6ndb3q7ktjnidaxkwktfdhe',memMb:1024,ports:'',approval:1,yanked:false}})});
console.log('problems',p.problems);
const kat=await p.selfTest();console.log('knownAnswers',kat);if(!kat.ok)process.exit(1);
const prediction=await p.expectedFor('catalog://0x'+'ab'.repeat(32)+'/0',{inference:{model:'qwen3.8-27b-mtp-q4-vl-gguf',gpuMilli:500}});
console.log(JSON.stringify(prediction,null,2));
if(!prediction.ok || !prediction.images.some(x=>x.release===rid))process.exit(1);
fs.writeFileSync(root+'/prediction.json',JSON.stringify(prediction,null,2));
