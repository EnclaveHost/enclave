// network/wg-provider/gamestream-gateway-install.sh against a staging tree (ENCLAVE_NETWORK_ROOT) with stand-ins for the
// system's tools: what it refuses before changing anything, what an install leaves, and that a gateway which does not
// come up, and `remove`, leave nothing. The bundle is the real build; systemd's own sandboxing is not exercised here.
import test from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,readdir} from 'node:fs/promises';import {existsSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';

const here=new URL('..',import.meta.url).pathname,script=path.join(here,'network/wg-provider/gamestream-gateway-install.sh');
const run=(cmd,args,env)=>new Promise(resolve=>execFile(cmd,args,{env,cwd:here},(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr})));

// stand-ins: `systemctl restart` makes the service active (unless NOSTART), and `ss` then shows its six listeners on
// LISTEN, and one on the sibling port when it was installed with siblings; BUSY makes another program hold a port.
// Every call is appended to $STATE/calls.
const STUBS={
 id:'echo 0',
 sleep:':',
 journalctl:'echo "(journal)"',
 ip:'echo "2: eth0    inet 203.0.113.9/20 brd 203.0.113.255 scope global eth0"; echo "1: lo    inet 127.0.0.1/8 scope host lo"',
 systemctl:`echo "systemctl $*" >> "$STATE/calls"
case "$1" in
 is-active) [ -f "$STATE/active" ] && { [ "$2" = -q ] || echo active; exit 0; }; [ "$2" = -q ] || echo inactive; exit 3 ;;
 is-enabled) [ -f "$STATE/enabled" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
 enable) touch "$STATE/enabled" ;;
 restart) [ -n "\${NOSTART:-}" ] || touch "$STATE/active" ;;
 disable) rm -f "$STATE/enabled" "$STATE/active" ;;
esac`,
 ufw:`echo "ufw $*" >> "$STATE/calls"
case "$1" in
 status) echo "Status: active"; echo; echo "To                         Action      From"; cat "$STATE/rules" 2>/dev/null ;;
 allow) if [ "$2" = from ]; then echo "$5 $7/$9           ALLOW       $3                # enclave gamestream gateway" >> "$STATE/rules"
        else echo "$2                  ALLOW       Anywhere                   # enclave gamestream gateway" >> "$STATE/rules"; fi ;;
 delete) if [ "$3" = from ]; then grep -v "^$6 $8/\${10} .* $4 " "$STATE/rules" > "$STATE/rules.new" || true
         else grep -v "^$3 " "$STATE/rules" > "$STATE/rules.new" || true; fi; mv "$STATE/rules.new" "$STATE/rules" ;;
esac`,
 ss:`port=\${@: -1}; port=\${port##*:}; proto=tcp; state=LISTEN; case "$*" in *-lunp*) proto=udp; state=UNCONN;; esac
own=; if [ -f "$STATE/active" ]; then own=1; [ "$port" != 47997 ] || [ -f "$ENCLAVE_NETWORK_ROOT/etc/enclave-gamestream-gateway/siblings" ] || own=; fi
if [ -n "$own" ]; then echo "$state 0 511 $LISTEN:$port 0.0.0.0:* users:((\\"node\\",pid=7,fd=20))"
elif [ "\${BUSY:-}" = "$proto/$port" ]; then echo "$state 0 5 0.0.0.0:$port 0.0.0.0:* users:((\\"sunshine\\",pid=9,fd=3))"; fi`,
};
async function rig(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'gsgw-install-')),bin=path.join(dir,'bin'),root=path.join(dir,'root'),state=path.join(dir,'state'),build=path.join(dir,'build');
 for(const d of [bin,root,state])await mkdir(d);
 for(const [name,body] of Object.entries(STUBS)){await writeFile(path.join(bin,name),'#!/bin/bash\n'+body+'\n');await chmod(path.join(bin,name),0o755);}
 const built=await run(process.execPath,[path.join(here,'scripts/network/build-gamestream-gateway.mjs'),build],process.env);
 assert.equal(built.code,0,built.stderr);
 const bundle=path.join(build,'gamestream-gateway.mjs'),sha=createHash('sha256').update(await readFile(bundle)).digest('hex');
 assert.equal(JSON.parse(built.stdout).sha256,sha);
 const cfg=path.join(dir,'config.json');await writeFile(cfg,JSON.stringify({zones:['app.test'],host:'203.0.113.9'}));
 const env=over=>({PATH:bin+':'+path.dirname(process.execPath)+':/usr/bin:/bin',ENCLAVE_NETWORK_ROOT:root,STATE:state,LISTEN:'203.0.113.9',...over});
 const opt=path.join(root,'opt/enclave-gamestream-gateway'),etc=path.join(root,'etc/enclave-gamestream-gateway'),unit=path.join(root,'etc/systemd/system/enclave-gamestream-gateway.service');
 const calls=async()=>existsSync(path.join(state,'calls'))?(await readFile(path.join(state,'calls'),'utf8')).trim().split('\n'):[];
 return {dir,bundle,sha,cfg,opt,etc,unit,calls,state,sh:(args,over={})=>run('bash',[script,...args],env(over)),close:()=>rm(dir,{recursive:true,force:true})};
}
const changed=r=>existsSync(r.opt)||existsSync(r.etc)||existsSync(r.unit);
const mutating=calls=>calls.filter(c=>!/^(systemctl is-|ufw status)/.test(c));

