import { bytesToHex, type Hex } from "viem";
import { ACTIONS, ACTION_TEXT, ENVIRONMENTS, ZERO_HASH, type ActionName, type Environment } from "./constants.js";
import { base64url, fromBase64url } from "./keys.js";
import type { Grant } from "./typed.js";

/** A policy: everything in a grant except the key and the nonces. Presets are
 *  plain templates of this - adding one needs no backend or contract change. */
export interface Policy {
  actions: ActionName[];
  apps: string[];
  environments: Environment[];
  budget: bigint;
  spendPerPeriod: bigint;
  periodSeconds: number;
  opsPerPeriod: number;
  maxFeePerOp: bigint;
  maxAppFeePerHour: bigint;
  /** seconds from signing */
  expiresIn: number;
  measurement?: Hex;
}

const HOUR = 3600;
const DAY = 86400;
const USD = 1_000_000n;

export const PRESETS: Record<string, Policy & { maxExpiresIn: number; description: string }> = {
  /** Browser sign-in: normal platform use. Zero budget by default; top up on demand. */
  browser: {
    description: "Sign-in on this browser: deploy, manage and fund your deployments without a wallet prompt each time.",
    // publishing stays a wallet action in the browser: a browser user's apps are
    // wallet-published, and app.publish only ever reaches apps the VAULT holds
    actions: ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
      "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "order.pay",
      "api.status", "api.logs", "api.restart", "api.upload", "api.appAccess", "api.placement"],
    apps: ["*"],
    environments: ["staging", "prod"],
    budget: 0n,
    spendPerPeriod: 100n * USD,    // a daily ceiling that survives top-ups
    periodSeconds: DAY,
    opsPerPeriod: 0,
    maxFeePerOp: USD / 4n,         // $0.25 ceiling; Base fees are ~1-2 cents per op
    maxAppFeePerHour: USD,         // $1/h publisher fee ceiling for new deployments
    expiresIn: 12 * HOUR,
    maxExpiresIn: 30 * DAY,
  },
  /** An agent publishing to staging: named apps only, small budget, a week. */
  "staging-publish": {
    description: "An agent publishing STAGING versions of the named apps and running them on staging deployments.",
    actions: ["app.publish", "deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig",
      "deploy.setActive", "api.status", "api.logs", "api.restart", "api.upload"],
    apps: [],
    environments: ["staging"],
    budget: 10n * USD,
    spendPerPeriod: 5n * USD,
    periodSeconds: DAY,
    opsPerPeriod: 120,
    maxFeePerOp: USD / 10n,        // $0.10 ceiling; the daily cap bounds the total
    maxAppFeePerHour: 0n,
    expiresIn: 7 * DAY,
    maxExpiresIn: 28 * DAY,
  },
  /** Authentication only: read status, nothing on-chain, no money. */
  "auth-only": {
    description: "Read deployment status only. No money, nothing on-chain.",
    actions: ["api.status"],
    apps: [],
    environments: [],
    budget: 0n,
    spendPerPeriod: 0n,
    periodSeconds: DAY,
    opsPerPeriod: 0,
    maxFeePerOp: 0n,
    maxAppFeePerHour: 0n,
    expiresIn: 12 * HOUR,
    maxExpiresIn: 7 * DAY,
  },
};

export type PresetName = keyof typeof PRESETS;

