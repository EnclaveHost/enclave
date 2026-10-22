#!/usr/bin/env node
// pa-credentials-assemble.mjs -- OPAQUE assembly of the platform credentials document and the public relayEnv from the old
// API's environment file. ROOT RUNS IT on the box that holds the file. Not run by the worker; no value is ever printed.
//
//   node pa-credentials-assemble.mjs --env-file <the old service's EnvironmentFile> --creds-out creds.json --public-out relay-env.json
//        --imports-out imports.json [--allow-missing NAME,NAME]
//   node pa-credentials-assemble.mjs --env-file F --names-only      (before cutover: classify NAMES and list the imports; writes
//                                                                   nothing, reads no *_FILE content)
//
// Every name in the old env is classified by ONE rule (common.mjs isCredential / ROLE_OWNED / READ_NAMES):
//   creds.json     (0600, must not exist): every credential-shaped name (the 15 first-inventory names and any other the env
//                  sets: INTERNAL_TOKEN, PADS_MASTER_SEED, REFERRAL_ADMIN_TOKEN, METAL_TUNNEL_TOKENS, CERTS_KEY, SESSION_KEY_FILE,
//                  SSO_SIGNER_KEY_FILE, ALERT_WEBHOOK_URL, …). A *_FILE value is the CONTENT of the file the old env points at
//                  (the role writes it to a 0600 RAM file). Input to platform-api-admin.mjs genesis|credentials --credentials.
//   relay-env.json (0600): every other name the bundled relay reads, value unchanged, so the original origin, passkey RP id and
//                  origins, SIWE/SSO domains, CORS, billing policy, contracts and feature flags stay exactly as today. State
//                  paths are rewritten into the guest's replicated data directory (ROUTE_STATE_DIR always: its default is
//                  outside AUTH_DATA_DIR); verifier caches are dropped. Input to platformApi.relayEnv.
//   imports.json   (0600): the old box's out-of-directory state to import (pa-export-check.mjs --imports).
// Dropped and listed by NAME only: names the role sets itself, and names the bundled relay never reads.
// Prints only names (present, missing, dropped, review). Never a value.
import fs from "node:fs";
import path from "node:path";
import { CREDENTIAL_NAMES, READ_NAMES, ROLE_OWNED, OUTSIDE_STATE, DROPPED_CACHES, HOST_PATH_NAMES, GUEST_DATA, isCredential, args, writeNew, die, load } from "./common.mjs";

/** systemd EnvironmentFile syntax: KEY=VALUE, optional single/double quotes, # comments, optional `export ` */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
/** -> { credentials, relayEnv, imports, report, fatal } with values only inside the returned objects */
export function assemble(env, { allowMissing = [], readFile = (f) => fs.readFileSync(f, "utf8") } = {}) {
  const credentials = {}, relayEnv = {}, imports = [];
  const report = { credentials: [], credentialsMissing: [], public: [], rewrittenToGuestData: [], droppedRoleOwned: [], droppedCaches: [], droppedNotRead: [], review: [] };
  for (const [k, v] of Object.entries(env)) {
    if (ROLE_OWNED.includes(k)) { report.droppedRoleOwned.push(k); continue; }
    if (isCredential(k)) {
      if (v === "") continue;
      if (k.endsWith("_FILE")) {
        const st = fs.lstatSync(v);
        if (!st.isFile()) throw new Error(`${k} does not point at a regular file`);
        credentials[k] = readFile(v);
      } else credentials[k] = v;
      report.credentials.push(k);
      if (!READ_NAMES.includes(k)) report.review.push(`${k}: credential-shaped but not read by the bundled relay`);
      continue;
    }
    if (!READ_NAMES.includes(k)) { report.droppedNotRead.push(k); continue; }
    if (DROPPED_CACHES.includes(k)) { report.droppedCaches.push(k); continue; }
    const out = OUTSIDE_STATE.find((x) => x.name === k);
    if (out) {
      if (out.relativeOk && !path.isAbsolute(v)) { relayEnv[k] = v; report.public.push(k); continue; } // relative: already under the data dir (cwd)
      if (v !== "") { imports.push({ rel: out.rel, src: v }); relayEnv[k] = `${GUEST_DATA}/${out.rel}`; report.rewrittenToGuestData.push(k); }
      continue;
    }
    relayEnv[k] = v; report.public.push(k);
    if (HOST_PATH_NAMES.includes(k) && /^\/|^\.\.?\//.test(v)) report.review.push(`${k}: a host path; it does not exist in the guest (use SECRETS_RELEASE_PREDICT_GATEWAYS)`);
    // relayEnv is bound into the direct config, which every verifier receives: it must not carry an embedded API key
    if (/https?:\/\/[^\s,]*(?:[?&](?:key|apikey|api_key|token)=|\/v[23]\/[A-Za-z0-9_-]{20,})/i.test(v)) report.review.push(`${k}: a URL that looks keyed; relayEnv is public`);
    if (/(^|[\s,])\/(?:var|etc|home|opt|srv|root)\//.test(v)) report.review.push(`${k}: names a host path`);
  }
  for (const x of OUTSIDE_STATE) if (x.always && !(x.name in relayEnv)) {
    imports.push({ rel: x.rel, src: x.dflt }); relayEnv[x.name] = `${GUEST_DATA}/${x.rel}`; report.rewrittenToGuestData.push(`${x.name} (default ${x.dflt})`);
  }
  for (const k of CREDENTIAL_NAMES) if (!(k in credentials)) report.credentialsMissing.push(k);
  const fatal = report.credentialsMissing.filter((k) => !allowMissing.includes(k));
  return { credentials, relayEnv, imports, report, fatal };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2));
  if (o["env-file"] && o["names-only"]) {
    const r = assemble(parseEnvFile(fs.readFileSync(o["env-file"], "utf8")), { readFile: () => "" });
    console.log(JSON.stringify({ ...r.report, imports: r.imports }, null, 1));
    process.exit(0);
  }
  if (!o["env-file"] || !o["creds-out"] || !o["public-out"] || !o["imports-out"]) die("usage: --env-file F --creds-out creds.json --public-out relay-env.json --imports-out imports.json [--allow-missing A,B]");
  const { checkCredentials } = await load("scripts/platform-api-admin.mjs");
  const r = assemble(parseEnvFile(fs.readFileSync(o["env-file"], "utf8")), { allowMissing: String(o["allow-missing"] || "").split(",").filter(Boolean) });
  console.log(JSON.stringify(r.report, null, 1));
  if (r.fatal.length) die(`REFUSED: credentials missing and not --allow-missing: ${r.fatal.join(", ")}`);
  checkCredentials(r.credentials);
  writeNew(o["creds-out"], JSON.stringify(r.credentials));
  writeNew(o["public-out"], JSON.stringify(r.relayEnv, null, 1));
  writeNew(o["imports-out"], JSON.stringify(r.imports, null, 1));
  console.error(`[closeout] wrote ${r.report.credentials.length} credential(s), ${Object.keys(r.relayEnv).length} relayEnv name(s), ${r.imports.length} import(s), 0600; review ${r.report.review.length}`);
}
