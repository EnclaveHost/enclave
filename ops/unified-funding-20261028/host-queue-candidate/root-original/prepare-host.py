#!/usr/bin/env python3
"""host-queue-r1 prepare-host.py. UNREVIEWED SOURCE: its author executed nothing.

Stages a deterministic, isolated LEGACY-HOST regression tree at host-queue-r1/host/ so the ORIGINAL sessions end-to-end
suite (source/test/sessions.test.mjs + its helper) runs against the PATCHED relay (prepare.py's sessions.mjs, with
relay-owner-r2's funding route + generated ABI) on a local anvil (chain 31337, public anvil dev keys only). Writes only
inside host-queue-r1/host/:

  host/relay/sessions.mjs, funding-route.mjs, funding-abi.mjs   prepare.py build() outputs (same bytes)
  host/relay/{sessions-abi.mjs,snp-verify.mjs,store.js,auth.js,sso.js}  symlinks -> source/relay (read-only)
  host/test/sessions.test.mjs          copy of the original with marked edits: prerequisites FAIL (never skip), the
                                       staged relay must be the patched copy, plus one appended journal check
  host/test/helpers/sessions-chain.mjs copy of the original helper with marked edits: REPO must be this staged tree,
                                       artifact() never runs forge (missing artifact = error), native P-256 only (no shim)
  host/contracts/foundry/out/...       EXACT byte copies of session-r1/out artifacts, only when every source the artifact
                                       was compiled from has the keccak256 of the ORIGINAL source file (solc metadata)
  host/{sdk/sessions/dist,site/js/lib/contract-linker.js,scripts/deploy-session-vault.mjs,deploy/ledger/EnclaveDeployments.sol,
        node_modules}                  symlinks -> source (read-only)
  host/HOST-STAGING.json               manifest: pins, artifact evidence, settings deviations, missing prerequisites

  python3 prepare-host.py [--accept-unpinned]          stage
  python3 prepare-host.py --check [--accept-unpinned]  write nothing; exit 1 if anything is missing or differs

Exit 1 (after staging what it can) when a required artifact or module is missing: the report names it. The original
test file and helper are not sha256-pinned here (their author could not compute hashes); --accept-unpinned records the
observed hashes in HOST-STAGING.json "unpinned" until the root pins TEST_SHA256 / HELPER_SHA256.
"""
import hashlib
import json
import os
import sys

STAGE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, STAGE)
import prepare  # noqa: E402  (this stage's own generator: same pins, same bytes)

HOST = os.path.join(STAGE, "host")
UF = prepare.UF
SOURCE = prepare.SOURCE
SESSION_R1 = os.path.join(UF, "session-r1")
SESSION_R1_OUT = os.path.join(SESSION_R1, "out")
WORK_ENCLAVE = os.path.normpath(os.path.join(UF, "..", "..", "enclave"))   # session-r1's remapped enclave checkout

TEST_SRC = os.path.join(SOURCE, "test", "sessions.test.mjs")
HELPER_SRC = os.path.join(SOURCE, "test", "helpers", "sessions-chain.mjs")
TEST_SHA256 = None       # root: pin after review; None needs --accept-unpinned
HELPER_SHA256 = None
MAX_ARTIFACT_BYTES = 32 * 1024 * 1024

MARK = "host-queue-r1"
O = f"// >>> {MARK}"
C = f"// <<< {MARK}\n"

