// Publication of a verified release under the EXISTING signed IPNS identity (work/site-release-interface.txt §4).
//
// The ipns-publisher app (../enclave-apps/ipns-publisher) signs with `ipnsKey`, a deployment secret its config
// references as "$NAME", and publishes `value`. POST /publish only republishes the configured value; it cannot set a
// new CID. So a new release is published by the deployment OWNER changing the app's config: `value` becomes the fixed
// "/ipfs/<CID>" (not a URL someone can rewrite), and every other key, the key reference included, stays byte-for-byte.
// That change is the ledger's owner-only setConfig, sent by the owner's own `enclave config set`. This module only
// PREPARES it: it signs nothing, sends nothing, and refuses a config that carries secret material.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { verifyRelease } from "./release.mjs";

const ENV_REF = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const KEYISH = [/^(?:0x)?[0-9a-fA-F]{64,}$/, /^[A-Za-z0-9+/_-]{43,}={0,2}$/];
const ID = /^0x[0-9a-f]{64}$/;

function secretPaths(v, at = []) {
  if (typeof v === "string") return KEYISH.some((r) => r.test(v)) ? [at.join(".")] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => secretPaths(x, [...at, i]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => secretPaths(x, [...at, k]));
  return [];
}

/**
 * -> {plan, configFile, planFile}. `shown` is the owner's `enclave config show <id> --json` output for the publisher
 * deployment (read through the quorum in independent mode).
 */
export function publicationPlan({ releaseDir, shown, deployment, owner = null, out }) {
  const m = verifyRelease(releaseDir), to = `/ipfs/${m.cid}`;
  const id = String(deployment || "").toLowerCase();
  if (!ID.test(id)) throw new Error("--deployment is the publisher's bytes32 deployment id");
  if (owner !== null && !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("--owner is the owner wallet's address");
  if (!shown || String(shown.id || "").toLowerCase() !== id) throw new Error("the config file is not `enclave config show` output for this deployment");
  if (shown.configSource === "owner-startup-package") throw new Error("this deployment's config is committed in an owner startup package; change it through bootstrap prepare/publish/activate");
  if (shown.configCid) throw new Error("this deployment's config is pinned by CID (too large for the envelope); this plan handles only an inline config");
  const config = shown.config;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("the deployment has no per-deployment config object; the publisher's identity must come from a deployment config ($IPNS_ED25519_SK)");
  // the identity must stay a REFERENCE to the deployment secret: never a key in a plan, a file or a ledger record
  if (typeof config.ipnsKey !== "string" || !ENV_REF.test(config.ipnsKey))
    throw new Error("ipnsKey must be a $NAME reference to the deployment secret (refusing: the value is not shown)");
  if (config.api_key !== undefined && !(typeof config.api_key === "string" && (config.api_key === "" || ENV_REF.test(config.api_key))))
    throw new Error("api_key must be a $NAME reference (refusing: the value is not shown)");
  const { value: _value, ...rest } = config;
  const found = secretPaths(rest);
  if (found.length) throw new Error(`refusing a config with key-like material at ${found.join(", ")} (values are not shown)`);
  const from = typeof config.value === "string" ? config.value : null;
  if (from === to) throw new Error(`the publisher already publishes ${to}; nothing to change`);
  const next = { ...config, value: to };
  const warnings = [];
  if (from && /^https?:\/\//i.test(from)) warnings.push(`the old value was a mutable URL (${from}): whoever controls it chose the CID. The new value pins ${m.cid} itself.`);
  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > 3000) warnings.push(`the config is ${bytes} bytes; with the rest of the options envelope it may exceed the ledger's 4096-byte limit (then config set needs --storage-plan)`);
  fs.mkdirSync(out, { recursive: true });
  const configFile = path.join(path.resolve(out), `publisher-config-${m.cid}.json`), planFile = path.join(path.resolve(out), `publication-plan-${m.cid}.json`);
  const set = ["enclave", "config", "set", id, "--file", configFile];
  const plan = {
    schema: "enclave-site-publication/1", cid: m.cid, deployment: id, from, to,
    identityUnchanged: true, identity: { ipnsKey: config.ipnsKey }, changedKeys: ["value"],
    warnings,
    operations: [
      { who: "the deployment owner's wallet", argv: set,
        note: "add your trust flags (independent: --independent --profile FILE --profile-digest sha256:… --rpc A,B,C); setConfig is owner-only" },
      { who: "an external owner wallet", argv: [...set, "--unsigned", "--from", owner ?? "OWNER_ADDRESS"],
        note: "prints the exact setConfig transaction to sign elsewhere" },
    ],
    effect: "the host relaunches the app with the new ENCLAVE_CONFIG; it signs value " + to + " with the same key at sequence max+1",
    after: [
      `the publisher's GET /api/status shows value ${to} and a higher sequence`,
      "an independent resolver (one that is not the publisher) resolves the publisher's /ipns/<name> to " + to,
      "every mirror target serves " + m.cid + " (site-release verify / activate probes)",
    ],
  };
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n", { mode: 0o644 });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n", { mode: 0o644 });
  return { plan, configFile, planFile };
}

// ---- automated publication through the REAL enclave CLI (work/site-automation-interface.txt §5) ---------------------
// mode "session": the publisher record is held by the owner's vault in STAGING and the operator holds a session limited
//   to deploy.setConfig (SessionVault allows a session's setConfig only there). Each release is then `config set` by
//   that session, with a gas payer that authorizes nothing; no wallet ceremony per release.
// mode "plan": anything else (a wallet-held or production record): the exact owner operation is prepared and the
//   publication is reported PENDING the owner's authorization.
// The publication file holds no secret: environment variable NAMES are passed through to the CLI, never values.

const TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SECRET_FLAGS = new Set(["--key", "--private-key", "--mnemonic", "--wallet", "--signer"]);

export function loadPublication(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = ["version", "deployment", "mode", "cli", "cliArgs", "passEnv", "owner", "timeoutMs"];
  if (!c || typeof c !== "object" || Array.isArray(c) || !Object.keys(c).every((k) => keys.includes(k)) || c.version !== 1)
    throw new Error(`a publication file is {version: 1, ${keys.slice(1).join(", ")}}`);
  if (!ID.test(String(c.deployment || "").toLowerCase())) throw new Error("deployment is the publisher's bytes32 deployment id");
  if (!["session", "plan"].includes(c.mode)) throw new Error("mode is session or plan");
  // @node = this node; @enclave-cli = this checkout's cli/enclave.mjs (the same tool on an operator machine and in CI)
  if (!Array.isArray(c.cli) || !c.cli.length || !c.cli.every((t) => typeof t === "string" && TOKEN.test(t)) || !(c.cli[0] === "@node" || path.isAbsolute(c.cli[0])))
    throw new Error("cli is an argv whose program is @node or an absolute path (@enclave-cli names this checkout's CLI)");
  if (!Array.isArray(c.cliArgs) || !c.cliArgs.every((t) => typeof t === "string" && TOKEN.test(t)))
    throw new Error("cliArgs are plain tokens (the trust flags)");
  for (const t of c.cliArgs) {
    if (SECRET_FLAGS.has(t)) throw new Error(`cliArgs must not choose a signer (${t}): the session or the owner's own environment does`);
    if (KEYISH.some((r) => r.test(t)) && !/^0x[0-9a-fA-F]{64}$/.test(t) && !/^sha256:/.test(t)) throw new Error("cliArgs carry something key-like (values are not shown)");
  }
  if (c.passEnv !== undefined && !(Array.isArray(c.passEnv) && c.passEnv.every((n) => typeof n === "string" && ENV_NAME.test(n))))
    throw new Error("passEnv lists environment variable NAMES");
  if (c.owner !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(c.owner)) throw new Error("owner is an address");
  return { ...c, deployment: c.deployment.toLowerCase() };
}

const ENCLAVE_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../cli/enclave.mjs");
function runCli(c, sub, env) {
  const argv = [...c.cli.slice(1).map((t) => (t === "@enclave-cli" ? ENCLAVE_CLI : t)), ...sub, ...c.cliArgs];
  const childEnv = { PATH: env.PATH ?? process.env.PATH, HOME: env.HOME ?? process.env.HOME };
  for (const n of c.passEnv ?? []) if (env[n] !== undefined) childEnv[n] = env[n];
  const program = c.cli[0] === "@node" ? process.execPath : c.cli[0];
  return new Promise((resolve) => execFile(program, argv, { env: childEnv, timeout: c.timeoutMs ?? 300000, maxBuffer: 8 << 20 },
    (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) })));
}
const lastJson = (out) => { const i = out.lastIndexOf("\n{"); return JSON.parse(i >= 0 ? out.slice(i + 1) : out.slice(out.indexOf("{"))); };
const tail = (s) => s.trim().split("\n").slice(-3).join(" | ").slice(0, 400);

/**
 * Publish a verified release through the configured CLI. -> {state, ...}:
 *   "already-published" | "config-set" (the on-chain config now holds /ipfs/<CID>) | "pending-owner" (plan written) |
 *   "outcome-unknown" (the CLI could not tell whether its transaction landed: never resent).
 */
export async function publishRelease(c, releaseDir, { out, env = process.env } = {}) {
  const m = verifyRelease(releaseDir), to = `/ipfs/${m.cid}`;
  const show = async () => {
    const r = await runCli(c, ["config", "show", c.deployment, "--json"], env);
    if (r.code !== 0) throw new Error(`enclave config show failed: ${tail(r.err || r.out)}`);
    return lastJson(r.out);
  };
  const shown = await show();
  if (shown?.config?.value === to) return { state: "already-published", cid: m.cid, deployment: c.deployment };
  const plan = publicationPlan({ releaseDir, shown, deployment: c.deployment, owner: c.owner ?? null, out });
  if (c.mode === "plan") return { state: "pending-owner", cid: m.cid, deployment: c.deployment, planFile: plan.planFile, configFile: plan.configFile, warnings: plan.plan.warnings };
  const set = await runCli(c, ["config", "set", c.deployment, "--file", plan.configFile, "--yes"], env);
  if (set.code === 4) return { state: "outcome-unknown", cid: m.cid, deployment: c.deployment, detail: tail(set.err), planFile: plan.planFile };
  if (set.code !== 0) throw new Error(`enclave config set (session) failed: ${tail(set.err || set.out)}; the plan for the owner is ${plan.planFile}`);
  const after = await show();
  if (after?.config?.value !== to) throw new Error(`the ledger does not show value ${to} after config set`);
  const { value: _a, ...restAfter } = after.config, { value: _b, ...restBefore } = shown.config;
  if (JSON.stringify(restAfter) !== JSON.stringify(restBefore)) throw new Error("config set changed more than `value`");
  return { state: "config-set", cid: m.cid, deployment: c.deployment, from: plan.plan.from, to, identity: plan.plan.identity, warnings: plan.plan.warnings };
}
