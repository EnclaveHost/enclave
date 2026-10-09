// Sealed release of a deployment's secrets to its pVM (shielded/anchor/avf/PVM-CPU.md "Secrets"). A pVM host is an
// app-evidence host (hostEligibility: plaintextSecrets false), so its operator never gets a deployment's secrets in the
// clear (/v1/secrets/fetch refuses it); they are sealed to a key only the VM holds, signed by this relay's release key,
// and carried by the phone's host as ciphertext:
//
//   POST /v1/secrets/pvm-release {id, endpoint, ts, opSig}      the lease holder's host agent asks
//     opSig = personal_sign by the endpoint's registry operator of "enclave-pvm-secrets:<id>:<endpoint>:<ts>"
//   the relay asks the VM, through its tunnel, for evidence over the relay's OWN nonce:
//     GET /v1/pvm/secret-evidence?deployment=<id>&nonce=<hex>  ->  { evidence (v4), seal: { format, deployment, app,
//       sealKey, nonce, sig } }
//   evidence: verifyPvmAppEvidence, exactly as the market verifies the app (the pinned build, runtime and instance, this
//   tunnel's transport key, the component the relay fetched by the catalog's CID, the TLS key);
//   seal statement: the attested transport key's Ed25519 signature over
//     "enclave-pvm-seal-key-v1\n" || nonce(32) || deployment(32) || app sha256(32) || sealKey(32)
//   -- the seal key is the VM's X25519 key for THIS app and THIS deployment, derived from the VM instance's secret, so the
//   same VM opens the release again after a relaunch;
//   → { id, nonce, sealKey, sealed, sig, keyId, count, rev }: sealed = secrets-release.mjs sealRelease (ticket = nonce),
//     sig = its signResponse with the relay's release key (the VM pins that key: it verifies before it opens, so a host
//     that seals its own values to the public seal key is refused).
//
// No secret byte is read until every check has passed. Off without the release signing key (503).
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { endpointOperator, recoverOp, makeReplayCache, holdsLease } from "./fleet-auth.js";
import { releaseConfig, sealRelease, signResponse, keyIdOf, ed25519RawPublic } from "./secrets-release.mjs";
import { verifyPvmAppEvidence } from "./pvm-app-attest.mjs";
import { pvmOptionsRefusal } from "./pvm-market.mjs";

export const pvmSecretsMessage = (id, endpoint, ts) => `enclave-pvm-secrets:${id}:${endpoint}:${ts}`;
export const SEAL_KEY_DOMAIN = Buffer.from("enclave-pvm-seal-key-v1\n");
export const SEAL_STATEMENT = "enclave-pvm-seal-key/v1";
const MAX_PLAINTEXT = 40000;
const err = (message, status = 403) => Object.assign(new Error(message), { status });

/** The bytes the VM's transport key signs for its seal key. */
export function sealKeyMessage({ nonce, id, app, sealKey }) {
  const b = (h, n, what) => { const x = Buffer.from(String(h || ""), "hex"); if (x.length !== n) throw new Error(`${what} must be ${n} bytes`); return x; };
  return Buffer.concat([SEAL_KEY_DOMAIN, b(nonce, 32, "nonce"), b(String(id).slice(2), 32, "deployment"), b(app, 32, "app"), b(sealKey, 32, "sealKey")]);
}

/** The VM's seal statement, checked against the verified evidence's transport key; the seal key (32 bytes) or throws. */
export function checkSealStatement(seal, { nonce, id, appId, transportSpki }) {
  if (!seal || typeof seal !== "object" || Object.keys(seal).sort().join() !== "app,deployment,format,nonce,sealKey,sig") throw err("the seal statement is malformed");
  if (seal.format !== SEAL_STATEMENT || seal.deployment !== id || seal.nonce !== nonce || seal.app !== appId) throw err("the seal statement is not for this deployment, app and nonce");
  if (!/^[0-9a-f]{64}$/.test(seal.sealKey) || !/^[0-9a-f]{128}$/.test(seal.sig)) throw err("the seal statement's key or signature is malformed");
  let ok = false;
  try { ok = edVerify(null, sealKeyMessage({ nonce, id, app: appId, sealKey: seal.sealKey }), createPublicKey({ key: Buffer.from(transportSpki, "hex"), format: "der", type: "spki" }), Buffer.from(seal.sig, "hex")); }
  catch { ok = false; }
  if (!ok) throw err("the seal key is not signed by the VM's attested transport key");
  const k = Buffer.from(seal.sealKey, "hex");
  if (k.every((x) => x === 0)) throw err("the seal key is zero");
  return k;
}

