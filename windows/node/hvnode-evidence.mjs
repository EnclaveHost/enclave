// hvnode-evidence.mjs - the node's identity evidence when it hosts ONLY the isolated backend (a Hyper-V type-1
// partition per app), with no VBS enclave engine loaded. Format windows-hv-node/v1, verified by the relay
// (enclave-99's relay/hvnode-verify.mjs, reusing relay/vbs-verify.mjs's EK, credential, quote and log checks).
//
// WHAT THIS EVIDENCE PROVES, exactly, and nothing more (enclave-d1's condition 1):
//   an admin-level process on this TPM's host, in this measured boot state, chose and holds this transport key.
// The key is generated and held by a host-OS process (this agent). Credential activation uses the endorsement
// authorization that any host administrator holds. So it says NOTHING about isolation, nothing about excluding
// the host, and nothing about any app: each app's evidence comes from its own partition. The node is the host.
// It carries app traffic as ciphertext between the relay and a partition's guest-held TLS.
//
// The PCR 0 (firmware) value is carried, and the RELAY checks it against a pin list. This module does not claim it.
//
// The binding (enclave-99's shape, every part fixed width):
//   bound = "enclave-hv-node-bind-v1\n" || spki (44, Ed25519 SPKI) || nonce (32) || sha256(statementBytes) (32)
//   the TPM quote's qualifying data = sha256(bound), and the transport key signs `bound` (proof of possession)
// statementBytes are the exact bytes of the isolation manager's health summary sent in the frame, so the
// recorded host statement is the one made for this nonce. It is a host statement with no admission weight.
// The domain differs from the legacy enclave binding ("enclave-vbs-bind-v1\n"), so neither format's quote can
// verify as the other. This module never builds a windows-vbs-enclave/v1 frame.
import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { parseTcgLog, sipaFields, secureBootFromLog } from "../../relay/vbs-tcglog.mjs";
import { VBS_REQUIRED_PCR12 } from "../../relay/vbs-verify.mjs";

export const HV_NODE_FORMAT = "windows-hv-node/v1";
export const HV_NODE_BIND_DOMAIN = "enclave-hv-node-bind-v1\n";
export const HV_NODE_PROVES =
  "an admin-level process on this TPM's host, in this measured boot state, chose and holds this transport key; " +
  "it proves nothing about isolation or host exclusion";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const b64 = (b) => Buffer.from(b).toString("base64");

// The production boot policy, as the relay applies it with no development relaxation: every PCR 12 field in
// VBS_REQUIRED_PCR12 at its required value (every occurrence), TESTSIGNING 0, and Secure Boot on.
export const HV_NODE_REQUIRED_PCR12 = { ...VBS_REQUIRED_PCR12, TESTSIGNING: 0 };

