#!/usr/bin/env python3
"""native-host-r1/prepare.py - deterministic staging for test/native-host.test.mjs. Compiles nothing, runs nothing.

Resolves every contract artifact the native fixture deploys (session-r1/out, plus the ONE labelled fixture mock in
fixture/out) by its compilation target, refuses missing or ambiguous ones, resolves their library links, hashes the
composed successor relay sources and the client codec the test imports, and checks that `viem` resolves for the test the
same way it resolves for the generated relay. Writes generated/FIXTURE-STAGING.json (sorted, no timestamps).

  python3 prepare.py           write generated/FIXTURE-STAGING.json (and node_modules -> the relay's, if needed)
  python3 prepare.py --check   recompute and require byte equality with the file on disk; writes nothing
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UF = HERE.parent
SESSION_OUT = UF / "session-candidate" / "out"
FIXTURE_OUT = HERE / "fixture" / "out"
RELAY = UF / "successor-host-candidate" / "generated" / "relay"
CODEC = UF / "client-candidate" / "funding-codec.mjs"
STAGE = HERE / "generated" / "FIXTURE-STAGING.json"

MOCKS = "contracts/foundry/test/mocks/SessionMocks.sol"
DEX_MOCKS = "dex-candidate/test/mocks/DexMocks.sol"
# (id, contract, compilation-target suffix, out dir). Mirrors session-r1/test/FundingRig.sol setUp.
REQUIRED = [
    ("usdc", "MockUSDC3009", MOCKS, SESSION_OUT),
    ("registryStub", "SessionRegistryStub", MOCKS, SESSION_OUT),
    ("keyAttestations", "MockKeyAttestations", MOCKS, SESSION_OUT),
    ("book", "EnclaveAddressBook", "contracts/EnclaveAddressBook.sol", SESSION_OUT),
    ("ledger", "EnclaveDeployments", "contracts/EnclaveDeployments.sol", SESSION_OUT),
    ("catalog", "EnclaveAppCatalog", "contracts/EnclaveAppCatalog.sol", SESSION_OUT),
    ("paymentRouter", "PaymentRouter", "contracts/PaymentRouter.sol", SESSION_OUT),
    ("reserve", "EnclaveLeaseGasReserve", "rfq-candidate/test/fixtures/EnclaveLeaseGasReserve.sol", SESSION_OUT),
    ("legacyFactory", "SessionVaultFactory", "contracts/SessionVault.sol", SESSION_OUT),
    ("weth", "MockWETH9", DEX_MOCKS, SESSION_OUT),
    ("dexFactory", "MockV3Factory", DEX_MOCKS, SESSION_OUT),
    ("swapRouter", "MockSwapRouter02", DEX_MOCKS, SESSION_OUT),
    ("adapter", "LeaseGasDexAdapter", "dex-candidate/src/LeaseGasDexAdapter.sol", SESSION_OUT),
    ("fundingGasLib", "FundingGasLib", "src/FundingGasLib.sol", SESSION_OUT),
    ("fundingSessionVaultLib", "FundingSessionVaultLib", "src/FundingSessionVault.sol", SESSION_OUT),
    ("factory", "FundingSessionVaultFactory", "src/FundingSessionVault.sol", SESSION_OUT),
    ("implementation", "FundingSessionVault", "src/FundingSessionVault.sol", SESSION_OUT),
    ("quoter", "MockQuoterV2", "src/MockQuoterV2.sol", FIXTURE_OUT),
]


class Refused(Exception):
    pass


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def rel(p):
    return Path(os.path.relpath(p, UF)).as_posix()


def target_of(j):
    md = j.get("metadata")
    if isinstance(md, str):
        try:
            md = json.loads(md)
        except ValueError:
            md = None
    if isinstance(md, dict):
        ct = (md.get("settings") or {}).get("compilationTarget")
        if isinstance(ct, dict) and len(ct) == 1:
            ((p, n),) = ct.items()
            return p.replace("\\", "/"), n, ((md.get("sources") or {}).get(p) or {}).get("keccak256")
    ast = j.get("ast")
    if isinstance(ast, dict) and isinstance(ast.get("absolutePath"), str):
        return ast["absolutePath"].replace("\\", "/"), None, None
    return None, None, None


_index = {}


def index(out_dir):
    if out_dir in _index:
        return _index[out_dir]
    if not out_dir.is_dir():
        raise Refused(f"missing artifact directory {rel(out_dir)}")
    rows = []
    for p in sorted(out_dir.rglob("*.json")):
        if "build-info" in p.parts:
            continue
        try:
            j = json.loads(p.read_text())
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(j, dict) or "bytecode" not in j:
            continue
        t, n, k = target_of(j)
        rows.append({"path": p, "name": p.stem, "target": t, "targetName": n, "sourceKeccak256": k, "json": j})
    _index[out_dir] = rows
    return rows


def pick(contract, match, out_dir, what):
    c = [r for r in index(out_dir) if r["name"] == contract and r["target"] is not None and match(r["target"])
         and r["targetName"] in (None, contract)]
    if not c:
        hint = " (root: cd native-host-r1/fixture && forge build --offline, through the shared queue)" if out_dir == FIXTURE_OUT else ""
        raise Refused(f"missing artifact {contract} for {what} in {rel(out_dir)}{hint}")
    if len(c) > 1:
        # Root-selected artifacts from the reviewed session build, with exact file hashes.
        selected = {
            "ledger": ("EnclaveDeployments.sol/EnclaveDeployments.json", "75b5977444af986580116a42e883e437acc81ca43dc8f50bbd9cbde6e8dc9583"),
            "adapter": ("LeaseGasDexAdapter.sol/LeaseGasDexAdapter.json", "b342f6e982d902df2e12f7593cd8eb13be62099ce30ff2cc72ba388a9f0a7cd4"),
        }.get(what)
        if selected:
            c = [r for r in c if r["path"] == out_dir / selected[0] and sha256(r["path"]) == selected[1]]
        if len(c) != 1:
            raise Refused(f"ambiguous or changed artifact {contract} for {what}")
    r = c[0]
    obj = ((r["json"].get("bytecode") or {}).get("object") or "")
    if obj in ("", "0x"):
        raise Refused(f"{rel(r['path'])} has no creation bytecode")
    return r


def entry(r):
    return {"path": rel(r["path"]), "sha256": sha256(r["path"]), "contract": r["name"], "target": r["target"],
            "sourceKeccak256": r["sourceKeccak256"]}


def relative_imports(p):
    src = p.read_text()
    out = set(re.findall(r'from\s+"(\.{1,2}/[^"]+)"', src)) | set(re.findall(r'import\(\s*"(\.{1,2}/[^"]+)"\s*\)', src))
    return sorted(out)


def node_modules_for(start, pkg):
    d = start
    while True:
        nm = d / "node_modules"
        if (nm / pkg / "package.json").is_file():
            return nm.resolve()
        if d.parent == d:
            return None
        d = d.parent


def build(check):
    st = {"schema": "native-host-r1-staging/v1",
          "note": "inputs of test/native-host.test.mjs; written by prepare.py, nothing compiled or run by it; root pins",
          "artifacts": {}, "links": {}, "relay": {}, "client": {}, "fixtureSources": {}}
    for rid, contract, suffix, out_dir in REQUIRED:
        r = pick(contract, lambda t, s=suffix: t == s or t.endswith("/" + s), out_dir, rid)
        st["artifacts"][rid] = entry(r)
    # library links, transitively, resolved by the exact source path the linkReferences name
    todo = list(st["artifacts"].values())
    while todo:
        e = todo.pop()
        j = json.loads((UF / e["path"]).read_text())
        out_dir = FIXTURE_OUT if (UF / e["path"]).is_relative_to(FIXTURE_OUT) else SESSION_OUT
        for kind in ("bytecode", "deployedBytecode"):
            for f, libs in sorted(((j.get(kind) or {}).get("linkReferences") or {}).items()):
                for n in sorted(libs):
                    key = f"{f}:{n}"
                    if key in st["links"]:
                        continue
                    r = pick(n, lambda t, ff=f: t == ff, out_dir, f"library {key}")
                    lid = f"lib:{key}"
                    st["artifacts"].setdefault(lid, entry(r))
                    st["links"][key] = lid
                    todo.append(st["artifacts"][lid])
    # the composed successor relay (consumed, never edited) and every relative module it imports
    if not RELAY.is_dir():
        raise Refused(f"missing {rel(RELAY)} (run successor-host-r1/prepare.py first)")
    for p in sorted(RELAY.glob("*.mjs")):
        st["relay"][rel(p)] = sha256(p)
    for p in sorted(RELAY.glob("*.mjs")):
        for spec in relative_imports(p):
            q = (p.parent / spec).resolve()
            if not q.is_file():
                raise Refused(f"{rel(p)} imports {spec}, which does not exist at {rel(q)}")
            st["relay"].setdefault(rel(q), sha256(q))
    for need in ("sessions.mjs", "funding-route.mjs", "funding-abi.mjs", "fee-policy.mjs"):
        if rel(RELAY / need) not in st["relay"]:
            raise Refused(f"missing {rel(RELAY / need)}")
    if not CODEC.is_file():
        raise Refused(f"missing {rel(CODEC)}")
    st["client"][rel(CODEC)] = sha256(CODEC)
    for spec in relative_imports(CODEC):
        q = (CODEC.parent / spec).resolve()
        if not q.is_file():
            raise Refused(f"{rel(CODEC)} imports {spec}, which does not exist")
        st["client"][rel(q)] = sha256(q)
    for p in (HERE / "fixture" / "src" / "MockQuoterV2.sol", HERE / "fixture" / "foundry.toml", HERE / "test" / "native-host.test.mjs"):
        if not p.is_file():
            raise Refused(f"missing {rel(p)}")
        st["fixtureSources"][rel(p)] = sha256(p)
    # viem: the test must load the SAME package the generated relay loads
    relay_nm = node_modules_for(RELAY, "viem")
    if relay_nm is None:
        raise Refused(f"viem does not resolve from {rel(RELAY)}: no node_modules/viem above it")
    # The reviewed stage codec imports this exact source package relatively.
    client_nm = (UF.parent.parent / "node_modules").resolve()
    if not (client_nm / "viem/package.json").is_file():
        raise Refused("stage codec's viem package is missing")
    if client_nm is None:
        raise Refused(f"viem does not resolve from {rel(CODEC.parent)}")
    link = HERE / "node_modules"
    test_nm = node_modules_for(HERE / "test", "viem")
    linked = None
    if test_nm != relay_nm:
        if link.exists() or link.is_symlink():
            raise Refused(f"{rel(link)} exists and resolves viem from {test_nm}, not the relay's {relay_nm}")
        if check:
            raise Refused(f"viem for the test resolves from {test_nm}, not {relay_nm}; run prepare.py (it links {rel(link)})")
        os.symlink(relay_nm, link, target_is_directory=True)
        test_nm = node_modules_for(HERE / "test", "viem")
    if link.is_symlink():
        linked = os.readlink(link)
    if test_nm != relay_nm:
        raise Refused(f"viem for the test still resolves from {test_nm}, not {relay_nm}")
    st["viem"] = {"relay": str(relay_nm), "client": str(client_nm), "test": str(test_nm), "nodeModulesLink": linked,
                  "version": json.loads((relay_nm / "viem" / "package.json").read_text()).get("version")}
    return json.dumps(st, sort_keys=True, indent=1) + "\n"


def main():
    check = "--check" in sys.argv[1:]
    try:
        text = build(check)
    except Refused as e:
        print(f"prepare.py: REFUSED: {e}", file=sys.stderr)
        return 2
    if check:
        if not STAGE.is_file() or STAGE.read_text() != text:
            print(f"prepare.py --check: {rel(STAGE)} differs from a fresh staging (re-run prepare.py)", file=sys.stderr)
            return 1
        print(f"prepare.py --check: {rel(STAGE)} matches")
        return 0
    STAGE.parent.mkdir(parents=True, exist_ok=True)
    STAGE.write_text(text)
    print(f"prepare.py: wrote {rel(STAGE)} sha256 {hashlib.sha256(text.encode()).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