/**
 * hub: the tunnel hub (info, fetchJson); market: the pVM market (eligible, expectedApp); pins: the tier's pins (codeHashes,
 * authorityHashes, runtimeIds); hostForEndpoint(epId): the live row; confirmRow(id): the ledger row, fresh.
 */
export function createPvmSecretRelease({ hub, market, pins, hostForEndpoint, confirmRow, rootPins, signingKey = () => releaseConfig().signingKey }) {
  const fresh = makeReplayCache();
  let active = 0;
  const inflight = new Set();
  return async function release(b, ctx, read) {
    const id = String(b?.id || "").toLowerCase(), endpoint = String(b?.endpoint || "").replace(/\/+$/, ""), ts = Number(b?.ts);
    if (!/^0x[0-9a-f]{64}$/.test(id) || !/^https:\/\//.test(endpoint) || !Number.isSafeInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 120)
      throw err("invalid release request", 422);
    if (!pins) throw err("the pVM tier is not configured", 503);
    const key = signingKey();
    if (!key) throw err("release signing key unavailable", 503);
    const op = await endpointOperator(ctx, endpoint), signer = await recoverOp(pvmSecretsMessage(id, endpoint, ts), b.opSig);
    if (!op || !signer || op !== signer) throw err("operator signature refused");
    if (!fresh(b.opSig, ts + 120)) throw err("release request replayed", 409);
    const epId = String(await ctx.endpointIdOf(endpoint)).toLowerCase(), row = hostForEndpoint(epId);
    if (!row || !market.eligible(row)) throw err("no admitted pVM host for this endpoint");
    if (active >= 2 || inflight.has(id)) throw err("release busy", 429);
    active++; inflight.add(id);
    try {
      const d = await confirmRow(id);
      if (!d || !holdsLease(d, epId)) throw err("this host does not hold the deployment's live lease");
      const { appId, gpuOptional } = await market.expectedApp(d);
      const why = pvmOptionsRefusal(d, { gpuOptional });
      if (why) throw err(why);
      const t = hub.info(row.name), keyFp = t && t.keyFp;
      const nonce = randomBytes(32).toString("hex");
      const doc = await hub.fetchJson(`tunnel://${row.name}`, `/v1/pvm/secret-evidence?deployment=${id}&nonce=${nonce}`);
      if (!doc || typeof doc !== "object" || doc.error) throw err(`no seal evidence from the live host${doc && doc.error ? `: ${String(doc.error).slice(0, 120)}` : ""}`, 503);
      const v = verifyPvmAppEvidence(doc.evidence, { nonce, appId, requireTls: true, allowedRuntimeIds: [...pins.runtimeIds],
        allowedCodeHashes: [...pins.codeHashes], allowedAuthorityHashes: [...pins.authorityHashes], ...(rootPins ? { rootPins } : {}) });
      if (!v.ok) throw err(`the VM's evidence is refused: ${v.reasons.at(-1)}`);
      if (createHash("sha256").update(Buffer.from(v.transportSpki, "hex")).digest("hex") !== keyFp || hub.info(row.name)?.keyFp !== keyFp)
        throw err("the evidence is not from the VM attached as this host");
      const sealKey = checkSealStatement(doc.seal, { nonce, id, appId, transportSpki: v.transportSpki });
      const current = await confirmRow(id);
      if (!current || !holdsLease(current, epId) || current.configCid !== d.configCid || current.appRef !== d.appRef) throw err("the deployment changed during release", 409);
      const { env, rev } = read(id);   // no secret bytes are read until every check above has passed
      const plaintext = Buffer.from(JSON.stringify({ id, secrets: env, issuedAt: new Date().toISOString() }));
      if (plaintext.length > MAX_PLAINTEXT) { plaintext.fill(0); throw err("the secrets exceed the release bound", 422); }
      let sealed;
      try { sealed = sealRelease({ id, ticket: Buffer.from(nonce, "hex"), sealKey, plaintext }); } finally { plaintext.fill(0); }
      const sig = signResponse(key, { id, ticket: Buffer.from(nonce, "hex"), sealKey, sealed });
      console.log(`[pvm-secrets] released ${Object.keys(env).length} secret(s) of ${id.slice(0, 10)} to ${row.name}, sealed to ${seal16(sealKey)} (app ${appId.slice(0, 12)})`);
      return { id, nonce, sealKey: sealKey.toString("hex"), sealed: sealed.toString("base64"), sig: sig.toString("base64"),
               keyId: keyIdOf(ed25519RawPublic(key)), count: Object.keys(env).length, rev };
    } finally { active--; inflight.delete(id); }
  };
}
const seal16 = (k) => k.toString("hex").slice(0, 16);
