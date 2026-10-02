import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DiscoveryPeer} from '../discovery-peer.mjs';
test('discovery process failure after readiness withdraws the peer',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-peer-test-'));
 const binary=path.join(dir,'peer');
 await fs.writeFile(binary,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"ready"}));setTimeout(()=>process.exit(1),100);',{mode:0o700});
 const peer=new DiscoveryPeer({binary,configFile:'unused',deploymentId:'0x'+'1'.repeat(64)}),down=once(peer,'down');
 try{await peer.start();const [error]=await down;assert.match(error.message,/exited/);assert.throws(()=>peer.update(null),/closed/);}
 finally{peer.close();await fs.rm(dir,{recursive:true,force:true});}
});
