// A trusted local controller contract, not a spawn-supplied approval or an
// implemented native driver. main.mjs deliberately supplies none until qualified.
import {exactRPCKeys,validateRPCRecord,RPC_PORTS} from "./rpc-derive.mjs";
const hash=x=>typeof x==="string"&&x.length===64&&/^[0-9a-f]{64}$/.test(x)&&x!=="0".repeat(64);
export function captureRPCController(c) {
  exactRPCKeys(c,["runtimeId","profileSha256","assertInventory","begin",...(Object.hasOwn(c,"recoverHeld")?["recoverHeld"]:[])],"controller");
  if(Object.hasOwn(c,"recoverHeld")&&typeof c.recoverHeld!=="function")throw new Error("RPC held inventory method");
  if(!hash(c.runtimeId)||!hash(c.profileSha256)||typeof c.assertInventory!=="function"||typeof c.begin!=="function") throw new Error("RPC controller pins/methods");
  return Object.freeze({runtimeId:c.runtimeId,profileSha256:c.profileSha256,
    assertInventory:c.assertInventory.bind(c),begin:c.begin.bind(c),recoverHeld:c.recoverHeld?.bind(c)??(()=>[])});
}
export function rpcSpawnSnapshot(body,c) {
  // The wire cannot supply a VM GUID, owner receipt, path, command or credential.
  exactRPCKeys(body,["id","name","derive","cpuShare","hasSecrets","isPublic","firewall"],"spawn");
  const b=structuredClone(body);validateRPCRecord(b.derive);
  if(typeof b.id!=="string" || !/^rpc[0-9a-f]{32}$/.test(b.id) || b.id.length!==35 ||
      b.name!==b.derive.secretDeployment || b.hasSecrets!==true || b.isPublic!==true ||
      !Number.isFinite(b.cpuShare)||b.cpuShare<=0||b.cpuShare>1 ||
      !Array.isArray(b.firewall)||b.firewall.length!==RPC_PORTS.length||RPC_PORTS.some((v,i)=>b.firewall[i]!==v)) throw new Error("RPC deployment spawn binding");
  if(b.derive.runtimeId!==c.runtimeId||b.derive.rpc.profileSha256!==c.profileSha256) throw new Error("RPC accepted runtime/profile differs");
  return b;
}
export function captureRPCAttempt(a) {
  exactRPCKeys(a,["originalClock","assertCurrent","start","stop"],"attempt");
  exactRPCKeys(a.originalClock,["originMs","deadlineMs"],"original clock");
  const {originMs,deadlineMs}=a.originalClock;
  if(![originMs,deadlineMs].every(v=>typeof v==="string"&&/^(0|[1-9][0-9]{0,15})$/.exec(v)?.[0]===v) ||
      BigInt(deadlineMs)-BigInt(originMs)!==900000n || BigInt(deadlineMs)>BigInt(Number.MAX_SAFE_INTEGER) ||
      [a.assertCurrent,a.start,a.stop].some(v=>typeof v!=="function")) throw new Error("RPC original 900-second attempt");
  // The clock is native monotonic, supplied by the qualified controller before
  // component fetch. JS never invents an epoch or resets it after preparation.
  return Object.freeze({originalClock:Object.freeze({originMs,deadlineMs}),
    assertCurrent:a.assertCurrent.bind(a),start:a.start.bind(a),stop:a.stop.bind(a)});
}
export function freezeRPC(v) {
  if(v&&typeof v==="object") {for(const x of Object.values(v)) freezeRPC(x);Object.freeze(v);}
  return v;
}
