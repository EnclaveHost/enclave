#!/usr/bin/env node
// user-render-config.mjs - renders the user target's host-relay.json from config/host-relay-user.template.json, the
// release (its id, its relay package pin, its own copy of the role's validateHostRelayConfig) and eu-central's REVIEWED
// relay.env, so the moved key keeps exactly the settings it ran with. Only four PUBLIC names are read from relay.env, as
// NAME=value lines (no shell evaluation): LEASE_RELAY_RPCS, LEASE_RELAY_QUORUM, LEASE_RELAY_MAX_FLOAT_ETH,
// LEASE_RELAY_MIN_FLOAT_ETH; its LEASE_RELAY_DIGEST must be the template's. The output is create-only, 0600.
//   node user-render-config.mjs <relay.env> <release dir> <out> [--target-root /home/steven/enclave-prod/host-relay-eu]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_SHA = "7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769";   // eu-central's reviewed relay.env
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const at = args.indexOf("--target-root"), target = at >= 0 ? args.splice(at, 2)[1] : "/home/steven/enclave-prod/host-relay-eu";
const [envFile, releaseDir, out] = args;
const die = (m) => { console.error(`render: ${m}`); process.exit(1); };
if (!envFile || !releaseDir || !out) { console.error("usage: user-render-config.mjs <relay.env> <release dir> <out> [--target-root DIR]"); process.exit(2); }
if (!/^\/[A-Za-z0-9_./-]+$/.test(target) || target.includes("..")) die("the target root must be a plain absolute path");
const env = fs.readFileSync(envFile);
const wantEnv = process.env.RENDER_TEST_ENV_SHA256 || ENV_SHA;           // TEST ONLY: a synthetic relay.env
if (process.env.RENDER_TEST_ENV_SHA256) console.log("** TEST: relay.env pin overridden (RENDER_TEST_ENV_SHA256): not a production render **");
if (sha(env) !== wantEnv) die(`${envFile} is not the reviewed relay.env`);
const value = (name) => {
  const lines = env.toString("utf8").split(/\r?\n/).filter((l) => l.startsWith(`${name}=`));
  if (lines.length !== 1) die(`relay.env must set ${name} exactly once`);
  return lines[0].slice(name.length + 1).trim();
};
const rel = JSON.parse(fs.readFileSync(path.join(releaseDir, "RELEASE.json"), "utf8"));
if (path.basename(path.resolve(releaseDir)) !== rel.releaseId) die("the release directory is not named by its id");
let text = fs.readFileSync(path.join(HERE, "../config/host-relay-user.template.json"), "utf8");
text = text.replaceAll("@TARGET@", target).replaceAll("@RELEASE@", rel.releaseId).replaceAll("@RELAY_PACKAGE@", rel.relayPackage.pin);
const tpl = JSON.parse(text);
if (value("LEASE_RELAY_DIGEST") !== tpl.relay.digest) die("relay.env's LEASE_RELAY_DIGEST is not the reviewed record digest");
const quorum = value("LEASE_RELAY_QUORUM");
if (!/^[1-9][0-9]*$/.test(quorum)) die("LEASE_RELAY_QUORUM is not an integer");
const cfg = { ...tpl, relay: { ...tpl.relay, rpc: value("LEASE_RELAY_RPCS").split(",").map((s) => s.trim()).filter(Boolean), quorum: Number(quorum),
  maxFloatEth: value("LEASE_RELAY_MAX_FLOAT_ETH"), minFloatEth: value("LEASE_RELAY_MIN_FLOAT_ETH") } };
if (JSON.stringify(cfg).includes("FROM_SOURCE_RELAY_ENV") || JSON.stringify(cfg).includes("@")) die("a template value was not rendered");
const { validateHostRelayConfig } = await import(pathToFileURL(path.join(releaseDir, "app/network/host-services/lease-relay-host.mjs")).href);
try { validateHostRelayConfig(cfg); } catch (e) { die(e.message); }
const bytes = Buffer.from(JSON.stringify(cfg, null, 2) + "\n");
try { fs.writeFileSync(out, bytes, { flag: "wx", mode: 0o600 }); } catch (e) { die(`${out}: ${e.code === "EEXIST" ? "exists (never overwritten)" : e.message}`); }
console.log(JSON.stringify({ out, sha256: sha(bytes), releaseId: rel.releaseId, package: cfg.relay.package, rpcs: cfg.relay.rpc.length, quorum: cfg.relay.quorum }));