export function hvNodeBinding(spki, nonce, statementBytes) {
  const k = Buffer.from(spki), n = Buffer.from(nonce);
  if (k.length !== 44 || !k.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new Error("the transport key must be an Ed25519 SPKI (44 bytes)");
  if (n.length !== 32) throw new Error("the nonce must be 32 bytes");
  if (!Buffer.isBuffer(statementBytes)) throw new Error("the statement must be the exact bytes sent");
  return Buffer.concat([Buffer.from(HV_NODE_BIND_DOMAIN), k, n, sha256(statementBytes)]);
}
export const hvNodeChallenge = (bound) => sha256(bound);

// refusalsFromFacts({ secureBoot, fields }) -> [reason...]. Empty means "not refused by the node". It does NOT
// mean "passes": the relay's verdict is the one that counts.
//   secureBoot: the PCR 7 SecureBoot variable value (1 = on), or null if the log carries none
//   fields:     a Map of PCR 12 SIPA field name -> [values...], as relay/vbs-tcglog.mjs sipaFields returns
export function refusalsFromFacts({ secureBoot, fields }) {
  const out = [];
  if (secureBoot !== 1) out.push(`Secure Boot is not on (PCR 7 SecureBoot=${secureBoot ?? "absent"})`);
  for (const [name, want] of Object.entries(HV_NODE_REQUIRED_PCR12)) {
    const vals = (fields && fields.get(name)) || [];
    if (!vals.length) out.push(`${name} is absent from the log (it must be present and ${want})`);
    else if (!vals.every((v) => v === want)) out.push(`${name} is not ${want} (log: [${vals.join(", ")}])`);
  }
  return out;
}

// bootStateRefusals(logBytes) -> [reason...] from a TCG boot log. An unreadable log is a refusal.
export function bootStateRefusals(logBytes) {
  let events;
  try { ({ events } = parseTcgLog(Buffer.from(logBytes))); } catch (e) { return [`the boot log does not parse: ${e.message}`]; }
  let fields;
  try { fields = sipaFields(events, 12); } catch (e) { return [`the PCR 12 records do not decode: ${e.message}`]; }
  let secureBoot = null;
  try { secureBoot = secureBootFromLog(events); } catch { secureBoot = null; }
  return refusalsFromFacts({ secureBoot, fields });
}

// loadOrCreateNodeKey(dir) -> { spki, privateKey }: the agent's own Ed25519 transport key, created once and kept in
// the node's directory (owner-readable only). It is a HOST key: whoever administers this host can use it.
export function loadOrCreateNodeKey(dir, { file = "node-transport.key" } = {}) {
  const p = path.join(dir, file);
  let privateKey;
  if (fs.existsSync(p)) privateKey = createPrivateKey(fs.readFileSync(p, "utf8"));
  else {
    ({ privateKey } = generateKeyPairSync("ed25519"));
    fs.writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (spki.length !== 44) throw new Error("the node transport key is not Ed25519");
  return { spki, privateKey };
}

// isolationStatementBytes(health) -> the exact bytes of the host statement (UTF-8 JSON), or a JSON null when the
// manager cannot be asked. The node never raises the statement: a manager reporting host exclusion is refused
// here, because nothing on this tier establishes it. The relay stores it as hostStatement and never reads
// hostExcluded from it.
export function isolationStatementBytes(health) {
  if (!health || typeof health !== "object") return Buffer.from("null");
  const b = health.boundary || {};
  if (b.hostExcluded === true) throw new Error("the isolation manager reports host exclusion, which this tier never claims");
  return Buffer.from(JSON.stringify({ stated: true, backend: health.backend ?? null, tier: b.tier ?? null,
                                      hostExcluded: false, derivations: (health.catalog && health.catalog.derivations) || [] }));
}

// buildHvNodeFrame -> the 'attest' frame, on the existing challenge / vbs-keys / vbs-credential exchange.
//   tpm(cmd):   the node's tpmattest.exe line protocol, as agent.mjs tpmCmd drives it
//   readLog(p): reads the boot log the TPM tool names
export async function buildHvNodeFrame({ nonce, credentialBlob, secret, spki, privateKey, tpm, readLog = (p) => fs.readFileSync(p),
                                         managerHealth = null, platform = {} }) {
  const n = Buffer.from(nonce);
  const statementBytes = isolationStatementBytes(managerHealth);
  const bound = hvNodeBinding(spki, n, statementBytes);
  const logPath = (await tpm("log")).log;
  const bootLog = readLog(logPath);
  const refusals = bootStateRefusals(bootLog);
  if (refusals.length) throw new Error(`refusing to attest this node: ${refusals.join("; ")}`);
  const act = await tpm(`activate ${hex(credentialBlob)} ${hex(secret)}`);
  const q = await tpm(`quote ${hex(hvNodeChallenge(bound))}`);
  const pcr0 = String((await tpm("pcr 0")).pcr || "").split(" ").pop() || "";
  const keys = await tpm("keys");
  const evidence = {
    proves: HV_NODE_PROVES,
    statement: b64(statementBytes),
    signature: b64(edSign(null, bound, privateKey)),
    log: b64(bootLog),
    quote: { attest: b64(Buffer.from(q.attest, "hex")), sig: b64(Buffer.from(q.sig, "hex")), aikPub: b64(Buffer.from(q["aik-pub"], "hex")) },
    credential: b64(Buffer.from(act.credential, "hex")),
    ek: { cert: b64(Buffer.from(keys["ek-cert"], "hex")), chain: [] },
    pcr0,
    platform,
  };
  return { t: "attest", rad: { format: HV_NODE_FORMAT, transportKey: b64(spki), body: b64(Buffer.from(JSON.stringify(evidence))) } };
}
