// DEBUG: one warden-stage run against a mock host, printing its output (no assertions)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const WS = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), MAIN = path.resolve(WS, "../enclave");
const r = fs.mkdtempSync(path.join(os.tmpdir(), "eu-dbg-")); for (const d of ["mock", "opt", "etc/systemd/system", "stage"]) fs.mkdirSync(path.join(r, d), { recursive: true });
fs.symlinkSync(MAIN, path.join(r, "opt/enclave"));
for (const [s, d] of [["package/lease-relay.mjs", "lease-relay.mjs"], ["package/lease-relay.package.json", "lease-relay.package.json"], ["package/gate/lease-relay-migration-check.mjs", "lease-relay-migration-check.mjs"], ["config/lease-gas-deployment.json", "lease-gas-deployment.json"], ["config/enclave-host-relay.service", "enclave-host-relay.service"]]) fs.copyFileSync(path.join(WS, s), path.join(r, "stage", d));
const t = JSON.parse(fs.readFileSync(path.join(WS, "config/host-relay.template.json"))); t.relay = { ...t.relay, rpc: ["https://a.example", "https://b.example"], quorum: 2, maxFloatEth: "0.002", minFloatEth: "0.0002" };
fs.writeFileSync(path.join(r, "stage/host-relay.json"), JSON.stringify(t));
for (const m of ["--check", "--stage"]) { const x = spawnSync("bash", [path.join(WS, "root/warden-stage.sh"), m, path.join(r, "stage")], { encoding: "utf8", env: { PATH: `${WS}/test/mockbin:${process.env.PATH}`, FSROOT: r, MOCK_UNIT: "enclave-host-relay.service", NODE: process.execPath } }); console.log(m, x.status, x.stdout, x.stderr); }
fs.rmSync(r, { recursive: true, force: true });