TEST_EDITS = [
    ("replace",
     'const skip = !haveFoundry() || !fs.existsSync(new URL("../sdk/sessions/dist/node.mjs", import.meta.url))\n'
     '  ? "needs Foundry (anvil + forge) and a built SDK (cd sdk/sessions && npm run build)" : false;\n',
     f"{O} (staged copy): a missing prerequisite FAILS this run, it never skips it\n"
     'if (!haveFoundry()) throw new Error("needs Foundry (anvil + forge) on PATH; this staged run refuses to skip");\n'
     'if (!fs.existsSync(new URL("../sdk/sessions/dist/node.mjs", import.meta.url))) throw new Error("needs the built SDK (sdk/sessions/dist)");\n'
     "const skip = false;\n" + C),
    ("after",
     'import * as sdk from "../sdk/sessions/dist/node.mjs";\n',
     f"{O} (staged copy): the relay under test is the PATCHED copy, not the original\n"
     'assert.ok(fs.readFileSync(new URL("../relay/sessions.mjs", import.meta.url), "utf8").includes("// >>> host-queue-r1 TxQueue"),\n'
     '  "the staged relay/sessions.mjs is not the host-queue-r1 patched copy");\n' + C),
    ("append", None,
     f"\n{O} (staged copy): every transaction the main relay sent completed on a canonical receipt for its own hash\n"
     'test("host-queue-r1: every relayed transaction completed canonically (anvil; canonical at observation, not finality)", () => {\n'
     "  const txs = stores[1].data.txs;\n"
     '  assert.ok(txs.length > 0, "the relay sent nothing");\n'
     "  for (const t of txs) {\n"
     '    assert.ok(t.status === "mined" || t.status === "reverted", `${t.label}: ${t.status}`);\n'
     '    assert.equal(t.finality, "canonical_at_observation", t.label);\n'
     "    assert.match(t.blockHash, /^0x[0-9a-fA-F]{64}$/, t.label);\n"
     "    assert.notEqual(BigInt(t.blockHash), 0n, t.label);\n"
     "    assert.ok(t.hashes.map((h) => h.toLowerCase()).includes(t.hash.toLowerCase()), t.label);\n"
     "  }\n"
     "});\n" + C),
]

HELPER_EDITS = [
    ("after",
     'const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");\n',
     f"{O} (staged copy): REPO is the tree prepare-host.py staged, never a source checkout\n"
     'if (!fs.existsSync(path.join(REPO, "HOST-STAGING.json"))) throw new Error(`${REPO} is not a host-queue-r1 staged tree (no HOST-STAGING.json)`);\n'
     + C),
    ("replace",
     '  if (!fs.existsSync(p)) execFileSync("forge", ["build"], { cwd: REPO, stdio: "ignore" });\n',
     f"  {O} (staged copy): never build here; prepare-host.py stages verified artifacts or reports them missing\n"
     "  if (!fs.existsSync(p)) throw new Error(`missing artifact ${path.relative(REPO, p)}: see HOST-STAGING.json (no forge build in this run)`);\n"
     f"  {C}"),
    ("replace",
     "  if (!ok?.data || BigInt(ok.data) !== 1n) {\n"
     '    const code = fs.readFileSync(path.join(REPO, "contracts/foundry/test/fixtures/p256-verifier.hex"), "utf8").trim();\n'
     '    await pc.request({ method: "anvil_setCode", params: ["0x0000000000000000000000000000000000000100", code.startsWith("0x") ? code : "0x" + code] });\n'
     "  }\n",
     f"  {O} (staged copy): the NATIVE precompile or nothing - no verifier shim is ever installed\n"
     "  const one = (d) => typeof d === \"string\" && /^0x0*1$/.test(d);\n"
     "  const tampered = probe.slice(0, 130) + (probe.slice(130, 132) === \"00\" ? \"01\" : \"00\") + probe.slice(132);\n"
     '  const bad = await pc.call({ to: "0x0000000000000000000000000000000000000100", data: tampered }).catch(() => ({}));\n'
     '  const etched = await pc.getCode({ address: "0x0000000000000000000000000000000000000100" });\n'
     '  if (!one(ok?.data) || one(bad?.data) || (etched && etched !== "0x")) {\n'
     '    proc.kill("SIGKILL");\n'
     '    throw new Error("this anvil has no native P-256 precompile at 0x100 (needs --hardfork osaka); the verifier shim is refused");\n'
     "  }\n"
     f"  {C}"),
]

