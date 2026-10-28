#!/usr/bin/env python3
"""production-grant-terms-r1 owned TEST fixture generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 production-grant-terms-r1/fixture/generate_fixture.py

Derives the native/browser TEST fixture for the NEW gas candidate gas-recovery-6usdc-r1 from the root-generated
client-execution-site-r2 harness (its out/server.mjs, shell, build driver and page shell), every input sha256-pinned in
generated/FIXTURE-GEN-PINS.json (root-confirmed; null, drift or rootConfirmed != true refuses). Writes ONLY
production-grant-terms-r1/{out,shell,build,page}/ (the same layout as client-execution-site-r2, so the server's and the
build driver's HERE/UF derivation is unchanged) and refuses if any of them exists. All edits are labelled
"production-grant-terms-r1"; reversing them must give back each pinned input exactly.

  out/server.mjs   + TEST split 24 / 4.8 (16 ops) / 1.2 (4 ops)   (was 29 / 0.8 / 0.2)
                   + ETH_OUT 2e14 wei = the candidate's maxEthPerOp (was 2e13): every page quote / Fund / recovery phase
                     (9, 12-16) then performs an ACTUAL successful 2e14-wei gas.fund on the owned chain at the fixed
                     TEST price 2400 USDC/ETH (+100 bps max input = 484800 <= the 500000 price cap; fee 25000 <= 80000)
                   + temp-dir prefix. Everything else - owned Anvil 8453/osaka, public Anvil keys, mock USDC, the dropped
                     first gas-open reply, the one-shot execute "body" / "gateway502" faults, intake-off fault, CSP,
                     loopback Host pin, owned-PID-only cleanup - is the pinned server byte for byte.
  shell/main.mjs   the TEST-terms checks name 24 / 4.8 / 1.2 (and 24 + 6 = 30), the journaled terms must carry the exact
                   NEW candidate literals (terms.gasCandidate, every part's caps), pFund checks the settled call bought
                   exactly 2e14 wei. The page under test stays client-execution-site-r2/candidate (unchanged).
  shell/facade/config.js   one comment (the TEST split it describes).  Other shell files: byte for byte.
  build/build-harness.mjs  one provenance comment line.   page/index.html  titles and one sentence.

NOT produced here (root, separately, after review): the successor vendor bundle built from candidate/sdk/funding,
page/dist/harness.js (build/build-harness.mjs), generated/BUILD-PINS.json and generated/HARNESS-INPUTS.json (templates
in generated/*.template.json). The server and build driver refuse to start until those are root-filled.
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # production-grant-terms-r1
UF = HERE.parent                                        # unified-funding-20261028
M = "production-grant-terms-r1"
B = "client-execution-site-r2"
CID = "gas-recovery-6usdc-r1"
FACADES = ["api.js", "wallet.js", "empty.js", "sessions.js", "vendor-funding.js"]
COPIES = {f"{B}/shell/harness-state.js": "shell/harness-state.js", **{f"{B}/shell/facade/{f}": f"shell/facade/{f}" for f in FACADES}}
INPUTS = [f"{B}/out/server.mjs", f"{B}/shell/main.mjs", f"{B}/build/build-harness.mjs", f"{B}/page/index.html",
          f"{B}/shell/facade/config.js", *COPIES]
OUTDIRS = ["out", "shell", "build", "page"]
GUARD = '  if (args.some((a) => /code-size|disable-code-size/.test(a))) fail("no code-size override");'
ANVIL_KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
              "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
              "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"]


def sub(a, b):
    return (a, b)


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


SERVER_EDITS = [
    before('// DERIVED by client-execution-site-r2/harness/generate_harness.py from client-site-browser-r1/out/server.mjs (pinned). Lines marked "client-execution-site-r2" are the only\n',
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/out/server.mjs (pinned). Lines marked \"" + M + "\"\n"
           "// are the only changes: the TEST split 24 / 4.8 / 1.2 and ETH_OUT 2e14 for the NEW gas candidate " + CID + ".\n"
           "// TEST ONLY: owned Anvil, public Anvil keys, mock USDC. No real wallet, no Base, no production terms or approval.\n"),
    sub('"..");         // client-execution-site-r2 (this file is out/server.mjs)\n', '"..");         // ' + M + ' (this file is out/server.mjs)\n'),
    sub("const ETH_OUT = 20_000_000_000_000n;\n",
        "const ETH_OUT = 200_000_000_000_000n;               // " + M + ": the NEW candidate's maxEthPerOp (actual ~2e14 top-ups)\n"),
    sub('owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-execution-site-r2-"));',
        'owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "' + M + '-"));'),
    sub('  split: { legacy6: "29000000", nucbox6: "800000", nucboxOps: "16", metal6: "200000", metalOps: "4" },\n',
        '  split: { legacy6: "24000000", nucbox6: "4800000", nucboxOps: "16", metal6: "1200000", metalOps: "4" },   // ' + M + ': NEW TEST split\n'),
]
SERVER_KEEP = ['"--chain-id", "8453", "--hardfork", "osaka"', '"--slots-in-an-epoch", "1"', "if (req.headers.host !== here)",
               "let dropFirstFundingOpen = true;", "maxSeconds must be 30..1800", 'owned.server.listen(port, "127.0.0.1"',
               "const PRICE6 = 2_400_000_000n;", "const FEE = 25_000n;", "maxSlippageBps: 100", "const MAX_PROMPTS = 24;",
               'if (p === "/test/fixture/execute-fault") {', 'if (body.mode !== "body" && body.mode !== "gateway502")',
               'await write(usdc, "fiatUsdc", "mint", [owner, 1_000_000_000n]);                 // mock funds only',
               "const adapter = await deploy(\"adapter\", [usdc, weth, swapRouter, v3, ledger, reserve, 50_000_000_000_000_000n]);"]

MAIN_EDITS = [
    before("// DERIVED by client-execution-site-r2/harness/generate_harness.py from client-site-browser-r1/shell/main.mjs (pinned): the page is now the GENERATED\n",
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/shell/main.mjs (pinned). Lines marked \"" + M + "\"\n"
           "// are the only changes: the TEST terms are the NEW candidate " + CID + " split 24 / 4.8 / 1.2 and its exact literals.\n"),
    sub("/** The journaled plan must be EXACTLY the TEST terms (30 -> 29 / 0.8 / 0.2, finite 8 + 2, same key) and hash to its\n",
        "/** The journaled plan must be EXACTLY the TEST terms (30 -> 24 / 4.8 / 1.2, finite 8 + 2, same key) and hash to its   (" + M + ")\n"),
    sub('  check(t.split.legacy6 === "29000000" && t.split.gas6 === "1000000" && t.split.total6 === "30000000", "split 29 + 1 = 30");\n',
        '  check(t.split.legacy6 === "24000000" && t.split.gas6 === "6000000" && t.split.total6 === "30000000", "split 24 + 6 = 30");   // ' + M + '\n'),
    sub('  check(JSON.stringify(parts) === JSON.stringify([["nucbox", "800000", "16", [...fx.partition.nucbox].sort().join()],\n'
        '    ["metal", "200000", "4", [...fx.partition.metal].sort().join()]]), "gas parts: nucbox 0.8 / 16 ops / 8 apps, metal 0.2 / 4 ops / 2 apps");\n',
        '  check(JSON.stringify(parts) === JSON.stringify([["nucbox", "4800000", "16", [...fx.partition.nucbox].sort().join()],   // ' + M + '\n'
        '    ["metal", "1200000", "4", [...fx.partition.metal].sort().join()]]), "gas parts: nucbox 4.8 / 16 ops / 8 apps, metal 1.2 / 4 ops / 2 apps");\n'),
    after('  check(!t.gas.parts.some((p) => p.appIds.includes("*")), "no gas wildcard");\n',
          '  const NEW_CANDIDATE = { id: "' + CID + '", budget: "6000000", spendPerPeriod: "6000000", periodSeconds: "86400", opsPerPeriod: "20",\n'
          '    maxFeePerOp: "80000", maxGasUsdcPerOp: "600000", maxUsdcPerEth6: "2500000000", maxEthPerOp: "200000000000000" };   // ' + M + '\n'
          '  check(Object.entries(NEW_CANDIDATE).every(([k, v]) => t.gasCandidate?.[k] === v), "terms carry the exact NEW candidate literals");   // ' + M + '\n'
          '  check(t.gas.parts.every((p) => p.grantTemplate.maxFeePerOp === "80000" && p.grantTemplate.maxGasUsdcPerOp === "600000"   // ' + M + '\n'
          '    && p.grantTemplate.maxEthPerOp === "200000000000000" && p.grantTemplate.maxUsdcPerEth6 === "2500000000"\n'
          '    && p.grantTemplate.spendPerPeriod === p.budget6 && p.grantTemplate.budget === p.budget6), "each part grant: the candidate caps, its own budget per period");\n'),
    sub('  check(text("#fdMig").includes("proposed, not prepared") && text("#fdMig").includes("$29.00") && text("#fdMig").includes("$0.80")\n'
        '    && text("#fdMig").includes("$0.20"), "page shows the proposed 29 / 0.80 / 0.20 split");\n',
        '  check(text("#fdMig").includes("proposed, not prepared") && text("#fdMig").includes("$24.00") && text("#fdMig").includes("$4.80")   // ' + M + '\n'
        '    && text("#fdMig").includes("$1.20"), "page shows the proposed 24 / 4.80 / 1.20 split");\n'),
    sub('  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) - OLD_BUDGET, "owner wallet down exactly 30 since Start (30 refunded, 29 + 0.8 + 0.2 out)");\n',
        '  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) - OLD_BUDGET, "owner wallet down exactly 30 since Start (30 refunded, 24 + 4.8 + 1.2 out)");   // ' + M + '\n'),
    sub('  check(await usdcOf(fx, fx.legacyVault) === 29_000_000n && await usdcOf(fx, fx.vault) === 1_000_000n, "legacy vault 29, successor vault 1");\n',
        '  check(await usdcOf(fx, fx.legacyVault) === 24_000_000n && await usdcOf(fx, fx.vault) === 6_000_000n, "legacy vault 24, successor vault 6");   // ' + M + '\n'),
    sub('&& g1.balance6 === "800000", "nucbox: its 8 apps, no wildcard, 0.8");\n',
        '&& g1.balance6 === "4800000", "nucbox: its 8 apps, no wildcard, 4.8");   // ' + M + '\n'),
    sub('&& g2.balance6 === "200000", "metal: its 2 apps, no wildcard, 0.2");\n',
        '&& g2.balance6 === "1200000", "metal: its 2 apps, no wildcard, 1.2");   // ' + M + '\n'),
    before('  advance("funded", "funded the selected inputs through the page");\n',
           '  check(e.call.intent.ethOut === fx.ethOut && fx.ethOut === "200000000000000", "the settled call bought exactly 2e14 wei (the candidate maxEthPerOp)");   // ' + M + '\n'),
]
CONFIG_EDITS = [
    sub("//   FUNDING_MIGRATION_PROPOSAL the TEST 29 / 0.8 / 0.2 split over the fixture's 8 + 2 apps for this run's original sid\n",
        "//   FUNDING_MIGRATION_PROPOSAL the TEST 24 / 4.8 / 1.2 split over the fixture's 8 + 2 apps for this run's original sid (" + M + ")\n"),
]
BUILD_EDITS = [
    after("#!/usr/bin/env node\n",
          "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/build/build-harness.mjs (pinned); only this line differs.\n"),
]
PAGE_EDITS = [
    sub("<title>TEST ONLY - client-execution-site-r2 /funding recovery page harness</title>",
        "<title>TEST ONLY - " + M + " /funding recovery page harness (NEW TEST terms 24 / 4.8 / 1.2)</title>"),
    sub("<h1>TEST ONLY: generated /funding recovery page copy on an owned fixture (client-execution-site-r2)</h1>",
        "<h1>TEST ONLY: generated /funding recovery page copy on an owned fixture (" + M + ", gas candidate " + CID + ")</h1>"),
    sub("Public Anvil fixture keys, mock USDC, TEST terms only.</strong>",
        "Public Anvil fixture keys, mock USDC, TEST terms only (NEW gas candidate " + CID + ": 24 legacy / 4.8 nucbox / 1.2 metal).</strong>"),
]
# the fixed TEST economics the edited checks rely on (asserted, never assumed)
PRICE6, FEE6, SLIP_BPS, ETH_OUT, PRICE_CAP6, GAS_CAP6, FEE_CAP6 = 2_400_000_000, 25_000, 100, 200_000_000_000_000, 2_500_000_000, 600_000, 80_000


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_fixture.py: {m}")


def apply(text, edits, what):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"{what}: anchor occurs {new.count(a)} times (expected 1): {a[:80]!r}")
        if a not in b and new.count(b) != 0:
            die(f"{what}: replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"{what}: replacement occurs {back.count(b)} times: {b[:80]!r}")
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: reversing the edits does not give back the pinned source exactly")
    return new


def main():
    if sys.argv[1:]:
        die("no arguments")
    pins = json.loads((HERE / "generated" / "FIXTURE-GEN-PINS.json").read_text())
    if pins.get("rootConfirmed") is not True:
        die("FIXTURE-GEN-PINS.json rootConfirmed is not true: root must hash the inputs independently first")
    if set(pins["inputs"]) != set(INPUTS):
        die(f"FIXTURE-GEN-PINS.json must list exactly {sorted(INPUTS)}")
    src = {}
    for rel, want in pins["inputs"].items():
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
            die(f"{rel}: no root-filled sha256 (refusing)")
        b = (UF / rel).read_bytes()
        if sha(b) != want:
            die(f"{rel}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[rel] = b
    for d in OUTDIRS:
        if (HERE / d).exists():
            die(f"{d}/ already exists; inspect or move it first (nothing is overwritten)")
    if not (HERE / "candidate" / "GENERATED.json").exists():
        die("generate the SDK candidate first (generator/generate_sdk.py); the fixture qualifies that candidate")

    # the TEST economics: one 2e14-wei op at the fixed TEST price fits every NEW cap, and the old cap would refuse it
    max_in6 = ETH_OUT * PRICE6 // 10**18 * (10_000 + SLIP_BPS) // 10_000
    if not (max_in6 * 10**18 <= PRICE_CAP6 * ETH_OUT and max_in6 <= GAS_CAP6 and FEE6 <= FEE_CAP6):
        die("the TEST price / fee no longer fit the candidate caps")
    if max_in6 * 10**18 <= PRICE_CAP6 * 20_000_000_000_000 or max_in6 <= 100_000 and ETH_OUT <= 20_000_000_000_000:
        die("the TEST op must be impossible under the OLD candidate (2e13 wei / 0.1 USDC caps)")
    if 9 * (max_in6 + FEE6) > 4_800_000:
        die("nine nucbox TEST ops at the maximum must fit the 4.8 part budget")

    server = src[f"{B}/out/server.mjs"].decode("utf-8")
    if M in server:
        die(f"the source server already mentions {M}")
    new_server = apply(server, SERVER_EDITS, "server")
    if new_server.count(GUARD) != 1:
        die("the unchanged no-code-size-override refusal must remain exactly once")
    scanned = new_server.replace(GUARD, "")
    for bad in ("--code-size", "disable-code-size", "pkill", "killall", "process.kill(-", "mainnet", "base.org", "window.ethereum"):
        if bad in scanned:
            die(f"the derived server contains {bad!r}")
    for keep in SERVER_KEEP:
        if new_server.count(keep) != 1:
            die(f"the derived server must keep {keep!r} exactly once")
    found_keys = set(re.findall(r"0x[0-9a-f]{64}", new_server)) & set(re.findall(r'\["(0x[0-9a-f]{64})", "0x[0-9A-Fa-f]{40}"\]', new_server))
    if found_keys != set(ANVIL_KEYS):
        die(f"the derived server's signing keys must be exactly the three public Anvil keys, got {sorted(found_keys)}")

    main_js = src[f"{B}/shell/main.mjs"].decode("utf-8")
    if M in main_js:
        die(f"the source shell already mentions {M}")
    new_main = apply(main_js, MAIN_EDITS, "shell/main.mjs")
    for phase in ("pStart", "pPrepare", "pApprove", "pSwitch1", "pSignSend", "pRecover", "pSwitch2", "pComplete", "pQuote", "pFund",
                  "pExecFinal", "pExecLost", "pExecReload", "pExec502", "pExecSwitch", "pControls"):
        if new_main.count(f'phase("{phase}", ') != 1:
            die(f"phase {phase} must be defined exactly once")
    for old in ('"29000000"', '"800000"', '"200000"', "29_000_000n", "$29.00", "$0.80", "$0.20"):
        if old in new_main:
            die(f"shell/main.mjs still checks the old TEST split ({old})")
    if new_main.count('import("../../client-execution-site-r2/candidate/site/js/pages/funding.js")') != 1:
        die("the page under test must stay the client-execution-site-r2 generated page copy")

    outputs = {
        "out/server.mjs": new_server.encode("utf-8"),
        "shell/main.mjs": new_main.encode("utf-8"),
        "shell/facade/config.js": apply(src[f"{B}/shell/facade/config.js"].decode("utf-8"), CONFIG_EDITS, "config.js").encode("utf-8"),
        "build/build-harness.mjs": apply(src[f"{B}/build/build-harness.mjs"].decode("utf-8"), BUILD_EDITS, "build").encode("utf-8"),
        "page/index.html": apply(src[f"{B}/page/index.html"].decode("utf-8"), PAGE_EDITS, "page").encode("utf-8"),
    }
    for rel, t in COPIES.items():
        outputs[t] = src[rel]
    for p, b in outputs.items():
        f = HERE / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    gen = {"schema": f"{M}-fixture-generated/v1", "candidate": CID, "testOnly": True, "inputs": pins["inputs"],
           "outputs": {p: sha(b) for p, b in sorted(outputs.items())},
           "testEconomics": {"ethOut": str(ETH_OUT), "price6": str(PRICE6), "maxUsdcIn6": str(max_in6), "fee6": str(FEE6),
                             "totalMaximum6": str(max_in6 + FEE6)},
           "edits": {"server": len(SERVER_EDITS), "shell": len(MAIN_EDITS), "config": len(CONFIG_EDITS), "build": len(BUILD_EDITS),
                     "page": len(PAGE_EDITS)},
           "rootMustStill": ["build candidate/site/vendor/funding.js from candidate/sdk/funding/browser-entry.mjs",
                             "fill generated/BUILD-PINS.json and run build/build-harness.mjs", "fill generated/HARNESS-INPUTS.json"]}
    (HERE / "out" / "GENERATED.json").write_text(json.dumps(gen, indent=2) + "\n")
    print(json.dumps(gen, indent=2))


if __name__ == "__main__":
    main()