test('install refuses, with nothing changed: another build, a bad configuration, a foreign address, ports in use',async()=>{
 const r=await rig();
 try{
  const other=path.join(r.dir,'other.json');
  let a=await r.sh(['install',r.bundle,'0'.repeat(64),r.cfg]);assert.equal(a.code,1);assert.match(a.stderr,/not the build 0{64}; nothing changed/);
  await writeFile(other,JSON.stringify({zones:['app.test'],host:'203.0.113.9',keyFile:'/etc/x'}));
  a=await r.sh(['install',r.bundle,r.sha,other]);assert.equal(a.code,1);assert.match(a.stderr,/unknown field keyFile/);assert.match(a.stderr,/nothing changed/);
  await writeFile(other,JSON.stringify({zones:['app.test'],host:'198.51.100.4'}));
  a=await r.sh(['install',r.bundle,r.sha,other]);assert.equal(a.code,1);assert.match(a.stderr,/198\.51\.100\.4 is not on this box; nothing changed/);
  a=await r.sh(['install',r.bundle,r.sha,r.cfg],{BUSY:'udp/47999'});assert.equal(a.code,1);assert.match(a.stderr,/ports are in use; nothing changed/);assert.match(a.stderr,/udp 0\.0\.0\.0:47999 .*sunshine/);
  for(const args of [[],['install'],['install',r.bundle,'xyz',r.cfg],['install',r.bundle,r.sha,path.join(r.dir,'none.json')],['status','x'],['purge']])assert.equal((await r.sh(args)).code,2,args.join(' '));
  assert.equal(changed(r),false);assert.deepEqual(mutating(await r.calls()),[]);
 }finally{await r.close();}
});

test('install leaves the held bundle, the configuration, a keyless sandboxed unit and six open ports; remove takes them away',async()=>{
 const r=await rig();
 try{
  const a=await r.sh(['install',r.bundle,r.sha,r.cfg]);assert.equal(a.code,0,a.stderr);
  assert.match(a.stdout,/^installed\nservice: active \/ enabled\nbundle: /);assert.ok(a.stdout.includes('bundle: '+r.sha));
  assert.equal((a.stdout.match(/^  (tcp|udp) 203\.0\.113\.9:/gm)||[]).length,6);
  assert.equal((a.stdout.match(/^  (47984\/tcp|47989\/tcp|48010\/tcp|47998:48000\/udp) +ALLOW/gm)||[]).length,4);
  assert.deepEqual(await readdir(r.opt),['gamestream-gateway.mjs']);assert.deepEqual(await readdir(r.etc),['config.json']);
  const unit=await readFile(r.unit,'utf8');
  assert.match(unit,new RegExp(`^ExecStart=\\S+/node --max-old-space-size=128 ${r.opt}/gamestream-gateway\\.mjs ${r.etc}/config\\.json$`,'m'));
  for(const line of ['DynamicUser=yes','NoNewPrivileges=yes','CapabilityBoundingSet=','ProtectSystem=strict','MemoryMax=192M','CPUQuota=60%','Restart=always'])assert.ok(unit.split('\n').includes(line),line);
  assert.doesNotMatch(unit,/key|secret|token|password|EnvironmentFile/i);
  assert.deepEqual(mutating(await r.calls()),['ufw allow 47984/tcp comment enclave gamestream gateway','ufw allow 47989/tcp comment enclave gamestream gateway',
   'ufw allow 48010/tcp comment enclave gamestream gateway','ufw allow 47998:48000/udp comment enclave gamestream gateway',
   'systemctl daemon-reload','systemctl enable -q enclave-gamestream-gateway','systemctl restart enclave-gamestream-gateway']);
  // a second install over a running one replaces it (its own listeners are not "in use")
  assert.equal((await r.sh(['install',r.bundle,r.sha,r.cfg])).code,0);
  const s=await r.sh(['status']);assert.equal(s.code,0);assert.match(s.stdout,/^service: active \/ enabled\n/);assert.ok(s.stdout.includes('config: {"zones":["app.test"],"host":"203.0.113.9"}'));
  const d=await r.sh(['remove']);assert.equal(d.code,0,d.stderr);
  assert.match(d.stdout,/^removed\nservice: inactive \/ disabled\nbundle: none\nconfig: none\nlisteners:\nufw:\n$/);
  assert.equal(changed(r),false);assert.equal((await readFile(path.join(r.state,'rules'),'utf8')).trim(),'');
 }finally{await r.close();}
});

