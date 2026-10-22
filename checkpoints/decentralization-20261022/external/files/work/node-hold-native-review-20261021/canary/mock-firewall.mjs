#!/usr/bin/env node
// LOCAL LOGIC CHECK ONLY (Linux). Imitates enclave-circuit-firewall's CLI shape: install writes a manifest, sandbox starts
// the worker and prints the same "AppContainer verified: <sid>, PID <n>" line, remove refuses while a process runs the
// circuit's program (like noCircuitProcesses). MOCK_JOB=1 imitates kill-on-close (SIGTERM ends every process running the
// circuit's worker image, then exits); MOCK_JOB=0 has no job (the worker and its child survive). Proves nothing native.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const [cmd,file]=process.argv.slice(2);
const procs=exe=>fs.readdirSync('/proc').filter(d=>/^\d+$/.test(d)).filter(d=>{try{return fs.readlinkSync('/proc/'+d+'/exe')===exe;}catch{return false;}}).map(Number);
if(cmd==='install'){const c=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(path.join(c.directory,'firewall.json'),JSON.stringify({state:'active',appContainerSid:'S-1-15-2-1-2-3',programs:c.programs.map(p=>p.path),rules:['a','b','c','d']}));console.log('{"type":"installed"}');}
else if(cmd==='remove'){const m=JSON.parse(fs.readFileSync(file,'utf8'));
 if(m.programs.some(p=>procs(p).length)){console.error('panic: stop circuit processes before removing its firewall');process.exit(2);}
 m.state='removed';fs.writeFileSync(file,JSON.stringify(m));console.log('{"type":"removed"}');}
else if(cmd==='sandbox'){const c=JSON.parse(fs.readFileSync(file,'utf8'));
 const w=spawn(c.executable,c.args,{stdio:'inherit',cwd:c.directory});
 console.error(`AppContainer verified: S-1-15-2-1-2-3, PID ${w.pid}`);
 if(process.env.MOCK_JOB==='1')process.on('SIGTERM',()=>{for(const pid of procs(c.executable))try{process.kill(pid,'SIGKILL');}catch{}process.exit(1);});
 w.on('exit',code=>process.exit(code?1:0));}
else{console.error('usage');process.exit(2);}
