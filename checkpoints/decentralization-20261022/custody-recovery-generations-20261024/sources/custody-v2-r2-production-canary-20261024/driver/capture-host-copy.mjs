// Transform only the exact reviewed untrusted host source. Never edits it, launches it, or changes the measured guest.
import {createHash} from 'node:crypto';
import {R2} from './plan.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function captureHostCopy(source,{captureURL}) {
 if(sha(source)!==R2.hostSha256)throw Error('host copy: source differs from reviewed r2 host');
 const u=new URL(captureURL);if(u.protocol!=='file:'||u.search||u.hash)throw Error('host copy: local capture module URL required');
 const processURL=new URL('./canary-process.mjs',u),logURL=new URL('./private-log.mjs',u),recoveryURL=new URL('./recovery-state.mjs',u);
 let s=Buffer.isBuffer(source)?source.toString('utf8'):source;
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('host copy: source anchor changed');s=s.replace(a,b);};
 once('import fs from "node:fs";',`import {captureGenesis,validateCaptureDirectory,validateCaptureEndpoint} from ${JSON.stringify(u.href)};\nimport {watchCanaryGuest} from ${JSON.stringify(processURL.href)};\nimport {attachCanaryLogs} from ${JSON.stringify(logURL.href)};\nimport {createRecoveryStateGate} from ${JSON.stringify(recoveryURL.href)};\nimport fs from "node:fs";`);
 once('const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));','const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\nvalidateCaptureDirectory(cfg.canarySubmitDir);validateCaptureEndpoint(cfg.endpoint);');
 once('const STATE = path.join(cfg.stateDir, "state.bin");','const STATE = path.join(cfg.stateDir, "state.bin");\nconst recoveryState=cfg.canaryRecovery?createRecoveryStateGate({file:STATE,expected:cfg.canaryRecovery}):null;');
 once('if (req.url === "/state" && req.method === "GET") return fs.existsSync(STATE) ? send(200, fs.readFileSync(STATE), "application/octet-stream") : send(404, { error: "none" });',
  'if (req.url === "/state" && req.method === "GET") { if(recoveryState&&cfg.canaryRecoveryFault==="state-503")return send(503,{error:"canary_storage_unavailable"}); if(recoveryState)return send(200,recoveryState.read(),"application/octet-stream"); return fs.existsSync(STATE) ? send(200, fs.readFileSync(STATE), "application/octet-stream") : send(404, { error: "none" }); }');
 once('    if (req.url === "/state" && req.method === "PUT") {','    if (req.url === "/state" && req.method === "PUT") {\n      if(recoveryState)recoveryState.requireRead();');
 const start=s.indexOf('const submitter = process.env['),end=s.indexOf('\n\n// ---- fw_cfg',start);
 if(start<0||end<0)throw Error('host copy: wallet anchors changed');
 s=s.slice(0,start)+'// Canary capture only: deliberately no submitter wallet or transaction permission.'+s.slice(end);
 const begin=s.indexOf('    if (req.url === "/submit" && req.method === "POST") {'),finish=s.indexOf('\n    send(404,',begin);
 if(begin<0||finish<0)throw Error('host copy: submit anchors changed');
 s=s.slice(0,begin)+`    if (req.url === "/submit" && req.method === "POST") {
      if(recoveryState)return send(503,{error:'recovery_submit_disabled'});
      const captured=captureGenesis({dir:cfg.canarySubmitDir,endpoint:cfg.endpoint,body});
      return send(captured.status,{error:captured.code,...(captured.digest?{digest:captured.digest}:{})});
    }`+s.slice(finish);
 once('    const chunks = []; for await (const c of req) chunks.push(c);',`    const chunks = [];let size=0;const cap=req.url==='/submit'?16384:4<<20;
    for await(const c of req){size+=c.length;if(size>cap)return send(413,{error:'canary_body_too_large'});chunks.push(c);}`);
 once('  child = spawn(cfg.qemu || "qemu-system-x86_64", args, { stdio: ["ignore", "inherit", "inherit"] });',
  '  child = spawn(cfg.qemu || "qemu-system-x86_64", args, { stdio: ["ignore", "pipe", "pipe"] });\n  attachCanaryLogs(child,{dir:cfg.canaryLogDir});');
 once('let child = null, stopping = false, restarts = 0;', 'let child = null, stopping = false;');
 once('  child.on("exit", (code, sig) => { if (stopping) return; restarts++; const d = Math.min(5000 * restarts, 60000); log(`guest exited ${code}/${sig}; relaunch in ${d} ms`); setTimeout(launch, d); });',
  '  watchCanaryGuest(child,{isStopping:()=>stopping,notify:log});');
 if(/setTimeout\(launch|restarts\+\+/.test(s))throw Error('host copy: automatic guest restart remains');
 if(/wallet\.writeContract|const submitter =|CUSTODY_SUBMITTER_KEY|const wallet =/.test(s))throw Error('host copy: automatic submitter remains');
 return {source:s,sourceSha256:R2.hostSha256,copySha256:sha(s)};
}
