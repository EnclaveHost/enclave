#!/usr/bin/env python3
"""activation-r1 prepare.py. UNREVIEWED SOURCE: its author executed nothing (no python, no node, no tests).

Deterministic generation of ISOLATED composed copies: the root-reviewed successor-host-r1 GENERATED host (sha256-pinned
from successor-host-r1/generated/PREPARE-MANIFEST.json "outputs") plus marked unified-activation-r1 hunks that

  - wire initSessions to an explicit, default-OFF activation loader (generated/relay/funding-activation.mjs) whose quote
    policy is the reviewed createGasFundQuotePolicy over THIS host's pc.request; the account, the ONE TxQueue, the
    journal, the keys, the network selection and every original route stay exactly as they are;
  - separate successor OWNER controls (/funding/owner, /funding/end, views, /funding/tx) from INTAKE (/funding/config,
    /quote, /execute, /open): owner controls need only an independent owner-controls manifest (no notAfter, factory /
    implementation / libraries pinned by runtime code hash and re-proven per request); intake needs that AND the intake
    manifest AND the v2 fee policy. Switching intake off, or its manifest / fee config expiring, keeps owner controls.

Writes ONLY inside this stage:

  generated/relay/sessions.mjs            successor-host-r1/generated/relay/sessions.mjs (pinned) + hunks
  generated/relay/funding-route.mjs       successor-host-r1/generated/relay/funding-route.mjs (pinned) + hunks
  generated/relay/funding-abi.mjs         byte copy (pinned)
  generated/relay/fee-policy.mjs          byte copy (pinned; the policy code is NOT changed here)
  generated/relay/funding-activation.mjs  byte copy of ./funding-activation.mjs (this stage's reviewed source)
  generated/relay/sessions-abi.mjs        symlink -> source/relay/sessions-abi.mjs   (read-only import)
  generated/relay/snp-verify.mjs          symlink -> source/relay/snp-verify.mjs     (read-only import)
  generated/node_modules                  symlink -> source/node_modules              (viem)
  generated/PREPARE-MANIFEST.json         sha256 of every input, output and hunk

Every hunk's `before` must occur exactly once; undoing every hunk must give the input byte for byte. successor-host-r1,
fee-policy-r1, relay-owner-r2 and source/ are only read.

  python3 prepare.py                    write the outputs
  python3 prepare.py --check            write nothing; exit 1 if anything is missing or differs
  python3 prepare.py --require-pinned   also refuse while ACTIVATION_SOURCE_SHA256 is unset (use for the install copy)
"""
import hashlib
import json
import os
import sys

STAGE = os.path.dirname(os.path.realpath(__file__))
UF = os.path.dirname(STAGE)                                   # unified-funding-20261028
SOURCE = os.path.normpath(os.path.join(UF, "..", "source"))
SH = os.path.join(UF, "successor-host-r1")
SH_MANIFEST = os.path.join(SH, "generated", "PREPARE-MANIFEST.json")
# successor-host-r1/generated/PREPARE-MANIFEST.json "outputs", copied verbatim (root: confirm against the files)
SH_PINS = {
    "generated/relay/sessions.mjs": "98c9a914dc02990cf8bc39dc5ea84bb78fd78d40abc767dff528a0e1410583be",
    "generated/relay/funding-route.mjs": "4fbbf97fb6f0f29c6e5eff7343a96d2ba186e9e8eaf592aea64333d9656eda70",
    "generated/relay/funding-abi.mjs": "6bb37e658aca45fd416d5ea17dda3109e1b41791e674976a60425d579f485cd7",
    "generated/relay/fee-policy.mjs": "32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd",
}
ACTIVATION_SOURCE = os.path.join(STAGE, "funding-activation.mjs")
# root: set to the reviewed sha256 of ./funding-activation.mjs (the author could not compute it)
ACTIVATION_SOURCE_SHA256 = None
# read-only test fixtures the tests import from sibling stages: hashes are RECORDED (root: review and pin)
TEST_INPUTS = {
    "relay-owner-r2/test/fake-chain.mjs": os.path.join(UF, "relay-owner-r2", "test", "fake-chain.mjs"),
    "fee-policy-r1/test/fixture.mjs": os.path.join(UF, "fee-policy-r1", "test", "fixture.mjs"),
    "fee-policy-r1/fee-policy.mjs": os.path.join(UF, "fee-policy-r1", "fee-policy.mjs"),
}
MARK = "unified-activation-r1"
SYMLINKS = {
    "generated/relay/sessions-abi.mjs": os.path.join(SOURCE, "relay", "sessions-abi.mjs"),
    "generated/relay/snp-verify.mjs": os.path.join(SOURCE, "relay", "snp-verify.mjs"),
    "generated/node_modules": os.path.join(SOURCE, "node_modules"),
}
# the loader must not carry its own transport, key, signer, wallet or queue
FORBIDDEN_IN_LOADER = ["TxQueue", "privateKeyToAccount", "createWalletClient", "createPublicClient", "sendTransaction",
                       "sendRawTransaction", "signTransaction", "eth_send", "fetch(", "node:http", "node:net", "WebSocket",
                       "child_process", "writeFile", "process.env"]
