// READ-ONLY public chain read: sia-s3 catalog version 7's record; prints only env/setting NAMES of the config, plus the
// values of allowlisted non-secret timeout/log settings. No secrets are read (secrets are not in the catalog).
import fs from "node:fs";
import { createPublicClient, http } from "../../enclave/node_modules/viem/_esm/index.js";
import { base } from "../../enclave/node_modules/viem/_esm/chains/index.js";
const abi = JSON.parse(fs.readFileSync(new URL("../../enclave/contracts/EnclaveAppCatalog.abi.json", import.meta.url)));
const c = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com", { timeout: 15000 }) });
const appId = "0x093fa91736c2639e93867b76074c6c4dbc5e49150faf4e8618bdf45e30d275c6";
const v = await c.readContract({ address: "0x18419CA2b502D423A8de6269AEeE171a378626e3", abi, functionName: "getVersion", args: [appId, 7n] });
const cfgCid = await c.readContract({ address: "0x18419CA2b502D423A8de6269AEeE171a378626e3", abi, functionName: "versionConfigCid", args: [appId, 7n] }).catch((e) => "ERR " + e.shortMessage);
const ALLOW = /^(SIA_RPC_IDLE_TIMEOUT_SECS|SIAS3_LOG|ENCLAVE_EGRESS_MODE)$/;
let cfg = null; try { cfg = JSON.parse(v.config); } catch {}
const names = []; const allowed = {};
const walk = (o, p) => { if (o && typeof o === "object") for (const [k, x] of Object.entries(o)) { names.push(p + k); if (ALLOW.test(k)) allowed[k] = x; walk(x, p + k + "."); } };
walk(cfg, "");
console.log(JSON.stringify({ version: v.version, cid: v.cid, memMb: v.memMb, ports: v.ports, configParsed: !!cfg, configBytes: v.config.length, configCid: cfgCid, names, allowed,
  egress: cfg ? (cfg.egress ?? null) : (/"egress"\s*:\s*"([a-z-]+)"/.exec(v.config)?.[1] ?? null) }, null, 1));