test('with siblings: the sibling port is opened to each sibling alone, listened on, replaced with the install and removed with it',async()=>{
 const r=await rig();
 try{
  const cfg=path.join(r.dir,'siblings.json'),write=siblings=>writeFile(cfg,JSON.stringify({zones:['app.test'],host:'203.0.113.9',siblings}));
  await write(['203.0.113.9','198.51.100.7','198.51.100.8']);
  // the sibling port in use by another program: refused, nothing changed
  let a=await r.sh(['install',r.bundle,r.sha,cfg],{BUSY:'tcp/47997'});assert.equal(a.code,1);assert.match(a.stderr,/tcp 0\.0\.0\.0:47997 .*sunshine/);assert.equal(changed(r),false);
  a=await r.sh(['install',r.bundle,r.sha,cfg]);assert.equal(a.code,0,a.stderr);
  assert.equal((a.stdout.match(/^  (tcp|udp) 203\.0\.113\.9:/gm)||[]).length,7);assert.match(a.stdout,/^  tcp 203\.0\.113\.9:47997 /m);
  assert.deepEqual((a.stdout.match(/^  203\.0\.113\.9 47997\/tcp +ALLOW +\S+/gm)||[]).map(l=>l.split(/\s+/).pop()),['198.51.100.7','198.51.100.8']);
  assert.equal(await readFile(path.join(r.etc,'siblings'),'utf8'),'198.51.100.7 203.0.113.9 47997\n198.51.100.8 203.0.113.9 47997\n');
  assert.deepEqual(mutating(await r.calls()).filter(c=>c.includes('from')),['ufw allow from 198.51.100.7 to 203.0.113.9 port 47997 proto tcp comment enclave gamestream gateway',
   'ufw allow from 198.51.100.8 to 203.0.113.9 port 47997 proto tcp comment enclave gamestream gateway']);
  // an install with another list replaces the rules: the sibling that left is closed out
  await write(['198.51.100.8','198.51.100.9']);
  a=await r.sh(['install',r.bundle,r.sha,cfg]);assert.equal(a.code,0,a.stderr);
  assert.deepEqual((a.stdout.match(/^  203\.0\.113\.9 47997\/tcp +ALLOW +\S+/gm)||[]).map(l=>l.split(/\s+/).pop()),['198.51.100.8','198.51.100.9']);
  // an install without siblings closes the port to all of them
  a=await r.sh(['install',r.bundle,r.sha,r.cfg]);assert.equal(a.code,0,a.stderr);
  assert.doesNotMatch(a.stdout,/47997/);assert.deepEqual(await readdir(r.etc),['config.json']);
  // over that running install: the sibling port held by another program is refused, and the install stays as it was
  await write(['198.51.100.7']);const before=(await r.calls()).length;
  a=await r.sh(['install',r.bundle,r.sha,cfg],{BUSY:'tcp/47997'});assert.equal(a.code,1);assert.match(a.stderr,/sibling port is in use; nothing changed/);
  assert.deepEqual(mutating((await r.calls()).slice(before)),[]);assert.deepEqual(await readdir(r.etc),['config.json']);
  assert.equal((await r.sh(['install',r.bundle,r.sha,cfg])).code,0);
  const d=await r.sh(['remove']);assert.equal(d.code,0,d.stderr);
  assert.match(d.stdout,/^removed\nservice: inactive \/ disabled\nbundle: none\nconfig: none\nlisteners:\nufw:\n$/);
  assert.equal(changed(r),false);assert.equal((await readFile(path.join(r.state,'rules'),'utf8')).trim(),'');
  // and one that does not come up takes its sibling rules with it
  a=await r.sh(['install',r.bundle,r.sha,cfg],{NOSTART:'1'});assert.equal(a.code,1);
  assert.equal(changed(r),false);assert.equal((await readFile(path.join(r.state,'rules'),'utf8')).trim(),'');
 }finally{await r.close();}
});

test('a gateway that does not come up listening is removed again',async()=>{
 const r=await rig();
 try{
  const a=await r.sh(['install',r.bundle,r.sha,r.cfg],{NOSTART:'1'});
  assert.equal(a.code,1);assert.match(a.stderr,/did not come up listening; removing it again/);
  assert.equal(changed(r),false);assert.equal((await readFile(path.join(r.state,'rules'),'utf8')).trim(),'');
  // listening on another address than the configured one is not up either
  const b=await r.sh(['install',r.bundle,r.sha,r.cfg],{LISTEN:'127.0.0.1'});
  assert.equal(b.code,1);assert.equal(changed(r),false);
 }finally{await r.close();}
});
