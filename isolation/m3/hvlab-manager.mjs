// hvlab-manager.mjs - the Windows owner's partition manager as its OWN process, wired as its main.mjs wires it
// (Manager + judgeReady = ready.mjs judgeRunning + createServer + the data plane over its own records, and the CID
// fetcher main.mjs uses), with the local KVM launch backend (hvlab-kvm-backend.mjs) in place of the NucBox's. So the
// node side can be tested as it will run on the box: a separate process reached over HTTP and the data plane's TCP.
// Plain KVM guests, NOT Hyper-V.
//
//   usage: HVLAB_NODE_TREE=<tree> node hvlab-manager.mjs <hvlab state dir> <guest image> <runtime.json> <cid>...
// prints one line {"manager":"http://127.0.0.1:P","data":"127.0.0.1:Q","launcherKey":"..."} and serves until killed.
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KvmBackend } from "./hvlab-kvm-backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = process.env.HVLAB_NODE_TREE;
const [stateDir, imagePath, runtimeFile, ...cids] = process.argv.slice(2);
if (!T || !cids.length) { console.error("usage: HVLAB_NODE_TREE=<tree> node hvlab-manager.mjs <state> <image> <runtime.json> <cid>..."); process.exit(2); }
const imp = (rel) => import(pathToFileURL(path.join(T, rel)).href);
process.env.PYTHONPATH = [path.join(T, "wasm"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

const { Manager, createServer } = await imp("windows/vbslike/manager/server.mjs");
const { judgeRunning } = await imp("windows/vbslike/manager/ready.mjs");
const { BOUNDARY } = await imp("windows/vbslike/manager/backend-hcs.mjs");
const { cidFetcher } = await imp("windows/vbslike/manager/fetchcid.mjs");
// the data plane from the bridge THIS tree carries, as its main.mjs imports it
const { dataPlaneFor } = await imp("windows/vbslike/datapath/node-bridge.mjs");

const launcherKey = execFileSync("python3", [path.join(HERE, "hvlab.py"), "pubkey", stateDir]).toString().trim();
const image = createHash("sha256").update(fs.readFileSync(imagePath)).digest("hex");
const backend = new KvmBackend({ guests: cids.map(Number), stateDir, image, launcherKey, boundary: BOUNDARY });
const manager = new Manager({ backend, runtime: JSON.parse(fs.readFileSync(runtimeFile, "utf8")), judgeReady: judgeRunning,
  fetchComponent: cidFetcher({ script: path.join(T, "windows/node/fetch-cid.py"), python: "python3",
                              gateway: process.env.IPFS_GATEWAY || "https://ipfs.enclave.host" }) });
const dp = dataPlaneFor(manager); dp.server.listen(0, "127.0.0.1"); await once(dp.server, "listening");
manager.onReclaim = (id, why) => { try { dp.closeInstance(id, why); } catch {} };     // as main.mjs sets it
await manager.probe();
const srv = createServer(manager); srv.listen(0, "127.0.0.1"); await once(srv, "listening");
console.log(JSON.stringify({ manager: `http://127.0.0.1:${srv.address().port}`, data: `127.0.0.1:${dp.server.address().port}`, launcherKey }));
// on exit: what the data plane saw (closed:reclaimed counts the splices onReclaim ended; the other outcomes say why)
const bye = () => { console.log(`data plane: ${JSON.stringify(dp.stats())}`); backend.stopAll(); process.exit(0); };
process.on("SIGTERM", bye); process.on("SIGINT", bye);
