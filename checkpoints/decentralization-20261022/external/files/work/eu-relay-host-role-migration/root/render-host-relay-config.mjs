#!/usr/bin/env node
// render-host-relay-config.mjs - ROOT renders warden's /etc/enclave/host-relay.json from the template and the eu-central
// relay's reviewed relay.env, so the moved key keeps EXACTLY the settings it ran with (RPCs, quorum, float caps).
//   node render-host-relay-config.mjs <relay.env> <out host-relay.json> [--repo /path/to/enclave]
// relay.env must be the reviewed bytes (sha256 7c05d44a..., the file eu-source-stop.sh CAS-checks on eu-central). Only four
// PUBLIC names are read from it, as NAME=value lines (no shell evaluation): LEASE_RELAY_RPCS, LEASE_RELAY_QUORUM,
// LEASE_RELAY_MAX_FLOAT_ETH, LEASE_RELAY_MIN_FLOAT_ETH. Its LEASE_RELAY_DIGEST must equal the template's record digest.
// The result is validated by the repository's own validateHostRelayConfig (the role's rule; it refuses any key-like
// field) and written create-only; its sha256 is printed. Nothing else is read or written.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_SHA = "7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const at = args.indexOf("--repo"), repo = path.resolve(at >= 0 ? args.splice(at, 2)[1] : path.join(HERE, "../../enclave"));
const [envFile, out] = args;
const die = (m) => { console.error(`render: ${m}`); process.exit(1); };
if (!envFile || !out) { console.error("usage: render-host-relay-config.mjs <relay.env> <out host-relay.json> [--repo DIR]"); process.exit(2); }
const envBytes = fs.readFileSync(envFile);
// TEST ONLY: the tests render from a synthetic relay.env; production never sets this
const wantEnv = process.env.RENDER_TEST_ENV_SHA256 || ENV_SHA;
if (process.env.RENDER_TEST_ENV_SHA256) console.log("** TEST: relay.env pin overridden (RENDER_TEST_ENV_SHA256): not a production render **");
if (sha(envBytes) !== wantEnv) die(`${envFile} is not the reviewed relay.env (${sha(envBytes)} != ${wantEnv})`);
const value = (name) => {
  const lines = envBytes.toString("utf8").split(/\r?\n/).filter((l) => l.startsWith(`${name}=`));
  if (lines.length !== 1) die(`relay.env must set ${name} exactly once`);
  return lines[0].slice(name.length + 1).trim();
};
const tpl = JSON.parse(fs.readFileSync(path.join(HERE, "../config/host-relay.template.json"), "utf8"));
if (value("LEASE_RELAY_DIGEST") !== tpl.relay.digest) die("relay.env's LEASE_RELAY_DIGEST is not the template's reviewed record digest");
const quorum = value("LEASE_RELAY_QUORUM");
if (!/^[1-9][0-9]*$/.test(quorum)) die("LEASE_RELAY_QUORUM is not an integer");
const cfg = { ...tpl, relay: { ...tpl.relay, rpc: value("LEASE_RELAY_RPCS").split(",").map((s) => s.trim()).filter(Boolean), quorum: Number(quorum),
  maxFloatEth: value("LEASE_RELAY_MAX_FLOAT_ETH"), minFloatEth: value("LEASE_RELAY_MIN_FLOAT_ETH") } };
if (JSON.stringify(cfg).includes("FROM_SOURCE_RELAY_ENV")) die("a template value was not rendered");
const { validateHostRelayConfig } = await import(pathToFileURL(path.join(repo, "network/host-services/lease-relay-host.mjs")).href);
try { validateHostRelayConfig(cfg); } catch (e) { die(e.message); }
const bytes = Buffer.from(JSON.stringify(cfg, null, 2) + "\n");
try { fs.writeFileSync(out, bytes, { flag: "wx", mode: 0o644 }); } catch (e) { die(`${out}: ${e.code === "EEXIST" ? "exists (never overwritten)" : e.message}`); }
console.log(JSON.stringify({ out, sha256: sha(bytes), package: cfg.relay.package, rpcs: cfg.relay.rpc.length, quorum: cfg.relay.quorum }));
