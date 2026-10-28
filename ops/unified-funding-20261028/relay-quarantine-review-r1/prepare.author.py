#!/usr/bin/env python3
"""relay-quarantine-r1 generator: SESSIONS_WRITE_QUARANTINE startup mode over activation-r1's generated relay.

Reads (never edits) ../activation-r1/generated/relay/{sessions,funding-route,funding-activation,fee-policy,funding-abi}.mjs
and ../activation-r1/test/activation.test.mjs. Writes ONLY under ./generated and ./test/activation.test.mjs:
  generated/relay/sessions.mjs        input + the marked relay-quarantine-r1 hunks below (exact, each anchor once)
  generated/relay/<other four>.mjs    byte copies of the inputs (unchanged)
  generated/relay/{sessions-abi,snp-verify}.mjs, generated/node_modules   symlinks to the SAME real targets activation-r1 uses
  test/activation.test.mjs            byte copy of activation-r1's suite: the default-mode regression over this output
  generated/PREPARE-MANIFEST.json     sha256 of every input and output

Refuses (exit 1, nothing written) if: an input's sha256 does not start with its runtime prefix, an anchor is missing or
not unique, undoing the hunks does not give the input byte for byte, a guarded token count changes, any output names a raw
send/sign RPC, or (with --require-pinned) any full pin below is unset or differs. --check writes nothing and compares the
existing outputs with what would be written.

NOT RUN by its author (source-only task). Root: review, run, then fill the pins and use --require-pinned.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
U = HERE.parent
SRC = U / "activation-r1" / "generated" / "relay"
SRC_MODULES = U / "activation-r1" / "generated" / "node_modules"
SRC_TEST = U / "activation-r1" / "test" / "activation.test.mjs"
GEN = HERE / "generated"
OUT = GEN / "relay"
OUT_TEST = HERE / "test" / "activation.test.mjs"
MARK = "relay-quarantine-r1"

INPUTS = ["sessions.mjs", "funding-route.mjs", "funding-activation.mjs", "fee-policy.mjs", "funding-abi.mjs"]
LINKS = ["sessions-abi.mjs", "snp-verify.mjs"]
# The installed runtime, as named in the task (sha256 prefixes). Root: confirm these are sha256 and not another digest.
RUNTIME_PREFIX = {"sessions.mjs": "76341ba3", "funding-route.mjs": "1989f3eb"}
# Full pins: unset until the root reviews. --require-pinned refuses while any is None.
INPUT_SHA256 = {n: None for n in INPUTS + ["activation.test.mjs"]}
OUTPUT_SESSIONS_SHA256 = None

# Tokens whose count must be identical in input and output sessions.mjs: one key, one account, one wallet client, one
# public client, one queue, one broadcast site, the same send call sites and the same journal file.
SAME_COUNT = ["new TxQueue(", "privateKeyToAccount(", "createWalletClient(", "createPublicClient(", "sendTransaction(",
              "simulateAndSend(", ".send(", "SESSIONS_RELAYER_KEY", "sessions-relayer.json", "pc.request(", "setInterval("]
# No output may name a raw-transaction or signing RPC.
FORBIDDEN = ["eth_sendRawTransaction", "eth_sendTransaction", "sendRawTransaction", "signTransaction", "eth_sign"]
# The relative imports of the copied suite; they resolve identically from this sibling directory.
TEST_IMPORT_PREFIXES = ["node:", "../generated/relay/", "../generated/node_modules/", "../../relay-owner-r2/test/",
                        "../../fee-policy-r1/test/"]

H1 = r'''// >>> relay-quarantine-r1 STARTUP write quarantine (SESSIONS_WRITE_QUARANTINE), read ONCE when this module loads and frozen.
// Nothing in the process can lift it (no route, admin API, signal or later env change); only a reviewed restart can.
// Unset, empty or "0": off, and every path below is the input's. "1": on. Any other value: on (fails closed, logged).
// On: every non-GET/HEAD request of /v1/sessions (/funding/* and the owner controls included) answers 503 write_quarantine
// before any read or any index, revocation, quota, opNonce or intent change; the keeper admits nothing; simulateAndSend,
// TxQueue.send and TxQueue._send call the gate first (before estimate, nonce, journal record, signature or broadcast), as does
// the alternate attestor queue; the relayer account and wallet client keep their data (address, chain) while every method
// refuses; and the relayer journal is sealed: flush / saveSoon (also called by JsonStore's timer and its SIGTERM / SIGINT
// hook) do nothing, so this process never rewrites the journal file it found. GET routes and the index are unchanged.
export function writeQuarantineFromEnv(env) {
  const raw = env?.SESSIONS_WRITE_QUARANTINE;
  if (raw === undefined || raw === "" || raw === "0") return Object.freeze({ on: false, value: "off" });
  return Object.freeze({ on: true, value: raw === "1" ? "1" : "invalid" });
}
export const WRITE_QUARANTINE = writeQuarantineFromEnv(process.env);
const QUARANTINE_SINCE = new Date().toISOString();
const quarantineCounts = { route: 0, keeper: 0, simulate: 0, queue: 0, queue_inner: 0, attestor_queue: 0, wallet: 0, account: 0 };
let quarantineJournalWrites = 0;

/** The ONE gate of every write path. Off: returns. On: counts the path (never anything of the request) and throws 503. */
export function quarantineGate(path) {
  if (!WRITE_QUARANTINE.on) return;
  quarantineCounts[path] = (quarantineCounts[path] ?? 0) + 1;
  throw httpError(503, "write_quarantine", `maintenance: this relay is in write quarantine (${path}); nothing was simulated, `
    + "reserved, signed or sent, and no session state changed. Owners can still call their vault directly on chain.");
}

/** Data (address, chain, ...) reads through; every method refuses through the gate. */
function quarantineDisarm(x, path) {
  if (!x || typeof x !== "object") return x;
  return new Proxy(Object.create(null), {
    get: (_t, k) => { const v = x[k]; return typeof v === "function" ? () => quarantineGate(path) : v; },
  });
}

/** The relayer journal, quarantined: the same data in memory, never written back. Non-writable own no-ops shadow the
 *  store's flush / saveSoon, so no later assignment, timer or exit hook can persist it from this process. */
function quarantineSealJournal(j) {
  const skip = () => { quarantineJournalWrites++; };
  for (const k of ["flush", "saveSoon"]) Object.defineProperty(j, k, { value: skip, writable: false, configurable: false, enumerable: false });
  return j;
}

/** Counts only (no key, hash, label or body): what the relayer journal holds. */
function quarantineJournalShape(d) {
  const txs = Array.isArray(d?.txs) ? d.txs : [];
  const nonces = txs.map((r) => Number(r?.nonce)).filter(Number.isSafeInteger);
  return { records: txs.length, maxNonce: nonces.length ? Math.max(...nonces) : null,
    unresolved: txs.filter((r) => !["mined", "reverted", "nonce_lost", "nonce_busy"].includes(r?.status)).length,
    intents: Object.keys(d?.intents ?? {}).length };
}

/** GET /v1/sessions/quarantine (quarantined only; otherwise that path stays 404 as in the input). */
function quarantineStatus(data, boot) {
  return { writeQuarantine: true, value: WRITE_QUARANTINE.value, since: QUARANTINE_SINCE, refused: { ...quarantineCounts },
    journal: { persisted: false, writesSuppressed: quarantineJournalWrites, atBoot: boot, now: quarantineJournalShape(data) } };
}
// <<< relay-quarantine-r1
'''


def hunks(input_sha):
    """(old, new) exact replacements, applied in order. Every `new` carries the marker; undoing them gives the input."""
    head_old = ("// >>> unified-activation-r1 GENERATED COPY by activation-r1/prepare.py from "
                "successor-host-r1/generated/relay/sessions.mjs (sha256\n")
    return [
        (head_old,
         f"// >>> {MARK} GENERATED COPY by relay-quarantine-prep-r1/prepare.py from activation-r1/generated/relay/sessions.mjs\n"
         f"// (sha256 {input_sha}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
         f"// With SESSIONS_WRITE_QUARANTINE unset, empty or \"0\" every path is the input's.\n"
         f"// <<< {MARK}\n" + head_old),
        ("const ENV_PROD = 2;\n", "const ENV_PROD = 2;\n\n" + H1),
        ("    Object.assign(this, { pc, wc, account, journal, log, alert, receiptTimeoutMs, maxAttempts, maxTipWei, pollMs, sleep, clock });\n",
         "    Object.assign(this, { pc, wc, account, journal, log, alert, receiptTimeoutMs, maxAttempts, maxTipWei, pollMs, sleep, clock });\n"
         "    // [relay-quarantine-r1] quarantined, this queue's wallet client and account keep their data and every method refuses\n"
         "    if (WRITE_QUARANTINE.on) for (const [k, p] of [[\"wc\", \"wallet\"], [\"account\", \"account\"]])\n"
         "      Object.defineProperty(this, k, { value: quarantineDisarm(this[k], p), writable: false, configurable: false, enumerable: true });\n"),
        ("  send(item) {\n    const p = this.chain.then(() => this._send(item));\n",
         "  send(item) {\n"
         "    // [relay-quarantine-r1] the mandatory gate, before the serial lane: quarantined, no estimate, nonce, journal record,\n"
         "    // signature or broadcast happens (a rejected promise, as every refused send already was)\n"
         "    try { quarantineGate(\"queue\"); } catch (e) { return Promise.reject(e); }\n"
         "    const p = this.chain.then(() => this._send(item));\n"),
        ("  async _send({ to, data, label, envelope, intent }) {\n",
         "  async _send({ to, data, label, envelope, intent }) {\n"
         "    quarantineGate(\"queue_inner\");   // [relay-quarantine-r1] the same gate for a caller reaching _send directly\n"),
        ("  const { pc, wc, account, chainId } = o;\n",
         "  // [relay-quarantine-r1] REPLACES the destructuring of pc, wc, account, chainId: quarantined, the account's methods refuse\n"
         "  const { pc, wc, chainId } = o;\n"
         "  const account = WRITE_QUARANTINE.on ? quarantineDisarm(o.account, \"account\") : o.account;\n"),
        ("  const journal = o.journal;\n",
         "  // [relay-quarantine-r1] REPLACES the journal line: quarantined, the relayer journal is read and never written back\n"
         "  const journal = WRITE_QUARANTINE.on ? quarantineSealJournal(o.journal) : o.journal;\n"),
        ("  const queue = new TxQueue({ pc, wc, account, journal, log, alert, maxTipWei });\n",
         "  const queue = new TxQueue({ pc, wc, account, journal, log, alert, maxTipWei });\n"
         "  // >>> relay-quarantine-r1: what this process found in the relayer journal (counts only), for GET /quarantine\n"
         "  const quarantineBoot = WRITE_QUARANTINE.on ? quarantineJournalShape(journal.data) : null;\n"
         "  if (WRITE_QUARANTINE.on) log(`WRITE QUARANTINE on${WRITE_QUARANTINE.value === \"1\" ? \"\" : \" (unrecognised SESSIONS_WRITE_QUARANTINE value: failing closed)\"}: `\n"
         "    + \"this process sends no session transaction and never writes the relayer journal; restart without it only after review\");\n"
         "  // <<< relay-quarantine-r1\n"),
        ("  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope, intent }) {\n  // <<< fee-policy-r1\n",
         "  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope, intent }) {\n  // <<< fee-policy-r1\n"
         "    quarantineGate(\"simulate\");   // [relay-quarantine-r1] before the simulation: no afterSimulate (revocation, quota, intent) runs\n"),
        ("  async function keeperOnce() {\n",
         "  async function keeperOnce() {\n"
         "    // [relay-quarantine-r1] quarantined, the keeper admits no close: nothing is read, marked, simulated or sent\n"
         "    if (WRITE_QUARANTINE.on) { quarantineCounts.keeper++; return; }\n"),
        ("  async function route(method, path, body, ctx) {\n    // >>> funding-r2\n",
         "  async function route(method, path, body, ctx) {\n"
         "    // >>> relay-quarantine-r1: quarantined, every write of this surface (POST /attest, /quote, /execute, /open, /owner, /end and\n"
         "    // every non-GET of /funding/*, the owner controls included) is refused HERE, before any read or state change. GET is unchanged.\n"
         "    if (WRITE_QUARANTINE.on && method !== \"GET\" && method !== \"HEAD\") quarantineGate(\"route\");\n"
         "    if (WRITE_QUARANTINE.on && method === \"GET\" && path === \"/quarantine\") return quarantineStatus(journal.data, quarantineBoot);\n"
         "    // <<< relay-quarantine-r1\n"
         "    // >>> funding-r2\n"),
        ("    const rc = await q.send({ to: att.address,",
         "    // [relay-quarantine-r1] an alternate attestor queue (o.attestor.queue) is not this TxQueue: the same gate runs before it\n"
         "    if (q !== queue) quarantineGate(\"attestor_queue\");\n"
         "    const rc = await q.send({ to: att.address,"),
    ]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def fail(msg):
    print(f"prepare: REFUSED: {msg}", file=sys.stderr)
    sys.exit(1)


def build(require_pinned):
    raw = {}
    for n in INPUTS:
        p = SRC / n
        if p.is_symlink() or not p.is_file():
            fail(f"input {p} is not a regular file")
        raw[n] = p.read_bytes()
    if SRC_TEST.is_symlink() or not SRC_TEST.is_file():
        fail(f"input {SRC_TEST} is not a regular file")
    raw["activation.test.mjs"] = SRC_TEST.read_bytes()
    digests = {n: sha(b) for n, b in raw.items()}
    for n, pre in RUNTIME_PREFIX.items():
        if not digests[n].startswith(pre):
            fail(f"{n} sha256 {digests[n]} is not the runtime {pre}")
    for n, want in INPUT_SHA256.items():
        if want is None:
            if require_pinned:
                fail(f"--require-pinned: INPUT_SHA256[{n!r}] is unset")
        elif want != digests[n]:
            fail(f"{n} sha256 {digests[n]} != pinned {want}")

    src = raw["sessions.mjs"].decode("utf-8")
    if MARK in src:
        fail("the input already carries relay-quarantine-r1 hunks")
    out = src
    hs = hunks(digests["sessions.mjs"])
    for i, (old, new) in enumerate(hs):
        if MARK not in new:
            fail(f"hunk {i} is unmarked")
        if out.count(old) != 1:
            fail(f"hunk {i}: anchor found {out.count(old)} times, not once: {old[:70]!r}")
        out = out.replace(old, new)
    back = out
    for i, (old, new) in reversed(list(enumerate(hs))):
        if back.count(new) != 1:
            fail(f"hunk {i}: not reversible (its text appears {back.count(new)} times)")
        back = back.replace(new, old)
    if back != src:
        fail("undoing the hunks does not give the input byte for byte")
    for t in SAME_COUNT:
        if src.count(t) != out.count(t):
            fail(f"token {t!r}: {src.count(t)} in the input, {out.count(t)} in the output")
    files = {"sessions.mjs": out.encode("utf-8")}
    files.update({n: raw[n] for n in INPUTS if n != "sessions.mjs"})
    for n, b in files.items():
        text = b.decode("utf-8")
        for t in FORBIDDEN:
            if t in text:
                fail(f"{n} names {t!r}")
    if out.count("sendTransaction(") != 1 or out.count("new TxQueue(") != 1:
        fail("sessions.mjs must keep exactly one broadcast site and one queue")
    if OUTPUT_SESSIONS_SHA256 is None:
        if require_pinned:
            fail("--require-pinned: OUTPUT_SESSIONS_SHA256 is unset")
    elif OUTPUT_SESSIONS_SHA256 != sha(files["sessions.mjs"]):
        fail(f"output sessions.mjs sha256 {sha(files['sessions.mjs'])} != pinned {OUTPUT_SESSIONS_SHA256}")

    test_text = raw["activation.test.mjs"].decode("utf-8")
    for line in test_text.splitlines():
        s = line.strip()
        if s.startswith("import ") and " from " in s:
            spec = s.rsplit(" from ", 1)[1].strip().rstrip(";").strip("\"'")
            if not any(spec.startswith(p) for p in TEST_IMPORT_PREFIXES):
                fail(f"the copied suite imports {spec!r}, which may not resolve the same from here")

    links = {}
    for n in LINKS:
        t = os.path.realpath(SRC / n)
        if not os.path.isfile(t):
            fail(f"{SRC / n} does not resolve to a file")
        links[f"relay/{n}"] = t
    mt = os.path.realpath(SRC_MODULES)
    if not os.path.isdir(mt):
        fail(f"{SRC_MODULES} does not resolve to a directory")
    links["node_modules"] = mt
    return digests, files, raw["activation.test.mjs"], links


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--require-pinned", action="store_true")
    ap.add_argument("--check", action="store_true", help="write nothing; compare the existing outputs")
    a = ap.parse_args()
    digests, files, test_bytes, links = build(a.require_pinned)
    if a.check:
        bad = [n for n, b in files.items() if not (OUT / n).is_file() or (OUT / n).read_bytes() != b]
        if not OUT_TEST.is_file() or OUT_TEST.read_bytes() != test_bytes:
            bad.append("test/activation.test.mjs")
        bad += [k for k, t in links.items() if not (GEN / k).is_symlink() or os.path.realpath(GEN / k) != t]
        if bad:
            fail(f"--check: differs or missing: {', '.join(bad)}")
        print("prepare: --check OK")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    OUT_TEST.parent.mkdir(parents=True, exist_ok=True)
    for k, t in links.items():
        p = GEN / k
        if p.is_symlink():
            p.unlink()
        elif p.exists():
            fail(f"{p} exists and is not a symlink; not replacing it")
        p.symlink_to(t)
    for n, b in files.items():
        (OUT / n).write_bytes(b)
    OUT_TEST.write_bytes(test_bytes)
    manifest = {
        "schema": "relay-quarantine-r1-prepare", "flag": "SESSIONS_WRITE_QUARANTINE",
        "inputs": {n: digests[n] for n in INPUTS},
        "copiedSuite": {"from": "activation-r1/test/activation.test.mjs", "sha256": digests["activation.test.mjs"]},
        "outputs": {f"relay/{n}": sha(b) for n, b in files.items()},
        "symlinks": links, "hunks": len(hunks(digests["sessions.mjs"])),
        "unchangedCopies": [n for n in INPUTS if n != "sessions.mjs"],
    }
    (GEN / "PREPARE-MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps(manifest["outputs"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