# (out-relative dir, contract name, the ORIGINAL source it must be compiled from, required?)
ARTIFACTS = [
    ("SessionMocks.sol", "MockUSDC3009", "contracts/foundry/test/mocks/SessionMocks.sol", True),
    ("SessionMocks.sol", "SessionRegistryStub", "contracts/foundry/test/mocks/SessionMocks.sol", True),
    ("EnclaveAddressBook.sol", "EnclaveAddressBook", "contracts/EnclaveAddressBook.sol", True),
    ("EnclaveAppCatalog.sol", "EnclaveAppCatalog", "contracts/EnclaveAppCatalog.sol", True),
    ("PaymentRouter.sol", "PaymentRouter", "contracts/PaymentRouter.sol", True),
    # rev 16, read by the wallet-records test (deployedBytecode); deployPlatform's default ledger is solc-js rev 15d
    ("EnclaveDeployments.sol", "EnclaveDeployments", "contracts/EnclaveDeployments.sol", True),
    # only deployPlatform({ ledger: "contracts" }) needs it; sessions.test.mjs never asks for that
    ("EnclaveDeployments.sol", "EnclaveLedgerBandwidth", "contracts/EnclaveDeployments.sol", False),
]
# source/foundry.toml: runs 200 except these (runs 1); via_ir everywhere; solc 0.8.35
ORIGINAL_RUNS_1 = {"contracts/EnclaveDeployments.sol", "deploy/ledger/EnclaveDeployments.sol", "contracts/SessionVault.sol"}

LINKS = {   # host path -> source path (read-only)
    "node_modules": "node_modules",
    "relay/sessions-abi.mjs": "relay/sessions-abi.mjs",
    "relay/snp-verify.mjs": "relay/snp-verify.mjs",
    "relay/store.js": "relay/store.js",
    "relay/auth.js": "relay/auth.js",
    "relay/sso.js": "relay/sso.js",
    "sdk/sessions/dist": "sdk/sessions/dist",
    "site/js/lib/contract-linker.js": "site/js/lib/contract-linker.js",
    "scripts/deploy-session-vault.mjs": "scripts/deploy-session-vault.mjs",
    "deploy/ledger/EnclaveDeployments.sol": "deploy/ledger/EnclaveDeployments.sol",
}
MODULES = ["viem", "solc", "jose", "@simplewebauthn/server"]   # resolved from source/node_modules by the staged files

# ---- keccak256 (solc metadata hashes sources with it; hashlib's sha3_256 is NOT keccak) --------------------------------
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
       0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
       0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M64 = (1 << 64) - 1


def _rol(v, n):
    return ((v << n) | (v >> (64 - n))) & _M64


