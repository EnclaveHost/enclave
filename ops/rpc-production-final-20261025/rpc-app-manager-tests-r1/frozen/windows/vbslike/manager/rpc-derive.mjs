// Dedicated V9 mapping. This does not enable a native runtime or attest a host.
import { ABI, BUNDLE_MAGIC, KIND, COMPONENT_PREAMBLE, MAX_MANIFEST_BYTES,
  canonical, sha256Hex } from "./derive.mjs";
import { TextDecoder } from "node:util";
export const RPC_DERIVATION = "enclave-catalog-bundle/9";
export const RPC_PORTS = Object.freeze(["tcp:30303", "tcp:30313", "tcp:9222", "tcp:9310",
  "udp:30303", "udp:30313", "udp:30314", "udp:9200", "udp:9223", "udp:9310", "udp:9311"]);
export const RPC_CONFIG = Object.freeze({baseChainId:8453,ethereumChainId:1,schema:"enclave-rpc-app/1",startupSeconds:900});
const hash = x => typeof x === "string" && x.length === 64 && /^[0-9a-f]{64}$/.test(x) && x !== "0".repeat(64);
export function exactRPCKeys(v, keys, label) {
  if (!v || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
      Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(v,k), "value"))) throw new Error(`RPC ${label} fields`);
}
export function validateRPCRecord(r) {
  exactRPCKeys(r,["derivation","catalog","cid","runtimeId","policy","http","ports","configBase64","secretDeployment","rpc"],"record");
  exactRPCKeys(r.catalog,["app","version"],"catalog");
  exactRPCKeys(r.policy,["cpuPercent","memMiB","vcpus"],"policy");
  exactRPCKeys(r.rpc,["profile","profileSha256","l1VolumeId","baseVolumeId"],"profile");
  if (r.derivation !== RPC_DERIVATION || typeof r.catalog.app !== "string" ||
      !r.catalog.app.startsWith("0x") || !hash(r.catalog.app.slice(2)) ||
      !Number.isInteger(r.catalog.version) || r.catalog.version < 0 || r.catalog.version > 0xffffffff ||
      typeof r.cid !== "string" || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/.exec(r.cid)?.[0] !== r.cid || !hash(r.runtimeId)) throw new Error("RPC derivation identity");
  if (r.policy.cpuPercent !== 400 || r.policy.memMiB !== 19456 || r.policy.vcpus !== 4 || r.http !== 8000 ||
      !Array.isArray(r.ports) || r.ports.length !== RPC_PORTS.length || RPC_PORTS.some((v,i)=>v!==r.ports[i])) throw new Error("RPC fixed CPU/memory/ports");
  if (typeof r.secretDeployment !== "string" || !r.secretDeployment.startsWith("0x") || !hash(r.secretDeployment.slice(2)) ||
      r.rpc.profile !== "ethereum-base-rpc-v1" || !hash(r.rpc.profileSha256) || !hash(r.rpc.l1VolumeId) ||
      !hash(r.rpc.baseVolumeId) || r.rpc.l1VolumeId === r.rpc.baseVolumeId) throw new Error("RPC deployment/profile/volume identity");
  if (typeof r.configBase64 !== "string" || !r.configBase64.length || r.configBase64.length > 43692) throw new Error("RPC configuration length");
  const b=Buffer.from(r.configBase64,"base64");
  if (b.length>32768 || b.toString("base64")!==r.configBase64 ||
      !canonical(JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(b))).equals(canonical(RPC_CONFIG))) throw new Error("RPC fixed configuration");
  if (canonical(r).length>MAX_MANIFEST_BYTES) throw new Error("RPC record size");
}
export function deriveRPC({record,component}) {
  validateRPCRecord(record);
  if (!Buffer.isBuffer(component) || component.length>8*1024*1024 || !component.subarray(0,8).equals(COMPONENT_PREAMBLE)) throw new Error("RPC portable controller");
  const r=structuredClone(record), c=Buffer.from(component);
  const m=canonical({abi:ABI,artifact:{kind:KIND,sha256:sha256Hex(c)},world:"wasi:cli",policy:r.policy,
    http:r.http,ports:r.ports,rpc:r.rpc,configBase64:r.configBase64,secretDeployment:r.secretDeployment});
  if(m.length>MAX_MANIFEST_BYTES) throw new Error("RPC manifest size");
  const ml=Buffer.alloc(4),al=Buffer.alloc(4);ml.writeUInt32LE(m.length);al.writeUInt32LE(c.length);
  const bundle=Buffer.concat([Buffer.from(BUNDLE_MAGIC),ml,m,al,c]);
  return {record:r,recordSha256:sha256Hex(canonical(r)),componentSha256:sha256Hex(c),componentBytes:c.length,
    appId:sha256Hex(bundle),bundleBytes:bundle.length,bundle};
}
