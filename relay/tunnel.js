// relay/tunnel.js — fleet tunnel hub.
//
// Self-hosted enclaves (e.g. Enclave Metal boxes) live behind CGNAT: they have
// no public endpoint the relay can dial. So they dial OUT to the relay and hold
// a persistent WebSocket; the relay forwards their public HTTP surface (/v1/*,
// /availability, /x/*) back over it. To the rest of api-relay a tunnel enclave
// looks like any other fleet member — it shows up in readRegistry() as a synthetic
// row with a `tunnel://<name>` endpoint, and proxyTo()/pollAvailability() route
// to it through here instead of dialing.
//
// Trust: the tunnel only decides ROUTING, never trust. Clients still verify the
// enclave's attestation end-to-end (the metal RAD carries a real SEV-SNP report;
// nothing here vouches for it). Attach auth just stops a random peer from
// claiming a fleet name: the enclave presents a token whose sha256 is on a
// committed allowlist (the token itself never enters the repo), so no on-box
// secret and no secret-in-code is required.
import { WebSocketServer } from "ws";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { verifyQuote, provenSnpChip } from "./snp-verify.mjs";
import { verifyAvfEvidence } from "./avf-verify.mjs";
import { admitPvmCpu, PVM_CPU_TIER } from "./pvm-cpu-tier.mjs";
import { AVF_PAD_FORMAT, avfPadBinding } from "./avf-binding.mjs";
import { tpmNameOf, VBS_MAX_CERT_BYTES, VBS_MAX_CHAIN_CERTS, VBS_MAX_TPMT_PUBLIC_BYTES } from "./vbs-verify.mjs";
import { HVNODE_FORMAT, HVNODE_TIER, verifyHvNodeEvidence, retiredFormat } from "./hvnode-verify.mjs";
import { ekPublicFrom, makeCredential } from "./vbs-credential.mjs";
import { boxOrigin } from "./boxhost.js";
import { verifyDelegation, attachMessageV2, MAX_DELEGATIONS, MAX_DELEGATION_BYTES } from "./host-delegation.mjs";

