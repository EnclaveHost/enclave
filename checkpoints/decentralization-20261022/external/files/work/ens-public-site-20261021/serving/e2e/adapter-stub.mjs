// Stands in for the fronts' existing /ipfs/* upstream (bootstrap replica -> s3-ipfs-adapter) with production's observed
// answers (serving/probe3.json, probe4.json): the probe CID -> 400 "not a CIDv1 this gateway mints", unknown CIDs -> 404
// "not in this gateway's index", and ONE adapter-held raw block, so fall-through for non-site CIDs is tested.
import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { cidString } from "../extract-site-blocks.mjs";
const [host, port, outFile] = process.argv.slice(2);
const block = Buffer.from("adapter-held block (uploaded app content)\n");
const cid = cidString(Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash("sha256").update(block).digest()]));
fs.writeFileSync(outFile, cid);
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json", server: "s3-ipfs-adapter-stub" }); res.end(JSON.stringify(v)); };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), m = /^\/ipfs\/([^/]+)$/.exec(u.pathname);
  if (!m) return json(res, 404, { error: "not found" });
  if (m[1] === cid) { res.writeHead(200, { "content-type": "application/vnd.ipld.raw", server: "s3-ipfs-adapter-stub" }); return res.end(req.method === "HEAD" ? undefined : block); }
  if (!/^b[a-z2-7]{58}$/.test(m[1])) return json(res, 400, { error: "not a CIDv1 this gateway mints (base32, sha2-256, raw or dag-pb)" });
  json(res, 404, { error: `CID ${m[1]} is not in this gateway's index (it only serves the configured bucket)` });
}).listen(Number(port), host);