# counts that must be identical in input and output: no alternate signer, wallet, client or queue is introduced
SAME_COUNT = ["new TxQueue(", "privateKeyToAccount(", "createWalletClient(", "createPublicClient(", "sendTransaction(",
              "SESSIONS_RELAYER_KEY", "SESSIONS_NETWORK", "SESSIONS_RPC", "SESSIONS_FACTORY"]


def header(name):
    return (f"// >>> {MARK} GENERATED COPY by activation-r1/prepare.py from successor-host-r1/generated/relay/{name} (sha256\n"
            f"// {SH_PINS['generated/relay/' + name]}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
            f"// <<< {MARK}\n")


# ---------------------------------------------------------------------------------------------------------------------
# sessions.mjs hunks: import the loader, pass the owner-controls manifest to the route, spread the loader into initSessions
# ---------------------------------------------------------------------------------------------------------------------
S_IMPORT = (r'''import { createFundingRoute, fundingManifestFromEnv } from "./funding-route.mjs";
''', r'''import { createFundingRoute, fundingManifestFromEnv } from "./funding-route.mjs";
// [unified-activation-r1] the explicit, bounded, default-OFF activation loader (owner controls; intake + fee policy)
import { fundingActivationFromEnv } from "./funding-activation.mjs";
''')

S_ROUTE = (r'''  const funding = createFundingRoute({ manifest: o.funding ?? null, quotePolicy: o.fundingQuotePolicy ?? null,
''', r'''  // [unified-activation-r1] REPLACES this line: adds ownerControls, the independent successor owner-controls manifest
  const funding = createFundingRoute({ manifest: o.funding ?? null, quotePolicy: o.fundingQuotePolicy ?? null,
    ownerControls: o.fundingOwnerControls ?? null,
''')

S_INIT = (r'''    // >>> funding-r2
    funding: fundingManifestFromEnv(process.env),
    // <<< funding-r2
''', r'''    // >>> funding-r2
    funding: fundingManifestFromEnv(process.env),
    // <<< funding-r2
    // >>> unified-activation-r1: explicit, default-OFF activation (SESSIONS_FUNDING_OWNER_CONTROLS, SESSIONS_FUNDING_INTAKE).
    // Never throws: a missing, malformed or mismatched new file leaves only the piece it configures off. The quote policy
    // reads over THIS public client's EIP-1193 request; every send stays on THIS account's ONE TxQueue (createSessionsService).
    ...fundingActivationFromEnv(process.env, { netName, chainId: chain.id, relayer: account.address,
      request: (args) => pc.request(args), log: (m) => console.log(`[sessions] ${m}`) }),
    // <<< unified-activation-r1
''')

SESSIONS_HUNKS = [("loader import", *S_IMPORT), ("route ownerControls", *S_ROUTE), ("initSessions activation", *S_INIT)]

