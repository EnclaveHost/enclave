// Entry of the standalone GameStream gateway (gamestream-gateway.mjs): gamestream-gateway [--check-config] CONFIG.json
import {readFileSync} from 'node:fs';
import {parseGatewayConfig,startGateway,limitedLog} from './gamestream-gateway.mjs';

const args=process.argv.slice(2),check=args[0]==='--check-config';if(check)args.shift();
if(args.length!==1||args[0].startsWith('--')){console.error('usage: gamestream-gateway [--check-config] CONFIG.json');process.exit(2);}
let cfg;
try{cfg=parseGatewayConfig(JSON.parse(readFileSync(args[0],'utf8')));}catch(e){console.error('configuration rejected: '+e.message);process.exit(1);}
if(check){console.log(JSON.stringify({ok:true,...cfg}));process.exit(0);}
const log=limitedLog(line=>console.log(line));
let gateway;
try{gateway=await startGateway(cfg,{log});}catch(e){console.error('gamestream gateway: '+e.message);process.exit(1);}
// a line every ten minutes while anything is bound, so the journal shows use without naming a client
let last='';
setInterval(()=>{const s=gateway.stats(),line=`gamestream gateway: ${s.flows} flow(s), ${s.bindings} bound client(s)`;if(s.flows||s.bindings||line!==last)console.log(line);last=line;},600000).unref();
const stop=()=>{gateway.close();process.exit(0);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
