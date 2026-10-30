import {BASE_TEST} from './test/helpers/baseline.mjs';
import {registerHooks} from 'node:module';
const runner=new URL('./src/network/deployment-lifecycle-runner.mjs',import.meta.url).href;
registerHooks({resolve(s,c,n){
 if(c.parentURL?.startsWith(BASE_TEST)&&s==='../network/deployment-lifecycle-runner.mjs')return {url:runner,shortCircuit:true};
 return n(s,c);
}});