# ---------------------------------------------------------------------------------------------------------------------
# funding-route.mjs hunks
# ---------------------------------------------------------------------------------------------------------------------
R_PARSE = (r'''export function fundingManifestFromEnv(env) {
  const p = String(env?.SESSIONS_FUNDING_MANIFEST ?? "").trim();
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return { invalid: `SESSIONS_FUNDING_MANIFEST could not be read: ${msg(e)}` }; }
}
''', r'''export function fundingManifestFromEnv(env) {
  const p = String(env?.SESSIONS_FUNDING_MANIFEST ?? "").trim();
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return { invalid: `SESSIONS_FUNDING_MANIFEST could not be read: ${msg(e)}` }; }
}

// >>> unified-activation-r1: the INDEPENDENT successor owner-controls manifest. It pins only the successor code an owner
// route sends to: the factory, the implementation and its linked libraries, by address and runtime code hash. Deployed
// code is immutable, so it has no notAfter: an expired intake manifest or fee configuration never locks an owner out, and
// every request still re-proves each pin on chain (no code or other code there: nothing is sent).
export const OWNER_MANIFEST_SCHEMA = "enclave-funding-owner-controls-r1";
export const OWNER_PIN_KEYS = Object.freeze(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib"]);
const OWNER_MANIFEST_KEYS = ["schema", "chainId", "maxBlockAgeSec", "addresses", "codehashes"];

export function parseOwnerControlsManifest(m) {
  if (m === null || m === undefined) return { why: "successor owner controls are not configured on this relay (no owner-controls manifest)" };
  if (m && typeof m === "object" && Object.keys(m).length === 1 && typeof m.invalid === "string") return { why: m.invalid };
  try {
    exactKeys(m, OWNER_MANIFEST_KEYS, "ownerManifest");
    if (m.schema !== OWNER_MANIFEST_SCHEMA) throw httpError(400, "bad_manifest", `ownerManifest.schema must be "${OWNER_MANIFEST_SCHEMA}"`);
    if (uint(m.chainId, 64, "ownerManifest.chainId") !== BigInt(FUNDING_CHAIN_ID)) {
      throw httpError(400, "bad_manifest", `ownerManifest.chainId must be ${FUNDING_CHAIN_ID} (Base)`);
    }
    const maxBlockAgeSec = uint(m.maxBlockAgeSec, 32, "ownerManifest.maxBlockAgeSec");
    if (maxBlockAgeSec < 1n || maxBlockAgeSec > 600n) throw httpError(400, "bad_manifest", "ownerManifest.maxBlockAgeSec must be 1..600");
    exactKeys(m.addresses, OWNER_PIN_KEYS, "ownerManifest.addresses");
    exactKeys(m.codehashes, OWNER_PIN_KEYS, "ownerManifest.codehashes");
    const addresses = {}, codehashes = {};
    for (const k of OWNER_PIN_KEYS) {
      addresses[k] = address(m.addresses[k], `ownerManifest.addresses.${k}`);
      if (/^0x0{40}$/.test(addresses[k])) throw httpError(400, "bad_manifest", `ownerManifest.addresses.${k} is the zero address`);
      codehashes[k] = codehash(m.codehashes[k], `ownerManifest.codehashes.${k}`);
    }
    if (new Set(Object.values(addresses)).size !== OWNER_PIN_KEYS.length) throw httpError(400, "bad_manifest", "ownerManifest identities must be pairwise distinct");
    return { owner: Object.freeze({ chainId: FUNDING_CHAIN_ID, maxBlockAgeSec, addresses: Object.freeze(addresses),
      codehashes: Object.freeze(codehashes) }) };
  } catch (e) {
    return { why: `the successor owner-controls manifest is refused: ${e.message}` };
  }
}
// <<< unified-activation-r1
''')

R_SIG = (r'''  relayer = null, store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null, intents = null } = {}) {
''', r'''  // [unified-activation-r1] REPLACES this line: adds ownerControls, the independent successor owner-controls manifest
  relayer = null, store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null, intents = null,
  ownerControls = null } = {}) {
''')