def _keccak_f(A):
    for rc in _RC:
        Cx = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [Cx[(x - 1) % 5] ^ _rol(Cx[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A


def keccak256(data):
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            A[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i:off + 8 * i + 8], "little")
        A = _keccak_f(A)
    return "0x" + b"".join(A[i % 5][i // 5].to_bytes(8, "little") for i in range(4)).hex()


def die(m):
    sys.stderr.write(f"prepare-host.py: {m}\n")
    sys.exit(1)


if keccak256(b"") != "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" \
        or keccak256(b"transfer(address,uint256)")[:10] != "0xa9059cbb":
    die("the built-in keccak256 fails its known vectors; refusing to verify anything with it")

sha256 = prepare.sha256
read = prepare.read


def edit(text, edits, label):
    for kind, anchor, block in edits:
        if kind == "append":
            text = text + block
            continue
        n = text.count(anchor)
        if n != 1:
            die(f"{label}: anchor occurs {n} times (must be exactly once): {anchor.strip()[:90]}")
        text = text.replace(anchor, block if kind == "replace" else anchor + block, 1)
    return text


def source_of(key):
    """The ORIGINAL source file a solc metadata source key names: session-r1 compiled the enclave checkout's contracts
    (remapped from ../../../enclave); the original is source/<same relative path>. None when it is neither."""
    p = os.path.normpath(key if os.path.isabs(key) else os.path.join(SESSION_R1, key))
    for root in (WORK_ENCLAVE, SOURCE):
        if p.startswith(root + os.sep):
            return os.path.relpath(p, root)
    return None


_kcache = {}


def verify_artifact(path, name, want_src):
    """(bytes, evidence) when `path` is `name` compiled from the ORIGINAL `want_src` and every source it lists matches
    the original byte for byte (keccak256); else (None, why)."""
    if not os.path.isfile(path):
        return None, "absent"
    if os.path.getsize(path) > MAX_ARTIFACT_BYTES:
        return None, f"larger than {MAX_ARTIFACT_BYTES} bytes"
    raw = read(path)
    try:
        j = json.loads(raw)
    except ValueError as e:
        return None, f"not JSON: {e}"
    md = j.get("metadata") or {}
    st = md.get("settings") or {}
    tgt = st.get("compilationTarget") or {}
    if len(tgt) != 1:
        return None, "no single compilationTarget"
    (tkey, tname), = tgt.items()
    if tname != name or source_of(tkey) != want_src:
        return None, f"compiled target is {tkey}:{tname}, not {want_src}:{name}"
    srcs = md.get("sources") or {}
    if not srcs:
        return None, "metadata lists no sources"
    checked = {}
    for k, v in sorted(srcs.items()):
        rel = source_of(k)
        if rel is None:
            return None, f"source {k} is outside the enclave checkout / source tree"
        orig = os.path.join(SOURCE, rel)
        if not os.path.isfile(orig):
            return None, f"source {rel} does not exist in the original tree"
        if orig not in _kcache:
            _kcache[orig] = keccak256(read(orig))
        if (v or {}).get("keccak256", "").lower() != _kcache[orig]:
            return None, f"source {rel} differs from the original (keccak256 {v.get('keccak256')} vs {_kcache[orig]})"
        checked[rel] = _kcache[orig]
    if not isinstance(j.get("abi"), list) or not isinstance((j.get("bytecode") or {}).get("object"), str) \
            or not isinstance((j.get("deployedBytecode") or {}).get("object"), str):
        return None, "no abi / bytecode / deployedBytecode"
    opt = st.get("optimizer") or {}
    got = {"solc": (md.get("compiler") or {}).get("version"), "runs": opt.get("runs"), "viaIR": st.get("viaIR"),
           "evmVersion": st.get("evmVersion")}
    want = {"solc": "0.8.35", "runs": 1 if want_src in ORIGINAL_RUNS_1 else 200, "viaIR": True}
    deviations = []
    if not str(got["solc"] or "").startswith("0.8.35"):
        deviations.append(f"solc {got['solc']} (original 0.8.35)")
    if got["runs"] != want["runs"]:
        deviations.append(f"optimizer runs {got['runs']} (original foundry.toml {want['runs']})")
    if got["viaIR"] is not True:
        deviations.append("viaIR off (original on)")
    return raw, {"from": os.path.relpath(path, UF), "sha256": sha256(raw), "target": f"{want_src}:{name}", "sources": checked,
                 "settings": got, "deviationsFromOriginalFoundryToml": deviations}


def build(accept_unpinned):
    outputs_p, _ = prepare.build(accept_unpinned)
    files, links, unpinned, missing, evidence = {}, {}, {}, [], {}
    for f in ("sessions.mjs", "funding-route.mjs", "funding-abi.mjs"):
        files[f"relay/{f}"] = outputs_p[f"patched/relay/{f}"]
    pin_list = [(TEST_SRC, TEST_SHA256, "source/test/sessions.test.mjs"), (HELPER_SRC, HELPER_SHA256, "source/test/helpers/sessions-chain.mjs")]
    for path, pin, label in pin_list:
        h = sha256(read(path))
        if pin is None:
            unpinned[label] = h
            if not accept_unpinned:
                die(f"{label} is not pinned (observed sha256 {h}): review it, pin it, or pass --accept-unpinned")
        elif h != pin:
            die(f"{label} sha256 {h} is not the pinned {pin}")
    files["test/sessions.test.mjs"] = edit(read(TEST_SRC).decode(), TEST_EDITS, "sessions.test.mjs").encode()
    files["test/helpers/sessions-chain.mjs"] = edit(read(HELPER_SRC).decode(), HELPER_EDITS, "sessions-chain.mjs").encode()
    for d, name, want_src, required in ARTIFACTS:
        why = []
        for cand in (os.path.join(SESSION_R1_OUT, d, f"{name}.json"), os.path.join(SESSION_R1_OUT, "contracts", d, f"{name}.json")):
            raw, ev = verify_artifact(cand, name, want_src)
            if raw is not None:
                files[f"contracts/foundry/out/{d}/{name}.json"] = raw
                evidence[f"{d}/{name}"] = ev
                break
            why.append(f"{os.path.relpath(cand, UF)}: {ev}")
        else:
            entry = {"artifact": f"contracts/foundry/out/{d}/{name}.json", "required": required, "why": why}
            (missing.append(entry) if required else evidence.setdefault("notStaged", []).append(entry))
    for host_rel, src_rel in sorted(LINKS.items()):
        target = os.path.join(SOURCE, src_rel)
        if not os.path.exists(target):
            missing.append({"link": host_rel, "required": True, "why": [f"source/{src_rel} does not exist"]})
            continue
        links[host_rel] = os.path.relpath(target, os.path.dirname(os.path.join(HOST, host_rel)))
    for m in MODULES:
        if not os.path.isfile(os.path.join(SOURCE, "node_modules", *m.split("/"), "package.json")):
            missing.append({"module": m, "required": True, "why": ["not installed in source/node_modules"]})
    manifest = {
        "stage": "host-queue-r1 legacy-host regression tree (source only until the root runs it)",
        "chain": "local anvil, chain 31337, --hardfork osaka, native P-256 required, public anvil dev keys only",
        "source": {"relay/sessions.mjs": prepare.SOURCE_SESSIONS_SHA256, "test/sessions.test.mjs": sha256(read(TEST_SRC)),
                   "test/helpers/sessions-chain.mjs": sha256(read(HELPER_SRC))},
        "patched": {k: sha256(v) for k, v in sorted(outputs_p.items()) if k.startswith("patched/")},
        "unpinned": {**unpinned, **json.loads(outputs_p["generated/PREPARE-MANIFEST.json"])["unpinned"]},
        "files": {k: sha256(v) for k, v in sorted(files.items())},
        "symlinks": links,
        "artifacts": evidence,
        "missing": missing,
    }
    files["HOST-STAGING.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return files, links, missing


def main():
    args = sys.argv[1:]
    unknown = [a for a in args if a not in ("--check", "--accept-unpinned")]
    if unknown:
        die(f"unknown arguments {unknown}")
    check = "--check" in args
    if os.path.islink(HOST):
        die("host/ is a symlink; refusing")
    files, links, missing = build("--accept-unpinned" in args)
    stale = prepare.write_outputs(HOST, {k: v for k, v in files.items()}, links, check)
    if check and stale:
        die("host/ outputs missing or stale: " + ", ".join(stale))
    if missing:
        die("missing prerequisites (see host/HOST-STAGING.json \"missing\"): "
            + "; ".join(m.get("artifact") or m.get("link") or m.get("module") for m in missing))
    print("prepare-host.py --check: all outputs current" if check else "prepare-host.py: staged host/")


if __name__ == "__main__":
    main()
