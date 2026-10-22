import fs from 'node:fs';
import {spawn} from 'node:child_process';
const directory='C:/ProgramData/Enclave/network-checker';
const args=[directory+'/checker.mjs','--key-file',directory+'/checker.key','--wg','C:/Program Files/Enclave/network/enclave-wg.exe','--directories-file',directory+'/checker-directories.json','--loop','240','--rpc','https://base-rpc.publicnode.com','--book','0xab214342d5A490150A4A977063A2f88E21F80907','--out',directory+'/live-verdicts.json'];
const log=fs.openSync(directory+'/checker.log','a');
let child,stopping=false;
function start(){if(stopping)return;child=spawn(process.execPath,args,{stdio:['ignore',log,log],windowsHide:true});child.on('exit',()=>{if(!stopping)setTimeout(start,10000)});child.on('error',()=>{if(!stopping)setTimeout(start,10000)});}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;child?.kill();process.exit(0)});
start();