R_SPLIT = (r'''  const M = why ? null : setup.manifest;
  const A = M?.addresses;
  const R = M ? getAddress(relayer) : null;
''', r'''  // >>> unified-activation-r1 (REPLACES the M / A / R lines): owner controls are configured APART from intake. They need
  // only the host pieces and the independent owner-controls manifest: never the quote policy, the envelope, the intake
  // manifest's DEX pins or its notAfter. Intake additionally needs owner controls on, pinning the SAME successor code, so
  // switching intake off (rollback) or letting its manifest / fee configuration expire never removes them.
  let hostWhy = null;
  if (typeof simulateAndSend !== "function") hostWhy = "funding needs the host's simulateAndSend callback";
  else if (!intents || ["reserve", "state", "release", "settle", "reconcile", "byHash"].some((k) => typeof intents[k] !== "function")) {
    hostWhy = "funding needs the host queue's durable successor intent journal; none is wired";
  } else if (!pc || typeof pc.readContract !== "function" || typeof pc.simulateContract !== "function"
    || typeof pc.getTransactionReceipt !== "function" || typeof pc.getBlock !== "function") hostWhy = "funding needs the host's public client";
  else if (typeof relayer !== "string" || !isAddress(relayer)) hostWhy = "funding needs the relayer address";
  else if (!store?.data) hostWhy = "funding needs the host's store";
  const ownerSetup = parseOwnerControlsManifest(ownerControls);
  const controlsWhy = hostWhy ?? ownerSetup.why ?? null;
  const O = controlsWhy ? null : ownerSetup.owner;
  if (!why && !O) why = `funding intake needs successor owner controls on (so switching intake off never removes them): ${controlsWhy}`;
  if (!why) {
    const differ = OWNER_PIN_KEYS.filter((k) => setup.manifest.addresses[k] !== O.addresses[k] || setup.manifest.codehashes[k] !== O.codehashes[k]);
    if (differ.length) why = `the intake manifest and the owner-controls manifest pin different successor code (${differ.join(", ")}); intake stays off`;
  }
  const M = why ? null : setup.manifest;
  const A = M?.addresses ?? O?.addresses ?? null;
  const R = M || O ? getAddress(relayer) : null;
  // <<< unified-activation-r1
''')

R_STORE = (r'''  if (M) {
    store.data.revoked ??= {};''', r'''  if (M || O) { // [unified-activation-r1] REPLACES `if (M) {`: owner controls alone also need the shared index
    store.data.revoked ??= {};''')

R_LOG = (r'''  log(M ? `funding: on (successor factory ${A.factory}, owner management ${ownerAllowed ? "on" : "off"})` : `funding: off (${why})`);
''', r'''  // [unified-activation-r1] REPLACES the log line: intake and owner controls are reported separately
  log(`funding: intake ${M ? `on (successor factory ${A.factory})` : `off (${why})`}; owner controls ${O && ownerAllowed
    ? `on (successor factory ${O.addresses.factory})` : `off (${O ? ownerWhy : controlsWhy})`}`);
''')

R_OWNER_PINS = (r'''  async function fundingVault(v, P) {
''', r'''  // >>> unified-activation-r1: the pins the successor OWNER routes need, from the owner-controls manifest. At ONE latest
  // block: the chain, every pinned runtime code hash, the implementation's library links and factory <-> implementation.
  // fundingVault (unchanged) then admits only a registered CREATE2 clone of that implementation; the vault itself checks
  // every owner / session signature in simulation before anything is reserved or sent.
  async function readOwnerPins() {
    const blk = await step(() => pc.getBlock({ blockTag: "latest" }), "pin_unreadable");
    const chain = await step(() => pc.getChainId(), "pin_unreadable");
    if (Number(chain) !== FUNDING_CHAIN_ID) throw httpError(503, "chain_mismatch", `the RPC serves chain ${chain}, not ${FUNDING_CHAIN_ID}`);
    if (blk?.number == null || blk?.timestamp == null) throw httpError(503, "pin_unreadable", "the latest block has no number/timestamp");
    const B = BigInt(blk.number);
    const ts = BigInt(blk.timestamp);
    const t = BigInt(now());
    if (t > ts + O.maxBlockAgeSec) throw httpError(503, "block_stale", `the latest block (${B}) is ${t - ts}s old`);
    const pin = (code, message) => { throw httpError(503, code, message, { block: B.toString() }); };
    const OA = O.addresses;
    const codes = {};
    for (const k of OWNER_PIN_KEYS) {
      const code = await step(() => pc.getCode({ address: OA[k], blockNumber: B }), "pin_unreadable");
      if (!code || code === "0x") pin("missing_code", `${k} ${OA[k]} has no code at block ${B}`);
      if (keccak256(code) !== O.codehashes[k]) pin("codehash_mismatch", `${k} ${OA[k]} runtime code hash differs from the owner-controls manifest at block ${B}`);
      codes[k] = code.toLowerCase();
    }
    for (const k of LINKED_LIBS) {
      if (!codes.implementation.includes(OA[k].slice(2).toLowerCase())) pin("library_unlinked", `the implementation does not link ${k} ${OA[k]}`);
    }
    const eq = async (label, a, abi, fn, want) => {
      const got = await step(() => rd(a, abi, fn, [], B), "pin_unreadable");
      if (typeof got !== "string" || !isAddress(got) || getAddress(got) !== want) pin("identity_mismatch", `${label} is ${got}, the owner-controls manifest says ${want}`);
    };
    await eq("factory.implementation()", OA.factory, factoryAbi, "implementation", OA.implementation);
    await eq("implementation.factory()", OA.implementation, vaultAbi, "factory", OA.factory);
    return Object.freeze({ block: B, timestamp: ts });
  }
  // <<< unified-activation-r1

  async function fundingVault(v, P) {
''')