function randomHex32(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

export interface BuildGrantInput {
  sessionKey: Hex;
  label: string;
  preset?: PresetName | string;
  policy?: Partial<Policy>;
  /** seconds the owner has to sign (default 24 h for links, short for in-page) */
  signWithin?: number;
  now?: number;
}

/** Build a grant from a preset (plus overrides) or a full custom policy. */
export function buildGrant(input: BuildGrantInput): Grant {
  const presetName = input.preset ?? "custom";
  const base = PRESETS[presetName];
  if (!base && !input.policy) throw new Error(`unknown preset "${presetName}"`);
  const p: Policy = { ...(base ?? PRESETS["auth-only"]), ...(input.policy ?? {}) } as Policy;
  if (base && p.expiresIn > base.maxExpiresIn) throw new Error(`"${presetName}" sessions last at most ${base.maxExpiresIn / DAY} days`);
  validatePolicy(p);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return {
    label: input.label,
    preset: presetName,
    sessionKey: input.sessionKey,
    actions: [...p.actions],
    apps: [...p.apps],
    environments: [...p.environments],
    budget: p.budget,
    spendPerPeriod: p.spendPerPeriod,
    periodSeconds: p.periodSeconds,
    opsPerPeriod: p.opsPerPeriod,
    maxFeePerOp: p.maxFeePerOp,
    maxAppFeePerHour: p.maxAppFeePerHour,
    expiresAt: BigInt(now + p.expiresIn),
    measurement: p.measurement ?? ZERO_HASH,
    grantNonce: randomHex32(),
    signBefore: BigInt(now + (input.signWithin ?? 24 * HOUR)),
  };
}

export function validatePolicy(p: Policy): void {
  for (const a of p.actions) if (!(a in ACTIONS)) throw new Error(`unknown action "${a}"`);
  for (const e of p.environments) if (!(e in ENVIRONMENTS)) throw new Error(`unknown environment "${e}"`);
  if (p.apps.length > 8) throw new Error("a grant names at most 8 apps");
  if (p.periodSeconds <= 0) throw new Error("periodSeconds must be > 0");
  if (p.expiresIn <= 0) throw new Error("expiry must be in the future");
  const needsApp = p.actions.some((a) => a === "app.publish" || a === "deploy.setAppRef" || a === "deploy.create");
  if (needsApp && p.apps.length === 0) throw new Error("this preset needs --app (which apps the session may use)");
  if (p.actions.includes("app.publish") && p.apps.every((a) => a === "*"))
    throw new Error('publishing needs the app named explicitly ("*" never covers app.publish)');
}

export const fmtUsd = (v: bigint) => {
  const n = Number(v) / 1e6;
  return n !== 0 && n < 0.01 ? `$${n.toFixed(6).replace(/0+$/, "")}` : `$${n.toFixed(2)}`;
};
const fmtDur = (s: number) => s >= DAY ? `${+(s / DAY).toFixed(1)} days` : `${+(s / HOUR).toFixed(1)} hours`;

/** Plain-language lines describing a grant, for the grant page and the CLI. */
export function describeGrant(g: Grant, now = Math.floor(Date.now() / 1000)): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const onchain = g.actions.filter((a) => (ACTIONS as Record<string, number>)[a] < 128);
  const api = g.actions.filter((a) => (ACTIONS as Record<string, number>)[a] >= 128);
  if (onchain.length) lines.push(`May: ${onchain.map((a) => ACTION_TEXT[a as ActionName] ?? a).join("; ")}.`);
  if (api.length) lines.push(`API access: ${api.map((a) => ACTION_TEXT[a as ActionName] ?? a).join("; ")}.`);
  const apps = g.apps.filter((a) => a !== "*");
  if (g.apps.includes("*")) lines.push(`Apps: any app${apps.length ? `, and publishing only to ${apps.join(", ")}` : ""}.`);
  else if (apps.length) lines.push(`Apps: only ${apps.join(", ")}.`);
  if (g.environments.length) lines.push(`Environments: ${g.environments.join(" and ")}.`);
  lines.push(`Budget: ${fmtUsd(g.budget)} escrowed; at most ${fmtUsd(g.spendPerPeriod)} per ${fmtDur(g.periodSeconds)}` +
    `${g.opsPerPeriod ? `, ${g.opsPerPeriod} operations per ${fmtDur(g.periodSeconds)}` : ""}; relay fee at most ${fmtUsd(g.maxFeePerOp)} per operation.`);
  lines.push(`Expires: in ${fmtDur(Number(g.expiresAt) - now)}. Unspent budget returns to your wallet when it ends.`);
  lines.push("Never allowed: withdrawing, promoting to production, secrets, opening or changing other sessions.");
  if (g.environments.includes("prod")) warnings.push("This session can act on PRODUCTION deployments (not change what version they run).");
  if (g.apps.includes("*") && g.actions.includes("deploy.create")) warnings.push("This session can deploy ANY app from the store.");
  if (g.budget > 100n * 1_000_000n) warnings.push(`Large budget: ${fmtUsd(g.budget)}.`);
  if (Number(g.expiresAt) - now > 14 * DAY) warnings.push(`Long-lived: ${fmtDur(Number(g.expiresAt) - now)}.`);
  if (g.measurement !== ZERO_HASH) lines.push(`Key must live inside an enclave with measurement ${g.measurement.slice(0, 18)}…`);
  return { lines, warnings };
}

// ---- grant links (CLI -> owner's browser) ------------------------------------------

/** What a CLI hands the owner: the grant MINUS the vault (unknown until the owner
 *  connects), with the public key so the page can show the check code. Lives in
 *  the URL fragment, so it never reaches a server. */
export interface GrantRequest {
  v: 1;
  chainId: number;
  relay: string;
  x: string;
  y: string;
  grant: Grant;
  /** if set, only this wallet may sign it (the page refuses others) */
  owner?: Hex;
}

const ser = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const de = <T>(s: string): T => JSON.parse(s, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

export function encodeGrantRequest(r: GrantRequest): string {
  return base64url(new TextEncoder().encode(ser(r)));
}

export function decodeGrantRequest(s: string): GrantRequest {
  const r = de<GrantRequest>(new TextDecoder().decode(fromBase64url(s)));
  if (r.v !== 1 || !r.grant || !r.x || !r.y) throw new Error("not a session grant request");
  return r;
}

export function grantLink(siteOrigin: string, r: GrantRequest): string {
  return `${siteOrigin.replace(/\/$/, "")}/grant#${encodeGrantRequest(r)}`;
}

export { ser as serialize, de as deserialize };
