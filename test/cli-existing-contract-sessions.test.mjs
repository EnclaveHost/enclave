// Real CLI + production-style mutable-book SessionVaultFactory on a local chain.
// The Enclave API is forbidden. No production transaction or account is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";
import {stringToHex} from "viem";
import {haveTools, startRig, KEYS} from "./helpers/cli-independent-rig.mjs";
import {gpuDoc} from "./helpers/host-capacity-fixture.mjs";
import {privateKeyToAccount} from "viem/accounts";
import {hostIdOf} from "../network/host-capacity.mjs";
import {createHostCapacityProducer, HOST_CAPACITY_PATH} from "../network/host-capacity-http.mjs";
import {QuorumChain} from "../cli/independent.mjs";
import {readSessionAuthority} from "../network/session-authority.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY || path.join(REPO,"cli/enclave.mjs");
const artifact = (unit, name) => {
  const a = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/foundry/out", unit, name+".json")));
  return {abi:a.abi, bytecode:a.bytecode.object, linkReferences:a.bytecode.linkReferences||{}};
};
const skip = haveTools();
// A second registered host that is live on its OWN operator-signed capacity record (the shared producer, as the supervisor
// and the Windows node run it), so the child CLI prices a deploy on authenticated evidence; admission is unchanged. Its
// registered endpoint is a public literal address: the test guard (ENCLAVE_TEST_ROUTE) maps exactly that address to this
// loopback listener and logs each use. TLS: a temporary CA, trusted by the child only through NODE_EXTRA_CA_CERTS, and a
// certificate for both names the client may verify (the public literal and, after the guard's rewrite, 127.0.0.1).
// Only anvil's published dev key is used; each request is answered with a freshly signed record.
const PUBLIC_HOST = "1.1.1.1";
async function startSignedHost(r, dir) {
  const run = (a) => execFileSync("openssl", a, {stdio:"ignore"}), f = (n) => path.join(dir, n);
  fs.mkdirSync(dir);
  run(["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-subj","/CN=session liveness test ca","-days","1",
    "-keyout",f("ca.key"),"-out",f("ca.pem"),"-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign"]);
  run(["req","-new","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-subj","/CN=signed host","-keyout",f("h.key"),"-out",f("h.csr")]);
  fs.writeFileSync(f("ext"),`subjectAltName=IP:${PUBLIC_HOST},IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`);
  run(["x509","-req","-in",f("h.csr"),"-CA",f("ca.pem"),"-CAkey",f("ca.key"),"-set_serial","7","-days","1","-extfile",f("ext"),"-out",f("h.pem")]);
  const op = privateKeyToAccount(KEYS.other), requests = [];
  let producer = null;
  const server = https.createServer({key:fs.readFileSync(f("h.key")),cert:fs.readFileSync(f("h.pem"))},async(req,res)=>{
    const p = new URL(req.url,"http://x").pathname; requests.push({method:req.method,path:p});
    if (req.method!=="GET"||p!==HOST_CAPACITY_PATH||!producer) {res.writeHead(404);return res.end();}
    try {const env=await producer.current();res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(env));}
    catch {res.writeHead(500);res.end();}
  });
  await new Promise((ok)=>server.listen(0,"127.0.0.1",ok));
  const port = server.address().port, endpoint = `https://${PUBLIC_HOST}:${port}`;
  const close = () => {server.closeAllConnections();return new Promise((ok)=>server.close(ok));};
  try {
    await r.write(r.wc(KEYS.other),r.addresses.registry,r.A.registry4.abi,"register",[endpoint,"independent/host","0x"+"00".repeat(32),1000n,0n,"0x"+"00".repeat(20)]);
  } catch (e) {await close();throw e;}
  producer = createHostCapacityProducer({account:op,hostIdOf,registry:r.addresses.registry,endpoint,availability:async()=>gpuDoc(Date.now())});
  return {endpoint,from:`${PUBLIC_HOST}:${port}`,to:`127.0.0.1:${port}`,route:`${PUBLIC_HOST}:${port}=127.0.0.1:${port}`,caFile:f("ca.pem"),requests,close};
}
test("existing session contracts work without a relay and retain admin-directed version changes", {skip:skip||false,timeout:180000}, async t => {
  let r, host;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-existing-session-"));
  try {
    r = await startRig();
    const bookArt = artifact("EnclaveAddressBook.sol", "EnclaveAddressBook");
    const factoryArt = artifact("SessionVault.sol", "SessionVaultFactory");
    const book = await r.deploy(bookArt);
    const admin = r.wc(KEYS.deployer);
    const set = (key,value) => r.write(admin, book, bookArt.abi, "set", [stringToHex(key,{size:32}),value]);
    await set("deployments",r.addresses.ledger);
    await set("appCatalog",r.addresses.catalog);
    const lib = await r.deploy(r.A.svlib);
    const factory = await r.deploy(factoryArt, [r.addresses.usdc,book,r.addresses.router,
      "0x"+"00".repeat(20),1000_000000n], {"contracts/SessionVault.sol:SessionVaultLib":lib});
    await set("sessionVaultFactory",factory);
    const pins = {...r.pins,contracts:{...r.pins.contracts,sessionVaultFactory:factory.toLowerCase()}};
    const pinsFile = path.join(tmp,"pins.json"), log = path.join(tmp,"network.log");
    fs.writeFileSync(pinsFile,JSON.stringify(pins));fs.writeFileSync(log,"");
    host = await startSignedHost(r,path.join(tmp,"signed-host"));
    // The signed host is the only active host: the test must price from its authenticated record.
    await r.write(r.wc(KEYS.operator),r.addresses.registry,r.A.registry4.abi,"deregister",[r.runner]);
    const routeLog = path.join(tmp,"route.log");fs.writeFileSync(routeLog,"");
    const routes = () => fs.readFileSync(routeLog,"utf8").split("\n").filter(Boolean).map((l)=>JSON.parse(l));
    const chain = new QuorumChain({rpcs:r.rpcs,confirmations:1});
    const expected = {factory,deployments:r.addresses.ledger,appCatalog:r.addresses.catalog,usdc:r.addresses.usdc};
    const check = () => chain.snapshot((c,b)=>readSessionAuthority(c,b,expected));
    const cli = async (args,key=KEYS.owner) => {
      await r.mine();await r.mine();
      return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[CLI,...args,
          "--independent","--contract-pins",pinsFile,"--usdc-token",r.addresses.usdc,
          "--rpc",r.rpcs.join(","),"--confirmations","1","--yes","--json"],{
          cwd:tmp,env:{PATH:process.env.PATH,HOME:tmp,XDG_CONFIG_HOME:path.join(tmp,"conf"),
            ENCLAVE_SESSION_DIR:path.join(tmp,"sessions"),ENCLAVE_KEY:key,ENCLAVE_API_BASE:r.apiOrigin,ENCLAVE_ADDRESS_BOOK:book,
            NODE_OPTIONS:`--import=${pathToFileURL(path.join(REPO,"test/helpers/cli-network-guard.mjs")).href}`,
            ENCLAVE_TEST_NET_LOG:log,ENCLAVE_TEST_DENY_PORT:String(r.apiPort),
            ENCLAVE_TEST_ROUTE:host.route,ENCLAVE_TEST_ROUTE_LOG:routeLog,NODE_EXTRA_CA_CERTS:host.caFile}});
        let out="",err="";
        const timer=setTimeout(()=>child.kill("SIGKILL"),90000);
        child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
        child.on("error",reject);child.on("close",code=>{
          clearTimeout(timer);let json=null;
          try{json=JSON.parse(out);}catch{try{json=JSON.parse(out.slice(out.lastIndexOf("\n{")+1));}catch{}}
          resolve({code,out,err,json});
        });
      });
    };
    const sends=()=>r.rpcLog.filter(x=>x.method==="eth_sendRawTransaction").length;
    let session, deployment;
    await t.test("both existing and fixed-binding factories resolve at a single quorum block",async()=>{
      await r.mine();await r.mine();
      const current=await check();
      assert.equal(current.value.book.toLowerCase(),book.toLowerCase());
      assert.equal(current.value.factory.toLowerCase(),factory.toLowerCase());
      const fixed=await chain.snapshot((c,b)=>readSessionAuthority(c,b,{...expected,factory:r.addresses.factory}));
      assert.equal(fixed.value.deployments.toLowerCase(),r.addresses.ledger.toLowerCase());
      assert.notEqual(fixed.value.book.toLowerCase(),book.toLowerCase());
    });
    await t.test("new session opens on the existing factory without a relay",async()=>{
      const x=await cli(["session","new","--preset","browser","--budget","5","--days","1","--label","existing"]);
      assert.equal(x.code,0,x.err+x.out);session=x.json;
      assert.equal(session.live,true);assert.equal(session.factory.toLowerCase(),factory.toLowerCase());
    });
    await t.test("an existing grant deploys and funds through another gas payer",async()=>{
      const x=await cli(["deploy","hello:1","--cpu","0.1","--gpu","0","--env","staging","--fund","1"],KEYS.other);
      assert.equal(x.code,0,x.err+x.out);deployment=x.json.id;
      // priced on the signed host's verified record, fetched by the CLI through exactly the mapped public address
      assert.ok(host.requests.some((q)=>q.method==="GET"&&q.path===HOST_CAPACITY_PATH),"the signed capacity record was requested");
      assert.ok(routes().some((e)=>e.from===host.from&&e.to===host.to),"the CLI reached the signed host through the mapped address");
      const row=await r.pc.readContract({address:r.addresses.ledger,abi:r.A.ledger.abi,functionName:"get",args:[deployment]});
      assert.equal(row.owner.toLowerCase(),session.vault.toLowerCase());assert.equal(row.balance6,1_000000n);
      const funded=await cli(["fund",deployment,"--usdc","0.5"],KEYS.other);
      assert.equal(funded.code,0,funded.err+funded.out);
    });
    await t.test("RPC loss refuses before sending a session transaction",async()=>{
      r.rpcModes[0]="down";r.rpcModes[1]="down";const before=sends();
      try {
        const x=await cli(["fund",deployment,"--usdc","0.1"],KEYS.other);
        assert.notEqual(x.code,0);assert.match(x.err,/RPC|quorum|agreed/);assert.equal(sends(),before);
      } finally {delete r.rpcModes[0];delete r.rpcModes[1];}
    });
    await t.test("admin catalog change requires reviewed bindings; the same grant survives that review",async()=>{
      const next=await r.deploy(r.A.catalog);
      await set("appCatalog",next);
      const before=sends();
      const refused=await cli(["fund",deployment,"--usdc","0.1"],KEYS.other);
      assert.notEqual(refused.code,0);assert.match(refused.err,/appCatalog.*differs/);assert.equal(sends(),before);
      pins.contracts.appCatalog=next.toLowerCase();fs.writeFileSync(pinsFile,JSON.stringify(pins));
      const accepted=await cli(["fund",deployment,"--usdc","0.1"],KEYS.other);
      assert.equal(accepted.code,0,accepted.err+accepted.out);
      const inspect=await cli(["session","inspect"]);
      assert.equal(inspect.code,0,inspect.err+inspect.out);assert.equal(inspect.json.sid,session.sid);
    });
    await t.test("wrong token or cleared binding cannot pass validation",async()=>{
      await r.mine();await r.mine();
      await assert.rejects(chain.snapshot((c,b)=>readSessionAuthority(c,b,{...expected,
        appCatalog:pins.contracts.appCatalog,usdc:r.addresses.catalog})),/usdc.*differs/);
      await set("deployments","0x"+"00".repeat(20));await r.mine();await r.mine();
      await assert.rejects(check(),/deployments is unset/);
    });
    assert.deepEqual(r.apiHits,[]);
    assert.equal(fs.readFileSync(log,"utf8"),"","unexpected external network access");
    assert.deepEqual(routes().filter((e)=>e.from!==host.from||e.to!==host.to),[],"only the signed host's address was mapped");
    assert.deepEqual(host.requests.filter((q)=>q.method!=="GET"||q.path!==HOST_CAPACITY_PATH),[],"only the capacity record was requested from the signed host");
  } finally {
    if(host)await host.close();
    if(r)await r.stop();
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