R_FINISH = (r'''    const out = FINISH[kind](c.receipt, meta);
''', r'''    // [unified-activation-r1] a gas.fund settlement is proven against the INTAKE manifest's adapter: while intake is off it
    // waits, read-only (the journal keeps the intent; nothing is resubmitted, settled, indexed or refunded)
    if (kind === "execute" && !M) throw httpError(503, "funding_disabled", `a gas.fund settlement is reconciled only while intake is on (${why})`, { txHash, intent: key });
    const out = FINISH[kind](c.receipt, meta);
''')

R_OWNER_OP = (r'''    if (op !== "close") rateOwner(owner, op); // unsigned close must not consume an owner's authenticated quota
    const P = await readPins();
''', r'''    if (op !== "close") rateOwner(owner, op); // unsigned close must not consume an owner's authenticated quota
    // [unified-activation-r1] REPLACES `readPins()`: the owner-controls pins (no intake notAfter, no DEX pins)
    const P = await readOwnerPins();
''')

R_END = (r'''    const P = await readPins();
    const { vault } = await fundingVault(body.vault, P);
''', r'''    // [unified-activation-r1] REPLACES `readPins()`: the owner-controls pins (no intake notAfter, no DEX pins)
    const P = await readOwnerPins();
    const { vault } = await fundingVault(body.vault, P);
''')

R_VIEW = (r'''    const P = await readPins();
    const { vault } = await fundingVault(getAddress(vaultHex.toLowerCase()), P);
''', r'''    // [unified-activation-r1] REPLACES `readPins()`: the owner-controls pins (no intake notAfter, no DEX pins)
    const P = await readOwnerPins();
    const { vault } = await fundingVault(getAddress(vaultHex.toLowerCase()), P);
''')

R_ROUTE = (r'''  async function route(method, path, body, ctx) {
    if (!M) throw httpError(503, "funding_disabled", why);
''', r'''  async function route(method, path, body, ctx) {
    // >>> unified-activation-r1 (REPLACES the one global gate): intake (config, quote, execute, open) needs M, which
    // implies owner controls; owner controls (owner, end, the session / owner views, tx reconciliation) need only O.
    const intake = (method === "GET" && path === "/funding/config")
      || (method === "POST" && (path === "/funding/quote" || path === "/funding/execute" || path === "/funding/open"));
    if (intake ? !M : !O) throw httpError(503, "funding_disabled", intake ? why : `successor owner controls are off: ${controlsWhy}`);
    // <<< unified-activation-r1
''')

R_RETURN = (r'''  return Object.freeze({ route, enabled: Boolean(M), why, ownerEnabled: Boolean(M) && ownerAllowed, openEnabled: Boolean(M) && ownerAllowed });
''', r'''  // [unified-activation-r1] REPLACES the next line: owner controls are reported apart from intake
  return Object.freeze({ route, enabled: Boolean(M), why, ownerEnabled: Boolean(O) && ownerAllowed, ownerControlsWhy: O ? ownerWhy : controlsWhy,
    openEnabled: Boolean(M) && ownerAllowed });
''')

