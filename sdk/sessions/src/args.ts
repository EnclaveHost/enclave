import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { ACTIONS, ENVIRONMENTS, type Environment, type OnChainAction } from "./constants.js";

/** Typed arguments for each on-chain action, encoded exactly as
 *  SessionVault.execute decodes them (one tuple per struct-shaped action). */
export interface CreateArgs {
  appRef: string;
  gpuMilli: number;
  cpuMilli: number;
  appPort: number;
  ports: string;
  isPublic: boolean;
  configCid: string;
  maxRate6: bigint;
  env: Environment;
  fund6: bigint;
}

export interface PublishArgs {
  slug: string;
  name: string;
  description: string;
  version: string;
  cid: string;
  res: [number, number, number, number];
  ports: string;
  config: string;
  configCid: string;
}

export type ActionArgs = {
  "deploy.create": CreateArgs;
  "deploy.fund": { id: Hex; amount6: bigint };
  "deploy.setAppRef": { id: Hex; appRef: string };
  "deploy.setConfig": { id: Hex; configCid: string };
  "deploy.setShares": { id: Hex; gpuMilli: number; cpuMilli: number };
  "deploy.setMaxRate": { id: Hex; maxRate6: bigint };
  "deploy.setActive": { id: Hex; active: boolean };
  "deploy.refund": { id: Hex };
  "app.publish": PublishArgs;
};

const CREATE = [{
  type: "tuple", components: [
    { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
    { name: "appPort", type: "uint32" }, { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
    { name: "configCid", type: "string" }, { name: "maxRate6", type: "uint256" }, { name: "env", type: "uint8" },
    { name: "fund6", type: "uint256" },
  ],
}] as const;

const PUBLISH = [{
  type: "tuple", components: [
    { name: "slug", type: "string" }, { name: "name", type: "string" }, { name: "description", type: "string" },
    { name: "version", type: "string" }, { name: "cid", type: "string" }, { name: "res", type: "uint32[4]" },
    { name: "ports", type: "string" }, { name: "config", type: "string" }, { name: "configCid", type: "string" },
  ],
}] as const;

const B32 = { type: "bytes32" } as const;

export function encodeArgs<A extends OnChainAction>(action: A, a: ActionArgs[A]): Hex {
  const v = a as never as Record<string, never>;
  switch (action) {
    case "deploy.create": {
      const c = a as CreateArgs;
      return encodeAbiParameters(CREATE, [{ ...c, env: ENVIRONMENTS[c.env] }]);
    }
    case "deploy.fund": return encodeAbiParameters([B32, { type: "uint256" }], [v.id, v.amount6]);
    case "deploy.setAppRef": return encodeAbiParameters([B32, { type: "string" }], [v.id, v.appRef]);
    case "deploy.setConfig": return encodeAbiParameters([B32, { type: "string" }], [v.id, v.configCid]);
    case "deploy.setShares":
      return encodeAbiParameters([B32, { type: "uint16" }, { type: "uint16" }], [v.id, v.gpuMilli, v.cpuMilli]);
    case "deploy.setMaxRate": return encodeAbiParameters([B32, { type: "uint256" }], [v.id, v.maxRate6]);
    case "deploy.setActive": return encodeAbiParameters([B32, { type: "bool" }], [v.id, v.active]);
    case "deploy.refund": return encodeAbiParameters([B32], [v.id]);
    case "app.publish": return encodeAbiParameters(PUBLISH, [a as PublishArgs]);
  }
  throw new Error(`unknown action ${String(action)}`);
}

/** What an action spends from the session budget (before the relay fee). */
export function amountOf<A extends OnChainAction>(action: A, a: ActionArgs[A]): bigint {
  if (action === "deploy.create") return (a as CreateArgs).fund6;
  if (action === "deploy.fund") return (a as ActionArgs["deploy.fund"]).amount6;
  return 0n;
}

/** Decode an action's raw args (the relay re-derives amounts from the bytes it is asked to submit). */
export function decodeArgs(action: OnChainAction, data: Hex): Record<string, unknown> {
  switch (action) {
    case "deploy.create": {
      const [c] = decodeAbiParameters(CREATE, data);
      const env = (Object.keys(ENVIRONMENTS) as Environment[]).find((k) => ENVIRONMENTS[k] === c.env);
      return { ...c, env };
    }
    case "deploy.fund": { const [id, amount6] = decodeAbiParameters([B32, { type: "uint256" }], data); return { id, amount6 }; }
    case "deploy.setAppRef": { const [id, appRef] = decodeAbiParameters([B32, { type: "string" }], data); return { id, appRef }; }
    case "deploy.setConfig": { const [id, configCid] = decodeAbiParameters([B32, { type: "string" }], data); return { id, configCid }; }
    case "deploy.setShares": {
      const [id, gpuMilli, cpuMilli] = decodeAbiParameters([B32, { type: "uint16" }, { type: "uint16" }], data);
      return { id, gpuMilli, cpuMilli };
    }
    case "deploy.setMaxRate": { const [id, maxRate6] = decodeAbiParameters([B32, { type: "uint256" }], data); return { id, maxRate6 }; }
    case "deploy.setActive": { const [id, active] = decodeAbiParameters([B32, { type: "bool" }], data); return { id, active }; }
    case "deploy.refund": { const [id] = decodeAbiParameters([B32], data); return { id }; }
    case "app.publish": { const [p] = decodeAbiParameters(PUBLISH, data); return { ...p }; }
  }
}

export const actionIndex = (a: OnChainAction): number => ACTIONS[a];
export const actionByIndex = (i: number): OnChainAction | undefined =>
  (Object.keys(ACTIONS) as OnChainAction[]).find((k) => ACTIONS[k] === i && i < 128);
