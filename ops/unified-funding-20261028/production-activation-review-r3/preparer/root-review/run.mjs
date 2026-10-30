import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--test','--test-concurrency=1','root-review/observation.test.mjs'],{stdio:'inherit',env:{...process.env,ORIGINAL_PREP:'1'}});
if(r.status===0)throw Error('original regressions unexpectedly all passed');
console.log('ORIGINAL_FAILURES_RETAINED; running corrected tests');
const s=spawnSync(process.execPath,['--test','--test-concurrency=1','root-review/observation.test.mjs','root-review/rpc.test.mjs'],{stdio:'inherit',env:{...process.env,ORIGINAL_PREP:''}});process.exit(s.status??1);