ROUTE_HUNKS = [("owner manifest", *R_PARSE), ("signature", *R_SIG), ("activation split", *R_SPLIT), ("store init", *R_STORE),
               ("log", *R_LOG), ("owner pins", *R_OWNER_PINS), ("execute settlement guard", *R_FINISH),
               ("owner op pins", *R_OWNER_OP), ("end pins", *R_END), ("session view pins", *R_VIEW), ("route gate", *R_ROUTE),
               ("return", *R_RETURN)]


def die(m):
    sys.stderr.write(f"prepare.py: {m}\n")
    sys.exit(1)


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def read(path):
    with open(path, "rb") as f:
        return f.read()


def inside_stage(path):
    p = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
    if os.path.commonpath([p, STAGE]) != STAGE:
        die(f"refusing to write outside the stage: {p}")
    return p


def apply(text, hunks, what):
    if MARK in text:
        die(f"{what} already contains {MARK}")
    out = text
    for name, before, after in hunks:
        if MARK in before or MARK not in after:
            die(f"{what} hunk {name}: malformed")
        if out.count(before) != 1:
            die(f"{what} hunk {name}: its anchor occurs {out.count(before)} times (must be exactly once)")
        out = out.replace(before, after, 1)
    back = out
    for name, before, after in reversed(hunks):
        if back.count(after) != 1:
            die(f"{what} hunk {name}: its result occurs {back.count(after)} times after patching")
        back = back.replace(after, before, 1)
    if back != text:
        die(f"{what}: undoing the hunks does not give the input")
    return out


def same_counts(before, after, what):
    for tok in SAME_COUNT:
        if before.count(tok) != after.count(tok):
            die(f"{what}: {tok!r} occurs {before.count(tok)} times in the input, {after.count(tok)} in the output")


