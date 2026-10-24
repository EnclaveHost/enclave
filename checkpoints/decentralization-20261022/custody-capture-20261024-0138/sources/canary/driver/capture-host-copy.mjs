// Transform only the exact reviewed untrusted host source. Never edits it, launches it, or changes the measured guest.
import {createHash} from 'node:crypto';
import {R2} from './plan.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function captureHostCopy(source,{captureURL}) {
 if(sha(source)!==R2.hostSha256)throw Error('host copy: source differs from reviewed r2 host');
 const u=new URL(captureURL);if(u.protocol!=='file:'||u.search||u.hash)throw Error('host copy: local capture module URL required');
 let s=Buffer.isBuffer(source)?source.toString('utf8'):source;
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('host copy: source anchor changed');s=s.replace(a,b);};
 once('import fs from "node:fs";',`import {captureGenesis,validateCaptureDirectory,validateCaptureEndpoint} from ${JSON.stringify(u.href)};\nimport fs from "node:fs";`);
 once('const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));','const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\nvalidateCaptureDirectory(cfg.canarySubmitDir);validateCaptureEndpoint(cfg.endpoint);');
 const start=s.indexOf('const submitter = process.env['),end=s.indexOf('\n\n// ---- fw_cfg',start);
 if(start<0||end<0)throw Error('host copy: wallet anchors changed');
 s=s.slice(0,start)+'// Canary capture only: deliberately no submitter wallet or transaction permission.'+s.slice(end);
 const begin=s.indexOf('    if (req.url === "/submit" && req.method === "POST") {'),finish=s.indexOf('\n    send(404,',begin);
 if(begin<0||finish<0)throw Error('host copy: submit anchors changed');
 s=s.slice(0,begin)+`    if (req.url === "/submit" && req.method === "POST") {
      const captured=captureGenesis({dir:cfg.canarySubmitDir,endpoint:cfg.endpoint,body});
      return send(captured.status,{error:captured.code,...(captured.digest?{digest:captured.digest}:{})});
    }`+s.slice(finish);
 once('    const chunks = []; for await (const c of req) chunks.push(c);',`    const chunks = [];let size=0;const cap=req.url==='/submit'?16384:4<<20;
    for await(const c of req){size+=c.length;if(size>cap)return send(413,{error:'canary_body_too_large'});chunks.push(c);}`);
 if(/wallet\.writeContract|const submitter =|CUSTODY_SUBMITTER_KEY|const wallet =/.test(s))throw Error('host copy: automatic submitter remains');
 return {source:s,sourceSha256:R2.hostSha256,copySha256:sha(s)};
}