const sha256Hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const eqHex = (a, b) => { const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex"); return x.length === y.length && timingSafeEqual(x, y); };

// A tunnel name is a routing key: it appears in `tunnel://<name>` origins and in
// the relay's /t/<name>/… path, so it must be a plain label. Anything else is
// refused at the handshake rather than silently producing an unroutable row.
const NAME_RE_OK = /^[A-Za-z0-9_-]{1,64}$/;

// A tunnel's publicUrl becomes its REGISTRY ID upstream (keccak256 of the URL),
// and a synthetic row carrying a known id DISPLACES the discovered on-chain row
// with the same id (api-relay readRegistry). Believing the claim as sent is a
// takeover primitive: any attached box could name another enclave's registered
// endpoint and have the fleet route that enclave's deployments — /x data path
// and /v1 control path, caller Authorization header included — to itself. So
// only a SELF-ROUTED url is honored: one this hub can vouch for from the attach
// name alone, which is exactly what a CGNAT seller registers on chain
// (`enclave host`, metal/HANDOFF.md).
// A colo box with its own dialable https endpoint needs no claim at all — it is
// discovered on chain directly and was never displaced.
//
// Two accepted shapes, and the check is the same in both: derive the URL from
// `name` and compare, never parse trust out of what was sent.
//   1. https://<box-zone-host>      — the box's own name (boxhost.js). Its
//      label IS the attach name, so this is a pure derivation.
//   2. https://<relay>/t/<name>     — the legacy path route, kept so a box
//      that predates the zone (or a relay with BOX_ZONE unset) still attaches.
// Form 2 names THIS relay's own public origin (tunnelOrigin, e.g. https://api.enclave.host), never any host: a row whose
// publicUrl could be https://<other-host>/t/<name> would stamp the registry id of an endpoint some other box registered
// and take that box's lease routing (enclave-bf). The hub's tunnelOrigin defaults to the production origin; api-relay passes
// its own TUNNEL_ORIGIN; a caller passing none at all to this function gets form 2 refused (fail closed).
function selfRoutedUrl(url, name, tunnelOrigin = "") {
  if (!url) return "";
  let u; try { u = new URL(String(url)); } catch { return ""; }
  if (u.protocol !== "https:" || u.search || u.hash) return "";
  const origin = boxOrigin(name);
  if (origin && u.pathname.replace(/\/+$/, "") === "" && `https://${u.host}` === origin) return origin;
  if (!tunnelOrigin || `https://${u.host}` !== String(tunnelOrigin).replace(/\/+$/, "")) return "";
  return u.pathname.replace(/\/+$/, "") === `/t/${name}` ? String(url) : "";
}
export { selfRoutedUrl };

// allow:  [{ name, tokenSha256 }]                       — bootstrap / first-party boxes
// attest: { allowedMeasurements: [hex], requireVcek, minTcb,   — permissionless sellers:
//           avf: { codeHashes: [hex], padCodeHashes: [hex], authorityHashes: [hex] },
//           pvmCpu: pvmCpuPolicy (relay/pvm-cpu-tier.mjs) - admits an AVF phone to the
//                   pVM CPU tier on ONE signed capability report per attach ({t:"caps"}) }
//   attach is granted to ANY enclave that proves, with a fresh SEV-SNP quote over
//   a relay-chosen challenge, that it runs a published Metal release (measurement
//   on the allowlist). No token, no per-seller identity. See metal/PROTOCOL.md.
//   `avf` admits a PHONE-ANCHORED host the same way: an Android protected-VM
//   attestation chain (avf-verify.mjs) whose leaf carries our challenge, is
//   rooted at Google, and names an allowlisted anchor build (codeHash) signed by
//   our APK certificate (authorityHash). Its mode is "avf", not "snp".
//   `hv-node` admits the NucBox NODE on the custom type-1 path (hvnode-verify.mjs,
//   docs/security/nucbox-custom-vm-verifier.md): the same handshake with one extra
//   round, in which the hub mints a TPM credential for the node's (EK, quoting
//   key) and the node's TPM proves it can recover it; the quote binds the node's
//   transport key, and the log must show Secure Boot on and test signing off,
//   with no dev tier. It proves a HOST-ATTESTED BOOT STATE: no TEE claim, the
//   host is not excluded, no measurement, never tenant capacity. Its mode and
//   tier are "hv-node". OFF unless the relay's RELAY_HVNODE_ATTACH is set.
//           hvNode: { ekRoots: PEM }
//   The Windows VBS-ENCLAVE attach ("windows-vbs-enclave/v1", mode "vbs") is
//   RETIRED (Steven, 2026-09-25: the custom type-1 path is the only NucBox
//   target): the format is refused at attest whatever the relay's policy says,
//   and METAL_VBS_ALLOW_TESTSIGNING no longer admits anything.
// operatorFor: async (name) -> 0x… | null                — WHO OWNS A NAME on chain.
//   A quote proves the IMAGE, and the transport key is minted PER BOOT, so
//   neither survives a reboot as an identity: while a seller was down, another
//   box running the same published release could take its name and inherit the
//   routing for keccak(https://<relay>/t/<name>) — the id its own on-chain
//   registration carries. The one thing that DOES survive is the operator key
//   that registered it, so when this resolves an owner for the name, the
//   attaching box must sign the attach challenge with that key. Names with no
//   on-chain entry stay first-come: there is nothing yet to take.
// operatorAttach: true — ATTACH BY ON-CHAIN OWNERSHIP ALONE, no quote.
//   The two paths above both assume the box can prove what it runs: a token
//   says "someone put my hash in a file", a quote says "I am a published Metal
//   release". A RELAY can do neither. It is not a TEE — deliberately, because it
//   terminates nothing and holds no keys, so there is no measurement to publish
//   and nothing a quote would add. Yet it still has an identity worth proving:
//   the operator key that registered its endpoint on chain.
//   So: the hub challenges, the box signs with that key, and the hub checks the
//   recovered signer against the registry. Nothing is hardcoded and nothing is
//   host state — adding or removing a relay is a registry transaction, which is
//   the whole point of putting the fleet on chain in the first place.
//   OFF by default. A tunnel row bypasses the dial-time operator allowlist (it
//   is authorized here instead), so turning this on lets anyone who registers
//   https://<relay>/t/<name> appear in the fleet listing under that name. That
//   is a deliberate widening and it should be a deliberate switch.
// trustedOperators / operatorsUnrestricted — the SAME fail-closed operator set
//   the dial-based discovery applies, enforced here because a tunnel row does
//   NOT go through it. Without this the operator path would be the least gated
//   of the three: the registry is permissionless, so anyone could register
//   https://<relay>/t/<name>, sign for it, and appear in the fleet listing —
//   and a row that claims capacity lands in the set that sizes the fleet and
//   takes placement. A token needs a committed hash and a quote needs an
//   allowlisted measurement; proving a name from chain has to clear a bar too.
// The AVF builds that may receive dealt pads: attest.avf.padCodeHashes, lowercased. A
// pVM CPU build (attest.pvmCpu.codeHashes) is deliberately NOT in this set unless it
// is also listed there, so the tier routes but never provisions pads.
const padBuildsOf = (attest) => new Set((Array.isArray(attest?.avf?.padCodeHashes) ? attest.avf.padCodeHashes : []).map((h) => String(h).toLowerCase()));

// The chip set a (re)attach leaves: an in-place re-attach under the SAME transport key while the previous record is still
// registered adds its chip to the set; anything else starts over. The set lives only as long as that continuous attachment
// (a detach deletes the record), and SNP boxes attaching here mint their transport key per boot inside the CVM, so a set
// never outlives the boot that proved it (enclave-d1's lifetime condition).
export function snpChipsAfter(prev, meta = {}) {
  const keep = prev && prev.keyFp && prev.keyFp === (meta.keyFp || "") ? prev.snpChips || [] : [];
  return [...new Set([...keep, ...(meta.snpChip ? [meta.snpChip] : [])])];
}

// HOW a tunnel proved its name, as published on its row: "token" only for an allowlisted token, "operator" only for the
// name's on-chain operator key, and "attestation" for EVERYTHING else (a hardware verdict, or a bind that said nothing).
// Only the two trusted identities may speak for a relay (api-relay.js relayRowOf); anything unknown falls to the untrusted
// value, never the trusted one (enclave-bf).
export function attachKindOf(via) {
  return via === "token" ? "token" : via === "operator" ? "operator" : "attestation";
}
// An owner-only hv-node row's served owners, EACH WITH ITS EXPIRY (enclave-bf E2, enclave-87): the operator (no expiry: it is
// the name's on-chain owner, re-read every minute) + each owner whose hosting delegation verifies now (its own expiry, the
// latest if one owner signed several). Every serve decision checks `expires` at decision time (servesNow in api-relay.js),
// so a delegation that lapses while the tunnel stays attached stops serving then, not at the next re-attach.
export async function servedList(delegations, ctx) {
  const byOwner = new Map(), refused = [];
  const op = String(ctx && ctx.operator || "").toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(op)) byOwner.set(op, null);
  const list = Array.isArray(delegations) ? delegations.slice(0, MAX_DELEGATIONS) : [];
  if (Array.isArray(delegations) && delegations.length > MAX_DELEGATIONS) refused.push({ index: MAX_DELEGATIONS, reason: `more than ${MAX_DELEGATIONS} delegations; the rest ignored` });
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || typeof d.message !== "string" || typeof d.signature !== "string" || d.message.length > MAX_DELEGATION_BYTES || d.signature.length > MAX_DELEGATION_BYTES) {
      refused.push({ index: i, reason: "not a { message, signature } pair within size" }); continue;
    }
    const v = await verifyDelegation(d, ctx);
    if (!v.ok) { refused.push({ index: i, reason: v.reason }); continue; }
    if (byOwner.has(v.owner) && (byOwner.get(v.owner) === null || byOwner.get(v.owner) >= v.expires)) continue;
    byOwner.set(v.owner, v.expires);
  }
  return { served: [...byOwner].map(([owner, expires]) => ({ owner, expires })).sort((a, b) => (a.owner < b.owner ? -1 : 1)), refused };
}
export function createTunnelHub({ allow = [], attest = null, reqTimeoutMs = 30000, onChange = () => {},
                                  operatorFor = null, operatorAttach = false,
                                  trustedOperators = [], operatorsUnrestricted = false,
                                  // this relay's public origin (selfRoutedUrl form 2) and, for an hv-node's owner-only
                                  // serving, what a hosting delegation must name: { chainId, registry: () => address }
                                  tunnelOrigin = "https://api.enclave.host", ownerOnly = null,
                                  // RELAY_HVNODE_OPERATORS (enclave-87): the on-chain operators whose v2-signed hv-node attach may
                                  // serve OWNER-ONLY. Read in exactly one place (the hv-node attest path below); it grants nothing
                                  // else: not dial discovery, not the operator attach path, not the relay roster. Empty = every
                                  // hv-node attaches host-only. trustedOperators / "*" never imply it, and it never implies them.
                                  hvNodeOperators = [] } = {}) {
  const trusted = new Set(trustedOperators.map((a) => String(a).toLowerCase()));
  const hvOps = new Set((Array.isArray(hvNodeOperators) ? hvNodeOperators : []).map((a) => String(a).toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  const allowByName = new Map(allow.filter((a) => a && a.name && a.tokenSha256).map((a) => [a.name, a.tokenSha256.toLowerCase()]));
  // the NucBox node's attach (mode hv-node): only with the pinned TPM EK roots. A legacy `vbs` policy enables nothing.
  const hvOn = !!(attest && attest.hvNode && attest.hvNode.ekRoots);
  const attestOn = !!(attest && ((attest.allowedMeasurements && attest.allowedMeasurements.length)
                               || (attest.avf && attest.avf.codeHashes && attest.avf.codeHashes.length)
                               || hvOn));
  const wss = new WebSocketServer({ noServer: true });
  const tunnels = new Map();                                  // name -> { ws, pending, lastSeen, mode, publicUrl, keyFp }

  // Keepalive. Nothing else proves a tunnel is alive: a half-open socket (NAT
  // timeout, a box that vanished without a FIN) never fires 'close', so its
  // entry would keep answering discovery, swallow every request into the 30s
  // timeout, and — since a name can no longer simply be seized (see
  // handleUpgrade) — lock the real box out of its own name on reconnect. The
  // agent answers {t:"ping"} with a pong; ANY frame refreshes lastSeen.
  const PING_MS = 30_000, DEAD_MS = 90_000;
  setInterval(() => {
    const now = Date.now();
    for (const [name, t] of [...tunnels]) {
      if (now - t.lastSeen > DEAD_MS) {
        console.error(`[tunnel] ${name} silent for ${Math.round((now - t.lastSeen) / 1000)}s — terminating`);
        try { t.ws.terminate(); } catch {}
        if (tunnels.get(name) === t) { tunnels.delete(name); try { onChange("detach", name); } catch {} }
        continue;
      }
      try { t.ws.send(JSON.stringify({ t: "ping" })); } catch {}
    }
  }, PING_MS).unref?.();

  // Owner-only serving is re-proved as it ages (enclave-bf): the name's on-chain owner is re-read and every delegation
  // re-verified once a minute. A changed or vanished owner clears the operator (the row serves nothing until it re-attaches
  // under the new owner's signature); an expired delegation drops its owner. A change re-announces the row.
  const OWNER_RECHECK_MS = 60_000;
  async function recheckOwnerOnly() {
    for (const [name, t] of [...tunnels]) {
      if (t.mode !== "hv-node" || !t.operator) continue;
      let owner = null; try { owner = await ownerOf(name); } catch { owner = null; }
      let served = [];
      if (owner === t.operator && hvOps.has(owner))
        served = (await servedList(t.delegations, { operator: t.operator, box: name, chain: ownerOnly && ownerOnly.chainId,
                                                    registry: ownerOnly && typeof ownerOnly.registry === "function" ? ownerOnly.registry() : "" })).served;
      if (tunnels.get(name) !== t) continue;
      if (!served.length) {
        console.error(`[tunnel] ${name} owner-only serving ENDED: the name's owner is now ${owner || "(none)"} (was ${t.operator})${owner === t.operator ? "; not in RELAY_HVNODE_OPERATORS" : ""}`);
        t.operator = ""; t.served = []; t.delegations = [];
        try { onChange("owner", name); } catch {}
      } else if (JSON.stringify(served) !== JSON.stringify(t.served)) {
        console.log(`[tunnel] ${name} served owners now ${served.map((e) => e.owner + (e.expires ? `(until ${e.expires})` : "")).join(", ")}`);
        t.served = served;
        try { onChange("owner", name); } catch {}
      }
    }
  }
  setInterval(() => { recheckOwnerOnly().catch((e) => console.error(`[tunnel] owner re-check failed: ${e.message}`)); }, OWNER_RECHECK_MS).unref?.();

  function tokenOk(name, token) {
    const want = allowByName.get(name);
    if (!want || !token) return false;
    return eqHex(sha256Hex(token), want);
  }

  // ---- name ownership (attest path) -----------------------------------------
  // The message an attaching box signs with its REGISTRY OPERATOR key. Bound to
  // the name and to this attach's fresh nonce, and EIP-191-prefixed by
  // personal_sign — so a signature harvested here can never be replayed as a
  // transaction, which matters because that key also sends claim/renew.
  const attachMessage = (name, nonce) => `enclave-tunnel-attach:${name}:${nonce.toString("base64")}`;
  // Last known owner per name. A lookup that FAILS (an RPC blip) must not open a
  // name we have already seen registered — cached ownership is what we fall back
  // to. A name never seen registered stays first-come, which is the same answer
  // as before this existed.
  const ownerCache = new Map();
  async function ownerOf(name) {
    if (!operatorFor) return null;
    try {
      const a = await operatorFor(name);
      if (a) ownerCache.set(name, String(a).toLowerCase());
      else ownerCache.delete(name);
      return a ? String(a).toLowerCase() : null;
    } catch {
      return ownerCache.get(name) || null;      // fail closed against a known owner
    }
  }
  async function signerOf(message, sig) {
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
    try {
      const { recoverMessageAddress } = await import("viem");
      return (await recoverMessageAddress({ message, signature: sig })).toLowerCase();
    } catch { return null; }
  }

  // Register an authorized socket as the tunnel for `name` and wire its frames.
  function bind(name, ws, meta = {}) {
    // A socket that died while its attestation was being verified must never be
    // registered: no further 'close' can fire on it, so the entry (and the name
    // with it) would be held forever by a tunnel that answers nothing.
    if (ws.readyState !== ws.OPEN) { try { ws.terminate(); } catch {} return false; }
    const prev = tunnels.get(name);
    if (prev && prev.ws !== ws) { try { prev.ws.terminate(); } catch {} }   // newest wins
    const t = { ws, pending: new Map(), streams: new Map(), lastSeen: Date.now(), mode: meta.mode || "", publicUrl: "",
                // HOW this box proved its name: "token" (an allowlisted token hash), "operator" (the name's on-chain
                // operator key), or "attestation(...)" (a hardware verdict alone). Only the hub sets it.
                via: meta.via || "",   // fail closed: a bind that says nothing is NOT a trusted identity (enclave-bf)
                measurement: meta.measurement || null, keyFp: meta.keyFp || "",
                // mode "hv-node": "hv-node" (a host-attested boot state; never a TEE tier);
                // mode "avf": "pvm-cpu" once, and only once, a capability report is admitted (below)
                tier: meta.tier || "",
                // an AVF attach keeps what the pVM CPU admission needs: the verified verdict, the
                // attested transport key, this attach's nonce, and the relay's policy. Nothing the
                // box sends later can change any of these.
                pvm: meta.pvm || null,
                // dealt pads (relay/pads.mjs): the attested transport SPKI signs
                // ledger requests, the X25519 pad key receives the pVM's seed
                spki: meta.spki || "", padKey: meta.padKey || "",
                // mode "hv-node": the boot this attach proved (boot counter, the IDKS a same-boot VM report must
                // verify under, PCRs, EK and AK), its omissions, and the node's own statement (recorded, never read)
                hvNode: meta.hvNode || null,
                // mode "hv-node", owner-only serving (enclave-87's (B)): the name's on-chain operator, set ONLY when it signed
                // the v2 attach message (this transport key, this EK) and is a trusted operator of this relay; the owners it
                // may serve (the operator + each VALID delegation's owner); and the raw delegations, re-verified as they age.
                operator: meta.operator || "", served: meta.served || [], delegations: meta.delegations || [],
                // mode "snp": every CHIP_ID a VCEK-verified attach under THIS transport key has proved (an in-place
                // re-attach adds to the set, so a multi-socket box's other chip is not a false refusal; a new key starts
                // over). Internal: never in origins() rows or /enclaves.
                snpChips: snpChipsAfter(prev, meta) };
    tunnels.set(name, t);
    console.log(`[tunnel] ${name} attached via ${meta.via || "token"} (${tunnels.size} enclave${tunnels.size === 1 ? "" : "s"})`);
    try { onChange("attach", name); } catch {}   // refresh discovery so it lands in `live` now, not on the next slow poll
    ws.on("message", (data) => {
      t.lastSeen = Date.now();
      let f; try { f = JSON.parse(data); } catch { return; }
      if (f.t === "hello") {
        const had = t.publicUrl;
        // The MODE is the hub's verdict from attach (bind: "snp" / "avf" / "vbs" after a verified
        // quote or chain, "" for a token or operator attach) and only the hub may set it. A box
        // used to be able to promote itself here - `t.mode = f.mode || t.mode` - so a token-attached
        // metal box saying `mode:"snp"` in its hello read, downstream, as "the relay verified a fresh
        // SEV-SNP quote" (site/js/core/pricing.js teeCpuOf, source "relay") and became eligible for
        // tenant work on its own word. Eligibility is derived from verified evidence, never from a
        // self-reported string, so the hello's mode is recorded as what it is: a declaration.
        t.declaredMode = f.mode || ""; t.transportKeyFp = f.transportKeyFp || "";
        t.publicUrl = selfRoutedUrl(f.publicUrl, name, tunnelOrigin);
        if (f.publicUrl && !t.publicUrl)
          console.error(`[tunnel] ${name} claimed publicUrl ${String(f.publicUrl).slice(0, 120)} — IGNORED (not this tunnel's own https://<relay>/t/${name} route); its on-chain runner id stays unstamped`);
        // The attach-time onChange snapshots the registry BEFORE this frame can
        // arrive, so a selling box's registered id (keccak of its publicUrl)
        // stays unknown until the next slow poll — its hosted rows read
        // "claimed"/unnamed for minutes after every relay restart. Re-announce
        // the moment the identity lands.
        if (t.publicUrl !== had) { try { onChange("hello", name); } catch {} }
        return;
      }
      // pVM CPU tier (relay/pvm-cpu-tier.mjs, shielded/anchor/avf/PVM-CPU.md): ONE capability
      // report per attach, from an AVF-attached phone only. The report is signed by the VM's
      // attested transport key over this attach's nonce and judged against the relay's policy; the
      // tier is set by THIS hub when the verdict is eligible, never from a field the phone sends.
      // Refusals log their reasons here and reach the phone in its caps-result; the public row
      // carries only that a report was refused, never the measured figures inside it.
      if (f.t === "caps") {
        if (!t.pvm || t.capsSeen) return;               // not an AVF attach, or the one frame was already judged
        t.capsSeen = true;
        const rep = typeof f.report === "string" && f.report.length <= 8192 ? Buffer.from(f.report, "base64") : Buffer.alloc(0);
        const verdict = admitPvmCpu({ attach: { ...t.pvm.verdict, transportSpki: t.pvm.spki }, reportBytes: rep,
                                      signature: String(f.sig || ""), nonce: t.pvm.nonce }, t.pvm.policy, { now: Date.now() });
        if (verdict.eligible) {
          t.tier = PVM_CPU_TIER;
          t.pvmCpu = { model: verdict.capability.model ? verdict.capability.model.name : null, ctx: verdict.capability.model ? verdict.capability.model.ctx : null,
                       device: verdict.capability.device || "", checkedAt: verdict.capability.checkedAt };
          console.log(`[tunnel] ${name} pvm-cpu ADMITTED (${t.pvmCpu.model || "model?"})`);
          try { onChange("caps", name); } catch {}
        } else {
          t.capsRefused = true;
          console.log(`[tunnel] ${name} pvm-cpu REFUSED: ${verdict.reasons.join("; ")}`);
        }
        try { ws.send(JSON.stringify({ t: "caps-result", ok: verdict.eligible, tier: verdict.tier, reasons: verdict.reasons })); } catch {}
        return;
      }
      if (f.t === "pong") return;
      if (f.t === "res" && f.id != null) { const p = t.pending.get(f.id); if (p) { t.pending.delete(f.id); p.resolve(f); } return; }
      // raw-stream frames (Phase D): s= open-ack · sd data · sx close
      if ((f.t === "s=" || f.t === "sd" || f.t === "sx") && f.sid != null) {
        const s = t.streams.get(f.sid); if (s) s(f);
      }
    });
    const bye = () => { if (tunnels.get(name) === t) tunnels.delete(name); for (const p of t.pending.values()) p.reject(new Error("tunnel closed")); for (const s of [...t.streams.values()]) s({ t: "sx" }); t.streams.clear(); console.log(`[tunnel] ${name} detached`); try { onChange("detach", name); } catch {} };
    ws.on("close", bye);
    ws.on("error", () => { try { ws.terminate(); } catch {} });
    return true;
  }

  function handleUpgrade(req, socket, head) {
    const name = String(req.headers["x-metal-name"] || "").slice(0, 64);
    const token = String(req.headers["x-metal-token"] || "");
    const wantsAttest = req.headers["x-metal-attest"] === "1" || (!token && attestOn);
    if (!NAME_RE_OK.test(name)) { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return socket.destroy(); }

    // Token path (bootstrap / first-party): authorize before the handshake.
    if (tokenOk(name, token)) return wss.handleUpgrade(req, socket, head, (ws) => bind(name, ws, { via: "token" }));

    // Operator path: prove the NAME from the chain, with no quote at all. For a
    // relay this is the only identity that exists — it runs no measured image —
    // and it is a stronger one than a token, because it is the same key that
    // registered the endpoint and it can be rotated on chain without touching
    // this repo or any box's env.
    const wantsOperator = req.headers["x-metal-attach"] === "operator";
    if (wantsOperator) {
      if (!operatorAttach || !operatorFor) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      // Same reservation the attest path enforces, same reason: a name someone
      // put on the token allowlist is claimed, and must not be takeable by
      // whoever gets to the registry first.
      if (allowByName.has(name)) {
        console.log(`[tunnel] ${name} operator-attach REFUSED: the name is reserved for token attach`);
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const nonce = randomBytes(32);
        let settled = false, checking = false;
        const deny = (why) => {
          if (settled) return; settled = true;
          console.log(`[tunnel] ${name} operator-attach REJECTED: ${why}`);
          try { ws.send(JSON.stringify({ t: "attest-result", ok: false, reason: why })); } catch {}
          setTimeout(() => { try { ws.close(); } catch {} }, 100);
        };
        const timer = setTimeout(() => deny("attach timeout"), 15000);
        timer.unref?.();
        ws.on("message", async (data) => {
          if (settled || checking) return;
          let f; try { f = JSON.parse(data); } catch { return; }
          if (f.t !== "attach" || !f.operatorSig) return;
          checking = true;
          try {
            const owner = await ownerOf(name);
            if (settled) return;
            // No on-chain entry = nothing to prove against. Unlike the attest
            // path (where an unregistered name stays first-come because the
            // QUOTE still proved something), a signature over an unowned name
            // proves only that the peer holds some key. Refuse, and say so.
            if (!owner) return deny(`${name} has no active on-chain registration `
                                  + `(the registry entry for this relay's /t/${name} endpoint) — register it first, then attach`);
            const signer = await signerOf(attachMessage(name, nonce), f.operatorSig);
            if (settled) return;
            if (!signer) return deny("operatorSig is not a valid personal_sign of "
                                   + "\"enclave-tunnel-attach:<name>:<nonce b64>\"");
            if (signer !== owner) return deny(`${name} is registered on chain to ${owner}, not ${signer}`);
            // Proving the name is not the same as being welcome on this relay.
            // Registration is permissionless, so ownership alone would let any
            // stranger into the fleet listing — the same reason the dial path
            // filters on this set, applied here because a tunnel row skips it.
            if (!operatorsUnrestricted && !trusted.has(owner))
              return deny(`${owner} owns ${name} on chain but is not a trusted operator of this relay`);
            // A live holder is only displaceable by the same on-chain owner —
            // which this signature just proved. Two boxes sharing one operator
            // key is the operator's own business; a stranger cannot get here.
            clearTimeout(timer); settled = true;
            try { ws.send(JSON.stringify({ t: "attest-result", ok: true })); } catch {}
            bind(name, ws, { via: "operator" });
          } catch (e) { deny(`attach error: ${e.message}`); }
          finally { checking = false; }
        });
        ws.on("error", () => { try { ws.terminate(); } catch {} });
        try { ws.send(JSON.stringify({ t: "challenge", nonce: nonce.toString("base64") })); } catch {}
      });
    }

    // Attestation path (permissionless): complete the handshake unauthorized, run
    // a challenge → quote → verify exchange, and only then bind (or close).
    //
    // A quote proves the peer runs a PUBLISHED Metal release. It proves nothing
    // about WHICH box it is — every seller runs the same image, so the name in
    // the handshake header is a request, not an identity. Two rules keep it from
    // becoming one: names on the token allowlist are reserved outright, and a
    // name already held by a live tunnel can only be re-taken by the same
    // attested transport key (a genuine reconnect). Without them any seller
    // could evict metal0 (or a competitor) and inherit its routing.
    if (wantsAttest && attestOn) {
      if (allowByName.has(name)) {
        console.log(`[tunnel] ${name} attest REFUSED: the name is reserved for token attach`);
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const nonce = randomBytes(32);
        let settled = false, verifying = false;
        // VBS state for THIS attach (EVIDENCE.md steps 3-4): the keys the node
        // presented and the credential minted for them. The 15 s timer above
        // covers both rounds; the credential is compared on `attest`.
        let vbs = null;
        const b64 = (v, cap) => { if (typeof v !== "string" || !v.length || v.length > 4 * Math.ceil(cap / 3) + 4) return null; const b = Buffer.from(v, "base64"); return b.length && b.length <= cap ? b : null; };
        const deny = (why) => { if (settled) return; settled = true; console.log(`[tunnel] ${name} attest REJECTED: ${why}`); try { ws.send(JSON.stringify({ t: "attest-result", ok: false, reason: why })); } catch {} setTimeout(() => { try { ws.close(); } catch {} }, 100); };
        const timer = setTimeout(() => deny("attestation timeout"), 15000);
        timer.unref?.();                                     // a stalled attach must not hold the loop open
        ws.on("message", async (data) => {
          if (settled || verifying) return;                    // one quote in flight at a time
          let f; try { f = JSON.parse(data); } catch { return; }
          // Windows VBS node: the credential round. The hub mints a TPM credential
          // for the (EK, quoting-key name) presented (vbs-credential.mjs); only a
          // TPM holding that EK's private key AND that quoting key can recover it,
          // which is what ties the quote (and so the log, and so the enclave
          // report) to the hardware whose EK certificate is checked at `attest`.
          if (f.t === "vbs-keys") {
            if (!hvOn) return deny("hv-node attach is not enabled on this relay (the VBS-enclave attach is retired)");
            if (vbs) return deny("duplicate vbs-keys");
            verifying = true;
            try {
              const ekCert = b64(f.ek, VBS_MAX_CERT_BYTES), aikPub = b64(f.aikPub, VBS_MAX_TPMT_PUBLIC_BYTES), aikName = b64(f.aikName, 34);
              if (!ekCert || !aikPub || !aikName) return deny("vbs-keys needs ek, aikPub and aikName (bounded base64)");
              const ekChain = Array.isArray(f.ekChain) ? f.ekChain : [];
              if (ekChain.length > VBS_MAX_CHAIN_CERTS || !ekChain.every((c) => b64(c, VBS_MAX_CERT_BYTES))) return deny("vbs-keys ekChain malformed");
              const wantName = tpmNameOf(aikPub);
              if (!wantName.equals(aikName)) return deny("vbs-keys aikName is not 0x000B || sha256(aikPub)");
              const credential = randomBytes(32);
              const { credentialBlob, secret } = makeCredential(ekPublicFrom(ekCert), wantName, credential);
              vbs = { ekCert, aikName: wantName, credential };
              try { ws.send(JSON.stringify({ t: "vbs-credential", credentialBlob: credentialBlob.toString("base64"), secret: secret.toString("base64") })); } catch {}
            } catch (e) { deny(`vbs-keys: ${e.message}`); }
            finally { verifying = false; }
            return;
          }
          if (f.t !== "attest" || !f.rad || !f.rad.body) return;
          verifying = true;
          try {
            // a RETIRED format is refused by name before anything else, whatever this relay's policy holds
            const retired = retiredFormat(f.rad.format);
            if (retired) return deny(retired);
            const spki = f.rad.transportKey ? Buffer.from(f.rad.transportKey, "base64") : null;
            const isAvf = f.rad.format === "android-avf-pvm/v1" || f.rad.format === AVF_PAD_FORMAT;
            const avfV2 = f.rad.format === AVF_PAD_FORMAT;
            const isHv = f.rad.format === HVNODE_FORMAT;
            // Validate the versioned transcript even in explicitly enabled
            // development mode. Production checks its certificate/signature.
            const avfBound = avfV2 ? avfPadBinding(spki, f.rad.padKey, nonce) : null;
            let res;
            // the SEV-SNP CHIP_ID this attach PROVED (secrets-release.mjs binds a per-app guest's release to its lease
            // holder's chip): kept only from a VCEK-verified, VCEK-signed report with a non-zero CHIP_ID -- a
            // measurement-only attach never had its signature checked against the chip, so its CHIP_ID proves nothing
            let snpChip = null;
            // DEVELOPMENT ONLY, double-gated (the hub's option AND the process
            // env): a phone whose VM cannot attest yet (vendor level below the
            // RKP admission) binds on its transport key alone so the rest of
            // the loop (pads, engine) can be driven. Never set in production.
            const devUnattested = !!(attest && attest.devUnattested && process.env.ENCLAVE_DEV_UNATTESTED === "1");
            if (isAvf && devUnattested && spki) {
              console.log(`[tunnel] ${name}: DEV attach without attestation (ENCLAVE_DEV_UNATTESTED)`);
              res = { ok: true, reasons: [], measurement: "dev-unattested", vcekVerified: false };
            } else if (isAvf) {
              // The certificate challenge and attested-key signature cover
              // the same versioned transcript. V2 includes the pad recipient.
              // V1 can route but cannot provision dealt pads (see below).
              // Earlier measured payloads signed arbitrary app-supplied
              // transcripts. A v2 label alone cannot fix that oracle: only
              // explicitly admitted builds with own-key checks may get pads.
              // The pVM CPU build (relay/pvm-cpu-tier.mjs) always attaches with the v2
              // transcript, because its VM mints a pad key and the v2 binding covers both
              // keys. It is admitted on ITS code hashes for ROUTING ONLY: the tier must never
              // receive dealt pads, so a pvm-cpu code hash that is not also a pad build keeps
              // no pad key (below), exactly as a v1 attach routes without pad eligibility.
              const padBuilds = Array.isArray(attest.avf?.padCodeHashes) ? attest.avf.padCodeHashes.map((h) => String(h).toLowerCase()) : [];
              const pvmCpuBuilds = attest.pvmCpu && attest.pvmCpu.codeHashes ? [...attest.pvmCpu.codeHashes] : [];
              const codeHashes = avfV2 ? [...new Set([...padBuilds, ...pvmCpuBuilds])] : attest.avf?.codeHashes;
              if (!Array.isArray(codeHashes) || !codeHashes.length)
                return deny(avfV2 ? "AVF v2 pad attach is not enabled on this relay" : "AVF attach is not enabled on this relay");
              if (!spki) return deny("AVF attach must carry transportKey");
              let ev; try { ev = JSON.parse(Buffer.from(f.rad.body, "base64").toString("utf8")); } catch { return deny("AVF body is not JSON"); }
              if (!ev || !Array.isArray(ev.chain) || !ev.signature) return deny("AVF body needs chain[] and the attested key's signature over the binding transcript");
              const bound = avfBound || Buffer.concat([spki, nonce]);
              res = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: createHash("sha256").update(bound).digest(),
                                        signature: Buffer.from(ev.signature, "base64"), signedMessage: bound },
                                      { allowedCodeHashes: codeHashes, allowedAuthorityHashes: attest.avf.authorityHashes || [],
                                        ...(attest.avf.rootPins ? { rootPins: attest.avf.rootPins } : {}) });
            } else if (isHv) {
              // The NucBox node: the body carries the log, the quote, the EK, the activated credential, the
              // node's statement and the transport key's signature over the transcript; the hub rebuilds the
              // transcript from ITS nonce and checks the credential it minted in the vbs-keys round.
              if (!hvOn) return deny("hv-node attach is not enabled on this relay");
              if (!vbs) return deny("hv-node attest without the vbs-keys round");
              if (!spki) return deny("hv-node attach must carry transportKey");
              if (typeof f.rad.body !== "string" || f.rad.body.length > 12 * 1024 * 1024) return deny("hv-node body exceeds size limit");
              let ev; try { ev = JSON.parse(Buffer.from(f.rad.body, "base64").toString("utf8")); } catch { return deny("hv-node body is not JSON"); }
              res = verifyHvNodeEvidence({ evidence: ev, nonce, transportKeySpki: spki, expectedCredential: vbs.credential,
                                           mintedFor: { ekCert: vbs.ekCert, aikName: vbs.aikName } }, attest.hvNode);
              if (!res.ok || !res.admissible) return deny(res.reasons.join("; ") || "hv-node evidence invalid");
            } else {
              if (!/sev-snp-guest/.test(f.rad.format || "")) return deny(`format ${f.rad.format} not SEV-SNP, AVF or hv-node`);
              const report = Buffer.from(f.rad.body, "base64");
              const aux = f.rad.certs ? Buffer.from(f.rad.certs, "base64") : null;
              res = await verifyQuote(report, { challenge: nonce, transportKeySpki: spki, auxblob: aux,
                allowedMeasurements: attest.allowedMeasurements || [], requireVcek: !!attest.requireVcek,
                ...("minTcb" in attest ? { minTcb: attest.minTcb } : {}) });   // absent: TCB unjudged, as before
              snpChip = provenSnpChip(report, res);
            }
            // verification is a network round trip (KDS): the timeout may have
            // denied and closed this socket while we waited. Binding it now
            // would register a dead ws whose 'close' has already fired — the
            // name would be held by a tunnel that answers nothing, forever.
            if (settled) return;
            if (!res.ok) return deny(res.reasons[res.reasons.length - 1] || "quote invalid");
            // WHOSE NAME IS THIS? A quote proves the image, not the box, so a
            // name that is REGISTERED ON CHAIN belongs to whoever registered it
            // — and only that operator's key can take it, whether the real box
            // is up, rebooting, or gone. Without this, a seller's downtime was
            // an opening: same image, same name, and the routing for its
            // registered id follows.
            const owner = await ownerOf(name);
            const keyFp = spki ? createHash("sha256").update(spki).digest("hex") : "";
            let operator = "", served = { served: [], refused: [] }, delegations = [];
            if (owner) {
              const signer = await signerOf(attachMessage(name, nonce), f.operatorSig);
              // hv-node: the v2 message binds the operator's consent to THIS transport key on THIS TPM (enclave-bf)
              const signer2 = isHv && vbs ? await signerOf(attachMessageV2(name, nonce.toString("base64"), keyFp,
                                                     createHash("sha256").update(vbs.ekCert).digest("hex")), f.operatorSig) : null;
              if (settled) return;                       // the timeout may have fired while we recovered
              if (!signer && !signer2)
                return deny(`${name} is registered on chain; attach must carry operatorSig `
                          + `(personal_sign of "enclave-tunnel-attach:<name>:<nonce b64>") — upgrade the agent`);
              if (signer !== owner && signer2 !== owner)
                return deny(`${name} is registered on chain to ${owner}, not ${signer2 || signer}`);
              // OWNER-ONLY SERVING (hv-node only): the operator is recorded only on a v2 signature by the name's owner, who
              // must be in RELAY_HVNODE_OPERATORS (hvOps; never TRUSTED_OPERATORS, which grants dialing and relay roles);
              // the served owners are it + each valid delegation's owner, with expiries. A v1 signature attaches the node
              // HOST-ONLY (serves nothing), which is how an old node stays safe.
              if (isHv && signer2 === owner && hvOps.has(owner)) {
                operator = owner;
                delegations = Array.isArray(f.rad.delegations) ? f.rad.delegations.slice(0, MAX_DELEGATIONS) : [];
                served = await servedList(delegations, { operator, box: name, chain: ownerOnly && ownerOnly.chainId,
                                                         registry: ownerOnly && typeof ownerOnly.registry === "function" ? ownerOnly.registry() : "" });
                if (settled) return;
                for (const r of served.refused) console.error(`[tunnel] ${name} hosting delegation #${r.index} NOT honoured: ${r.reason}`);
              } else if (isHv) {
                console.log(`[tunnel] ${name} hv-node attached HOST-ONLY (serves nothing): ${signer2 === owner ? `operator ${owner} is not in RELAY_HVNODE_OPERATORS` : "no v2 operator signature (enclave-tunnel-attach/2)"}`);
              }
            }
            const prev = tunnels.get(name);
            if (prev && (!prev.keyFp || prev.keyFp !== keyFp))
              return deny("that name is held by another enclave");
            clearTimeout(timer); settled = true;
            try { ws.send(JSON.stringify({ t: "attest-result", ok: true, measurement: res.measurement, ...(isHv ? { tier: HVNODE_TIER, hostExcluded: false } : {}) })); } catch {}
            // A v1 padKey was outside the attested message. Never retain it
            // for seed issuance or for the dealer's consumer enumeration.
            // ...and a v2 attach keeps its pad key only when the build is an admitted PAD build:
            // a pVM CPU build routed through on its own code hash is never a pad consumer.
            // an hv-node attach is a host, never a pad consumer
            const padEligible = !isHv && (!isAvf || (avfV2 && padBuildsOf(attest).has(String(res.component?.codeHash || res.measurement || "").toLowerCase())));
            const padKey = padEligible && /^[0-9a-f]{64}$/.test(String(f.rad.padKey || "")) ? f.rad.padKey : "";
            bind(name, ws, { via: isHv ? "attestation(hv-node)" : isAvf ? "attestation(avf)" : res.vcekVerified ? "attestation" : "attestation(measurement-only)",
                             measurement: res.measurement, mode: isHv ? "hv-node" : isAvf ? "avf" : "snp", keyFp, tier: isHv ? HVNODE_TIER : "",
                             snpChip,
                             hvNode: isHv ? { boot: res.boot, omissions: res.omissions, hostStatement: res.hostStatement, verifiedAt: new Date().toISOString() } : null,
                             ...(operator ? { operator, served: served.served, delegations } : {}),
                             spki: spki ? spki.toString("base64") : "", padKey,
                             // the pVM CPU admission inputs, pinned at attach (policy included: a hub
                             // without one refuses every report, by the verifier's own first rule)
                             pvm: isAvf ? { verdict: res, spki, nonce, policy: (attest && attest.pvmCpu) || null } : null });
          } catch (e) { deny(`verify error: ${e.message}`); }
          finally { verifying = false; }
        });
        ws.on("error", () => { try { ws.terminate(); } catch {} });
        // sigVersions: the operator signatures this relay verifies (1: enclave-tunnel-attach, 2: enclave-tunnel-attach/2 over
        // the transport key and the EK); an hv-node signs v2 and sends its hosting delegations only when 2 is offered
        try { ws.send(JSON.stringify({ t: "challenge", nonce: nonce.toString("base64"), sigVersions: [1, 2] })); } catch {}
      });
    }

    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  // ---- raw streams over the control ws (Phase D) -----------------------------
  // A WebSocket UPGRADE can't ride the buffered req/res frames, so it gets a
  // spliced byte stream instead: the hub asks the agent to open a TCP
  // connection to the guest supervisor ({t:"s+"}), replays the client's
  // upgrade request head into it, and from then on both directions are opaque
  // {t:"sd"} chunks. The supervisor completes the handshake itself (101 flows
  // back through the splice), so the in-enclave /x/<id>/tls and /https bridges
  // — TLS terminating INSIDE the CVM — work unchanged behind a tunnel: this is
  // what makes a CGNAT seller box publicly serve its apps. The hub never
  // parses the spliced bytes; on the app-TLS path they are ciphertext
  // end-to-end. Bounded: per-tunnel stream cap, open timeout, idle timeout,
  // and a bufferedAmount guard so one slow reader can't balloon hub memory.
  const MAX_STREAMS = 128, STREAM_OPEN_MS = 10_000, STREAM_IDLE_MS = 15 * 60_000, MAX_WS_BUFFER = 16 * 1024 * 1024;
  function spliceUpgrade(origin, req, socket, head, path) {
    const name = (String(origin).match(NAME_RE) || [])[1];
    const t = tunnels.get(name);
    const refuse = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
    if (!t) return refuse(502, "Bad Gateway");
    if (t.streams.size >= MAX_STREAMS) return refuse(503, "Service Unavailable");
    const sid = seq++;
    const sendF = (o) => { try { t.ws.send(JSON.stringify(o)); return true; } catch { return false; } };
    let open = false, idleTimer = null;
    const openTimer = setTimeout(() => finish("stream open timeout"), STREAM_OPEN_MS);
    const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish("idle"), STREAM_IDLE_MS); };
    function finish(why) {
      clearTimeout(openTimer); clearTimeout(idleTimer);
      if (t.streams.delete(sid)) sendF({ t: "sx", sid });
      if (!open && why !== "closed") refuse(502, "Bad Gateway"); else socket.destroy();
    }
    t.streams.set(sid, (f) => {
      idle();
      if (f.t === "s=" && !open) {
        if (!f.ok) return finish(f.err || "open refused");
        clearTimeout(openTimer); open = true;
        // replay the client's upgrade request into the guest supervisor: the
        // request line (path already rewritten by the caller) + headers as
        // received, then any bytes that arrived with the upgrade event
        let headStr = `${req.method} ${path} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) headStr += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        headStr += "\r\n";
        sendF({ t: "sd", sid, d: Buffer.concat([Buffer.from(headStr, "latin1"), head && head.length ? head : Buffer.alloc(0)]).toString("base64") });
        socket.on("data", (chunk) => {
          if (t.ws.bufferedAmount > MAX_WS_BUFFER) return finish("hub buffer overflow");
          idle(); sendF({ t: "sd", sid, d: chunk.toString("base64") });
        });
        socket.resume();
        return;
      }
      if (f.t === "sd" && open) { try { socket.write(Buffer.from(f.d || "", "base64")); } catch {} return; }
      if (f.t === "sx") { open = true; finish("closed"); }   // remote closed: plain teardown, no 502
    });
    socket.pause();
    socket.on("error", () => finish("closed"));
    socket.on("close", () => finish("closed"));
    idle();
    if (!sendF({ t: "s+", sid })) return finish("tunnel send failed");
  }

  let seq = 1;
  function send(name, method, path, headers, body) {
    const t = tunnels.get(name);
    if (!t) return Promise.reject(new Error(`no tunnel for ${name}`));
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { t.pending.delete(id); reject(new Error("tunnel request timeout")); }, reqTimeoutMs);
      t.pending.set(id, { resolve: (f) => { clearTimeout(timer); resolve(f); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { t.ws.send(JSON.stringify({ t: "req", id, method, path, headers, body: body ? body.toString("base64") : null })); }
      catch (e) { clearTimeout(timer); t.pending.delete(id); reject(e); }
    });
  }

  const NAME_RE = /^tunnel:\/\/(.+)$/;
  return {
    handleUpgrade,
    isTunnel: (origin) => NAME_RE.test(String(origin || "")),
    // One attached tunnel's identity, for modules that authenticate a tunnel's
    // own requests (relay/pads.mjs): null when nothing by that name is attached.
    info: (name) => { const t = tunnels.get(name); return t ? { name, mode: t.mode, tier: t.tier || "", keyFp: t.keyFp, spki: t.spki, padKey: t.padKey, ...(t.hvNode ? { hvNode: t.hvNode } : {}) } : null; },
    nameOf: (origin) => (String(origin || "").match(NAME_RE) || [])[1] || null,
    // synthetic registry rows for the attached tunnels (bypass the dial-based
    // discovery filters; auth already happened at attach time). `endpoint`
    // keeps the tunnel:// scheme — it is the ROUTING KEY (isTunnel/proxyTo
    // dispatch on it); `name` is the human-facing label display surfaces use.
    origins: () => [...tunnels.entries()].map(([name, t]) => ({
      endpoint: `tunnel://${name}`, id: `tunnel:${name}`, name, repo: "EnclaveHost/enclave",
      lastSeen: Math.floor(t.lastSeen / 1000), tunnel: true, mode: t.mode, publicUrl: t.publicUrl,
      // how the name was proved (the hub's record): "token" | "operator" | "attestation". A trusted-identity attach
      // (token, operator) is what lets a tunnel row speak for a RELAY (api-relay.js relayRowOf).
      attach: attachKindOf(t.via),
      measurement: t.measurement || undefined,
      ...(t.tier ? { tier: t.tier } : {}),
      // the pVM CPU tier's display facts (model, context, device name), set by this hub from an
      // admitted capability report; measured rates stay in the relay log, never on the public row
      ...(t.pvmCpu ? { pvmCpu: t.pvmCpu } : {}),
      ...(t.capsRefused && !t.pvmCpu ? { capsRefused: true } : {}),
      // A CONSUMER NODE's attested public keys, published because a client needs them to
      // talk to it at all: the session is sealed to the enclave's X25519 key (padKey) and
      // signed by its Ed25519 transport key, both minted inside VTL1 per boot and both
      // covered by the report this hub verified at attach. Publishing the public halves
      // adds no trust: in this tier the relay IS the verifier, so a client that believes
      // the row's tier already believes the row's keys. Nothing else consumes them yet,
      // so the field is scoped to mode vbs rather than every attached tunnel.
      ...(t.mode === "vbs" && t.spki ? { attestedKeys: { transportKey: t.spki, padKey: t.padKey || "" } } : {}),
      // mode hv-node: what the attach proved, stated as such; the node's own statement stays in the hub
      // mode hv-node, owner-only serving: the operator and the owners it serves (public addresses); absent = serves nothing
      ...(t.mode === "hv-node" && t.operator && t.served.length ? { ownerOnly: true, operator: t.operator, served: t.served.map((e) => ({ ...e })) } : {}),
      ...(t.mode === "hv-node" && t.hvNode ? { hvNode: { hostExcluded: false, tee: null, omissions: t.hvNode.omissions,
          bootCounter: t.hvNode.boot?.bootCounter ?? null, idksModulusSha256: t.hvNode.boot?.idksModulusSha256 ?? null, verifiedAt: t.hvNode.verifiedAt } } : {}),
    })),
    // fetch JSON (availability polling)
    fetchJson: async (origin, path) => {
      const name = (String(origin).match(NAME_RE) || [])[1];
      const r = await send(name, "GET", path, {}, null);
      if (r.status !== 200) return null;
      try { return JSON.parse(Buffer.from(r.body || "", "base64").toString("utf8")); } catch { return null; }
    },
    // full request/response for proxyTo (buffered)
    request: async (origin, { method, path, headers, body }) => {
      const name = (String(origin).match(NAME_RE) || [])[1];
      const r = await send(name, method || "GET", path, headers || {}, body);
      return { status: r.status || 502, headers: r.headers || {}, body: Buffer.from(r.body || "", "base64") };
    },
    count: () => tunnels.size,
    // websocket-upgrade splice into the guest supervisor (Phase D)
    spliceUpgrade,
    // the CHIP_IDs a mode-"snp" tunnel has proved at attach (VCEK-verified): secrets-release.mjs's lease-holder chip binding
    snpChipIdsOf: (name) => { const t = tunnels.get(name); return t && t.mode === "snp" ? [...(t.snpChips || [])] : []; },
  };
}