def build(require_pinned):
    inputs = {}
    for rel, want in SH_PINS.items():
        b = read(os.path.join(SH, rel))
        if sha256(b) != want:
            die(f"successor-host-r1/{rel} sha256 {sha256(b)} is not the pinned {want} (successor-host-r1 changed: re-review and re-pin)")
        inputs[rel] = b
    try:
        sm = json.loads(read(SH_MANIFEST))
    except (OSError, ValueError) as e:
        die(f"successor-host-r1 manifest unreadable: {e}")
    for rel, want in SH_PINS.items():
        if (sm.get("outputs") or {}).get(rel) != want:
            die(f"successor-host-r1 manifest outputs[{rel}] is {(sm.get('outputs') or {}).get(rel)}, not {want}")
    if not str(sm.get("activation", "")).startswith("OFF"):
        die("successor-host-r1 manifest does not state activation OFF")
    src_s = inputs["generated/relay/sessions.mjs"].decode()
    src_r = inputs["generated/relay/funding-route.mjs"].decode()
    if "fundingQuotePolicy:" in src_s or "fundingActivationFromEnv" in src_s:
        die("the input host already wires a funding quote policy or activation loader")

    loader = read(ACTIVATION_SOURCE)
    if ACTIVATION_SOURCE_SHA256 is not None and sha256(loader) != ACTIVATION_SOURCE_SHA256:
        die(f"funding-activation.mjs sha256 {sha256(loader)} is not the reviewed {ACTIVATION_SOURCE_SHA256}")
    if ACTIVATION_SOURCE_SHA256 is None and require_pinned:
        die("ACTIVATION_SOURCE_SHA256 is unset: review funding-activation.mjs and pin it before preparing an install copy")
    lt = loader.decode()
    for tok in FORBIDDEN_IN_LOADER:
        if tok in lt:
            die(f"funding-activation.mjs contains {tok!r}: the loader must not carry a transport, key, signer, wallet, queue or env read")

    sessions_body = apply(src_s, SESSIONS_HUNKS, "sessions.mjs")
    route_body = apply(src_r, ROUTE_HUNKS, "funding-route.mjs")
    same_counts(src_s, sessions_body, "sessions.mjs")
    same_counts(src_r, route_body, "funding-route.mjs")
    if sessions_body.count("fundingActivationFromEnv(process.env") != 1:
        die("sessions.mjs: the activation loader must be called exactly once (initSessions)")
    sessions = (header("sessions.mjs") + sessions_body).encode()
    route = (header("funding-route.mjs") + route_body).encode()
    for k, t in SYMLINKS.items():
        if not os.path.exists(t):
            die(f"{k}: the import target {t} does not exist")
    if not os.path.exists(os.path.join(SOURCE, "node_modules", "viem", "package.json")):
        die("source/node_modules has no viem")

    outputs = {
        "generated/relay/sessions.mjs": sessions,
        "generated/relay/funding-route.mjs": route,
        "generated/relay/funding-abi.mjs": inputs["generated/relay/funding-abi.mjs"],
        "generated/relay/fee-policy.mjs": inputs["generated/relay/fee-policy.mjs"],
        "generated/relay/funding-activation.mjs": loader,
    }
    rel_links = {k: os.path.relpath(t, os.path.dirname(os.path.join(STAGE, k))) for k, t in sorted(SYMLINKS.items())}
    hunks = {}
    for what, hs in (("sessions.mjs", SESSIONS_HUNKS), ("funding-route.mjs", ROUTE_HUNKS)):
        for name, before, after in hs:
            hunks[f"{what}: {name}"] = {"before": sha256(before.encode()), "after": sha256(after.encode())}
    observed = {}
    for k, p in sorted(TEST_INPUTS.items()):
        observed[k] = sha256(read(p)) if os.path.isfile(p) else "MISSING"
    manifest = {
        "inputs": {**{f"successor-host-r1/{k}": v for k, v in sorted(SH_PINS.items())},
                   "successor-host-r1/generated/PREPARE-MANIFEST.json": sha256(read(SH_MANIFEST))},
        "stage_source": {"funding-activation.mjs": sha256(loader),
                         "pinned": ACTIVATION_SOURCE_SHA256 is not None},
        "test_inputs_observed_unpinned": observed,
        "hunks": hunks,
        "outputs": {k: sha256(v) for k, v in sorted(outputs.items())},
        "symlinks": rel_links,
        "activation": "OFF by default: SESSIONS_FUNDING_OWNER_CONTROLS and SESSIONS_FUNDING_INTAKE unset enable nothing",
        "note": "source-only stage: these hashes are computed when the root runs prepare.py; nothing here was executed by its author",
    }
    outputs["generated/PREPARE-MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return outputs, rel_links


def write_outputs(outputs, links, check):
    stale = []
    for rel, data in outputs.items():
        path = inside_stage(os.path.join(STAGE, rel))
        if check:
            if os.path.islink(path) or not os.path.isfile(path) or read(path) != data:
                stale.append(rel)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            die(f"{rel} is a symlink; refusing to write through it")
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    for rel, target in links.items():
        path = os.path.join(STAGE, rel)
        if not check:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            if os.readlink(path) != target:
                (stale.append(rel) if check else die(f"{rel} links to {os.readlink(path)}, not {target}"))
        elif os.path.exists(path):
            (stale.append(rel) if check else die(f"{rel} exists and is not a symlink"))
        elif check:
            stale.append(rel)
        else:
            os.symlink(target, path)
    return stale


def main(argv):
    flags = set(argv)
    if flags - {"--check", "--require-pinned"}:
        die(f"unknown argument(s) {sorted(flags - {'--check', '--require-pinned'})}")
    outputs, links = build("--require-pinned" in flags)
    stale = write_outputs(outputs, links, "--check" in flags)
    if stale:
        die("stale or missing: " + ", ".join(stale))
    m = json.loads(outputs["generated/PREPARE-MANIFEST.json"])
    for k, v in sorted(m["outputs"].items()):
        print(f"{v}  {k}")
    if not m["stage_source"]["pinned"]:
        print(f"UNPINNED stage source {m['stage_source']['funding-activation.mjs']}  funding-activation.mjs (root: review, then set ACTIVATION_SOURCE_SHA256)")
    for k, v in sorted(m["test_inputs_observed_unpinned"].items()):
        print(f"OBSERVED (unpinned test input) {v}  {k}")
    print("checked" if "--check" in flags else "written")


if __name__ == "__main__":
    main(sys.argv[1:])
