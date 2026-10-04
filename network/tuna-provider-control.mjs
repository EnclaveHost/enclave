#!/usr/bin/env node
import fs from 'node:fs/promises';
import {startTunaUSDCControl} from './tuna-control-runtime.mjs';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(config.role!=='provider')throw Error('provider controller configuration required');
const runtime=await startTunaUSDCControl({config,directory:config.directory,log:message=>process.stderr.write(message+'\n')});
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await runtime.close();process.exit(0)});
