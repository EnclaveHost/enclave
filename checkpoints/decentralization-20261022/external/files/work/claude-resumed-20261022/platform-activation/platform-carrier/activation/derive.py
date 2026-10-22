#!/usr/bin/env python3
"""Derive the CARRIER-capable activation copy from the prior (frozen) platform-activation package WITHOUT modifying it.
Every source is sha-verified; every edit is an exact, uniquely anchored substitution (listed below and in derive.json). Result:
platform-carrier/activation/{base,gate,helper,tools}, a sibling layout of the prior package, so its own compose.py and suites run.
  options P / R      unchanged (the prior package's exact lines)
  options PC / RC    P / R + set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS={"importDir":"C:/ProgramData/Enclave/node/policy-import"}"
  bundle pin         the CANDIDATE host-admission bundle (the bundle swap is a prerequisite of every option in this copy)
  gate proof         forwards GATE_CARRIERS to the bundle (the node's own env) and reports the gate's carrier summary"""
import hashlib, json, pathlib, shutil, sys
A = pathlib.Path(__file__).resolve().parent; PRIOR = A.parents[1]; PC = A.parent
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
CAND = sha(PC / "out/candidate.host-admission.bundle.mjs")
CARRIERS = '{"importDir":"C:/ProgramData/Enclave/node/policy-import"}'
SRC = {  # the prior package's files as RESULT.json / its last suite pinned them
 "base/node-hold-cutover.ps1": "df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8",
 "base/root-node-hold.py": "1d1b995c134373c0d5e72a8a3ca83a5726595d3d7d1de0a8e4cfc08ca8f69f0a",
 "gate/gate-proof.mjs": "72346b95702ed7ea6d14ae0a69d0c813844d925bb8c0d48216b79a1c7e9f9437",
 "helper/src/node-policy-activation.template.ps1": "d83245faa6e33bdd7b097ab2d077c0bbee558107a4c3497bade454a1f86ab583",
 "helper/compose.py": "6a7bf70a29b91ee1a7f87f49a1835060d8d412317e985c07d715335a7ef78481",
 "helper/root-policy-activation.py": None, "tools/fake-bundle.mjs": "ba858da309a70821e404b9a7747c1458062cab8ad0667e129336807e267e299f",
 "tools/policy-mock.ps1": "142cd9b34987e25c4c879f112faf63428d75bcd71ba46aed1d921c5812f5d714", "tools/test_activation.py": None,
 "tools/test_gate_proof.mjs": "428d1e32ae08b9d44e37021fe43499b5c50cbccf2b32be90a5f50f2a0db97036", "tools/test_runner.py": None,
 "tools/mutants.py": "25268bef7ee9dc0a48d9497fe7077d4471d61408ce69ae11ee23e3d73c906f47"}
EDITS = {
 "gate/gate-proof.mjs": [
  ("if (E.GATE_RPCS) env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS = String(E.GATE_RPCS);",
   "if (E.GATE_RPCS) env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS = String(E.GATE_RPCS);\n// platform-carrier: the node's carrier setting, exactly as node-config.local.cmd will carry it (the bundle validates it)\nif (E.GATE_CARRIERS) env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS = String(E.GATE_CARRIERS);"),
  ('r.relayPolicy = typeof gate.runtime?.gate?.decideOperators === "function" ? "gate" : "none";',
   'r.relayPolicy = typeof gate.runtime?.gate?.decideOperators === "function" ? "gate" : "none";\nr.carriers = gate.status().carriers ?? null;\nif (E.GATE_CARRIERS && !r.carriers) out({ ...r, verdict: "REFUSED", why: "the installed bundle ignores ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS (not the carrier bundle)" }, 1);')],
 "helper/src/node-policy-activation.template.ps1": [
  ("$OPTION = [string]$PRM.option\n",
   "$OPTION = [string]$PRM.option\n# platform-carrier: PC / RC = P / R plus the policy carriers (the operator-import directory in NODE_DIR); the carrier bundle is required\n$CARRIERS = '" + CARRIERS + "'\n$CARRIER_LINE = 'set \"ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + $CARRIERS + '\"'\n$BASE_OPTION = $(if ($OPTION -in 'PC', 'RC') { $OPTION.Substring(0, 1) } else { $OPTION })\n"),
  ("$POLICY_LINES = $(if ($OPTION -eq 'P')", "$POLICY_LINES = $(if ($BASE_OPTION -eq 'P')"),
  ("                  elseif ($OPTION -eq 'R') {", "                  elseif ($BASE_OPTION -eq 'R') {"),
  ("$GATE_RPCS = $(if ($OPTION -eq 'R') { $RPC5 -join ',' } else { '' })",
   "if ($OPTION -in 'PC', 'RC' -and $POLICY_LINES.Count) { $POLICY_LINES = @($POLICY_LINES) + @($CARRIER_LINE) }\n$GATE_RPCS = $(if ($BASE_OPTION -eq 'R') { $RPC5 -join ',' } else { '' })\n$GATE_CARRIERS = $(if ($OPTION -in 'PC', 'RC') { $CARRIERS } else { '' })"),
  ("@('GATE_RPCS', $GATE_RPCS), @('GATE_OPTION', $OPTION))", "@('GATE_RPCS', $GATE_RPCS), @('GATE_CARRIERS', $GATE_CARRIERS), @('GATE_OPTION', $OPTION))"),
  ("if ($OPTION -notin 'P', 'R' -or $POLICY_LINES.Count -lt 1) { $why += 'the params name no pinned policy option (P or R)' }",
   "if ($OPTION -notin 'P', 'R', 'PC', 'RC' -or $POLICY_LINES.Count -lt 1) { $why += 'the params name no pinned policy option (P, R, PC or RC)' }")],
 "tools/fake-bundle.mjs": [
  ('    status: () => ({ platformHostPolicy: "on", hostId, ...state, runtime: {',
   '    // platform-carrier: like the carrier bundle, report the carrier summary when the setting is present\n    status: () => ({ ...(env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS ? { carriers: { importDir: true, policyMirrorStateDir: false, peers: 0, serviceIndex: false } } : {}), platformHostPolicy: "on", hostId, ...state, runtime: {')],
 "helper/compose.py": [
  ('FROZEN = A.parents[1] / "root-control-rpc-final-20261022/control-package/helper/node-hold-cutover.ps1"',
   'FROZEN = A.parents[3] / "root-control-rpc-final-20261022/control-package/helper/node-hold-cutover.ps1"   # platform-carrier/activation depth')],
 "helper/root-policy-activation.py": [
  ('BUNDLE, BUNDLE_SHA = PF + r"\\control\\windows\\node\\host-admission.bundle.mjs", "6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18"',
   'BUNDLE, BUNDLE_SHA = PF + r"\\control\\windows\\node\\host-admission.bundle.mjs", "' + CAND + '"   # platform-carrier CANDIDATE (swap first)'),
  ('OPTIONS = {"P": "", "R": R5}', 'OPTIONS = {"P": "", "R": R5, "PC": "", "RC": R5}\nCARRIERS = \'' + CARRIERS + '\'      # PC / RC: the operator-import carrier (platform-carrier)\nCARRIER_OF = lambda k: CARRIERS if k in ("PC", "RC") else ""'),
  ("@('GATE_RPCS',$opt[1]),@('GATE_OPTION',$opt[0])", "@('GATE_RPCS',$opt[1]),@('GATE_CARRIERS',$opt[2]),@('GATE_OPTION',$opt[0])"),
  ('''    opts = "@(" + ",".join(f"@('{k}','{v}')" for k, v in OPTIONS.items()) + ")"''',
   '''    opts = "@(" + ",".join(f"@('{k}','{v}','{CARRIER_OF(k)}')" for k, v in OPTIONS.items()) + ")"'''),
  ("        text, secs = gate_text(stage + \"\\\\gate-proof.mjs\"), 150", "        text, secs = gate_text(stage + \"\\\\gate-proof.mjs\", (o.option,) if o.option else (\"PC\", \"RC\")), 150   # platform-carrier: the carrier pair (or one --option)"),
  ('    want = 2 if r0["params"]["option"] == "R" else 1; why = []', '    want = {"P": 1, "R": 2, "PC": 2, "RC": 3}[r0["params"]["option"]]; why = []')],
 "tools/test_activation.py": [
  ('A = pathlib.Path(__file__).resolve().parents[1]\nPWSH = os.environ.get("PWSH") or str(A.parents[1] / "node-hold-package-20261021/tools/pwsh/pwsh")',
   'A = pathlib.Path(__file__).resolve().parents[1]\nPWSH = os.environ.get("PWSH") or str(A.parents[3] / "node-hold-package-20261021/tools/pwsh/pwsh")'),
  ("POLICY_R = b'set ENCLAVE_PLATFORM_HOST_POLICY=production\\r\\nset \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + R5.encode() + b'\"\\r\\n'",
   "POLICY_R = b'set ENCLAVE_PLATFORM_HOST_POLICY=production\\r\\nset \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + R5.encode() + b'\"\\r\\n'\nCARRIERS = '" + CARRIERS + "'\nCARRIER_LINE = b'set \"ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + CARRIERS.encode() + b'\"\\r\\n'"),
  ("class Structure(unittest.TestCase):", '''class CarrierOptions(unittest.TestCase):     # platform-carrier
    def test_rc_appends_the_carrier_line_and_the_gate_proof_sees_it(self):
        d, p = world("okRC", option="RC"); r, lines = run(d, p)
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0 + POLICY_R + CARRIER_LINE)
        env = json.loads((d / "fake-gate-calls.jsonl").read_text().splitlines()[0])["env"]
        self.assertEqual(env, {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R5, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": CARRIERS})
        self.assertEqual(json.loads(env["ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS"]), {"importDir": "C:/ProgramData/Enclave/node/policy-import"})
    def test_pc_appends_exactly_two_lines(self):
        d, p = world("okPC", option="PC"); r, lines = run(d, p)
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0 + b"set ENCLAVE_PLATFORM_HOST_POLICY=production\\r\\n" + CARRIER_LINE)
    def test_rc_rollback_restores_exact_bytes(self):
        d, p = world("rcgn", option="RC"); r, lines = run(d, p, "gate-never")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_R2:"), final(lines)); self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0)
    def test_unknown_option_refused(self):
        d, p = world("optX", option="RX"); r, lines = run(d, p); self.assertIn("no pinned policy option", final(lines)); self.assertEqual(starts(d), [])

class Structure(unittest.TestCase):''')],
 "tools/test_gate_proof.mjs": [
  ('const REAL = path.resolve(A, "../../root-control-rpc-final-20261022/control-package/files/windows/node/host-admission.bundle.mjs");',
   'const REAL = path.resolve(A, "../../../../root-control-rpc-final-20261022/control-package/files/windows/node/host-admission.bundle.mjs");\nconst CAND = path.resolve(A, "../out/candidate.host-admission.bundle.mjs");'),
  ('test("REAL bundle, policy off: NOT_ADMISSIBLE; a malformed value: REFUSED", () => {',
   '''test("platform-carrier: GATE_CARRIERS reaches the bundle exactly; the INSTALLED bundle (no carrier support) is REFUSED for a carrier option", () => {
  const d = world("not-activated"), C = '{"importDir":"C:/ProgramData/Enclave/node/policy-import"}';
  const env = { PATH: process.env.PATH, GATE_BUNDLE: path.join(d, "bundle.mjs"), GATE_HOST: RUNNER, GATE_ENDPOINT: EP, GATE_POLICY: "production", GATE_RPCS: R5, GATE_CARRIERS: C, GATE_OPTION: "RC" };
  const r = spawnSync(process.execPath, ["--input-type=module"], { input: JS, env, timeout: 60000, encoding: "utf8" });
  const calls = fs.readFileSync(path.join(d, "fake-gate-calls.jsonl"), "utf8").trim().split("\\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls[0].env, { ENCLAVE_PLATFORM_HOST_POLICY: "production", ENCLAVE_PLATFORM_HOST_POLICY_RPCS: R5, ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: C });
  const o = JSON.parse(r.stdout.trim().split("\\n").pop()); assert.equal(o.verdict, "ADMISSIBLE"); assert.equal(o.carriers.importDir, true);
  // the INSTALLED bundle 6bef372d ignores the setting: refused BEFORE any chain read (offline), never a silent carrier-less proof
  const live = spawnSync(process.execPath, ["--input-type=module"], { input: JS, env: { ...env, GATE_BUNDLE: REAL }, timeout: 60000, encoding: "utf8" });
  const lo = JSON.parse(live.stdout.trim().split("\\n").pop()); assert.equal(lo.verdict, "REFUSED"); assert.match(lo.why, /ignores ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS/);
  const cand = spawnSync(process.execPath, ["--input-type=module"], { input: JS, env: { ...env, GATE_BUNDLE: CAND, GATE_POLICY: "off" }, timeout: 60000, encoding: "utf8" });
  assert.equal(JSON.parse(cand.stdout.trim().split("\\n").pop()).verdict, "REFUSED", "the carrier bundle refuses carriers with the policy off");
});
test("REAL bundle, policy off: NOT_ADMISSIBLE; a malformed value: REFUSED", () => {''')],
 "tools/test_runner.py": [
  ("A = pathlib.Path(__file__).resolve().parents[1]; W = A.parents[1]", "A = pathlib.Path(__file__).resolve().parents[1]; W = A.parents[3]   # platform-carrier/activation depth"),
  ('''        o = json.loads(out); self.assertEqual([x["option"] for x in o["runs"]], ["P", "R"])''', '''        o = json.loads(out); self.assertEqual([x["option"] for x in o["runs"]], ["P", "R", "PC", "RC"])'''),
  ('''        for x in o["runs"]: self.assertEqual(x["result"]["verdict"], "ADMISSIBLE"); self.assertTrue(x["exited"]); self.assertEqual(x["code"], 0)''',
   '''        for x in o["runs"]: self.assertEqual(x["result"]["verdict"], "ADMISSIBLE"); self.assertTrue(x["exited"]); self.assertEqual(x["code"], 0)
        for x in o["runs"][2:]: self.assertEqual(x["result"]["carriers"]["importDir"], True)'''),
  ('''        self.assertEqual(envs, [{"ENCLAVE_PLATFORM_HOST_POLICY": "production"}, {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5}])''',
   '''        self.assertEqual(envs, [{"ENCLAVE_PLATFORM_HOST_POLICY": "production"}, {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5},
                                {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": R.CARRIERS},
                                {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": R.CARRIERS}])'''),
  ('''        self.assertEqual([x["result"]["verdict"] for x in o["runs"]], ["UNKNOWN", "UNKNOWN"]); self.assertLess(time.time() - t0, 2 * 58)''',
   '''        self.assertEqual([x["result"]["verdict"] for x in o["runs"]], ["UNKNOWN"] * 4); self.assertLess(time.time() - t0, 4 * 58)'''),
  ('''    def test_classify(self):''', '''    def test_post_policy_counts_per_option(self):     # platform-carrier
        for opt, n in (("P", 1), ("R", 2), ("PC", 2), ("RC", 3)):
            r0 = {"params": {"option": opt, "expectedIds": EXP}}; pre = good_pre(); pre["configs"]["node-config.local.cmd"].update(sha="e" * 64, policy=n)
            g = "7" * 32; pre["channel"]["doc"]["generation"] = g; pre["channel"]["status"]["generation"] = g
            post = {"configs": pre["configs"], "channel": pre["channel"], "log": {"admitted": 1, "notServing": 0, "notServingChange": 0}}
            self.assertEqual(R.post_verdict(r0, {"policy": {"after": "e" * 64}, "start-node": {"channelGeneration": g}}, post)["verdict"], "PASS", opt)
    def test_classify(self):''')],
}
# platform-carrier native cmd fixture (fragments/ hold the exact added code, read verbatim)
FR = lambda n: (A / "fragments" / n).read_text()
EDITS["helper/root-policy-activation.py"] += [
  ("PARSEFILE = U + ", FR("runner-cmdfix-def.py") + "PARSEFILE = U + "),
  ('x.add_argument("--post", metavar="RUN_ID")', 'x.add_argument("--post", metavar="RUN_ID"); x.add_argument("--cmd-fixture", action="store_true")'),
  ("    if o.status:\n", FR("runner-cmdfix-mode.py") + "    if o.status:\n")]
EDITS["tools/test_runner.py"] += [("    def test_classify(self):", FR("test-runner-cmdfix.py") + "    def test_classify(self):")]
# the gate text's options by reference (transport limit); the test uses the runner's own option builder
EDITS["helper/root-policy-activation.py"] += [
  ("def gate_text(js_remote):\n", FR("runner-gate-opts.py") + "def gate_text(js_remote, names=(\"PC\", \"RC\")):\n"),
  ('''    opts = "@(" + ",".join(f"@('{k}','{v}','{CARRIER_OF(k)}')" for k, v in OPTIONS.items()) + ")"''', "    pre, opts = gate_opts(names)"),
  ('    return (GATE.replace("BUNDLEX", BUNDLE)', '    return pre + (GATE.replace("BUNDLEX", BUNDLE)')]
EDITS["tools/test_runner.py"] += [
  ('''.replace("OPTSX", "@(" + ",".join(f"@('{k}','{v}')" for k, v in R.OPTIONS.items()) + ")")''', '''.replace("OPTSX", R.gate_opts()[1])'''),
  ('''        out = subprocess.run([PWSH, "-NoProfile", "-Command", pre + t]''', '''        pre = pre + R.gate_opts()[0]\n        out = subprocess.run([PWSH, "-NoProfile", "-Command", pre + t]''')]
# ---- round 3 (root 04:35:38Z native proof): the gate's RPC set for R / RC = root's PROVEN independent four, in its order;
# majority 3 of 4 (the production agreement count, unchanged). The node's own chain RPCs (BASE_RPCS / chain.rpc, RPC5) are untouched.
R4 = "https://base-rpc.publicnode.com,https://mainnet.base.org,https://base-rpc.polkachu.com,https://base.drpc.org"
R4PS = "@('" + R4.replace(",", "', '") + "')"
EDITS["helper/src/node-policy-activation.template.ps1"] += [
  ("$OPTION = [string]$PRM.option\n", "# the platform gate's OWN quorum for R / RC (root native 04:35:38Z ADMISSIBLE 3 of 4); NOT the node's chain RPCs above\n$GATE_RPC4 = " + R4PS + "\n$OPTION = [string]$PRM.option\n"),
  ("('set \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + ($RPC5 -join ',') + '\"')", "('set \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + ($GATE_RPC4 -join ',') + '\"')"),
  ("$GATE_RPCS = $(if ($BASE_OPTION -eq 'R') { $RPC5 -join ',' } else { '' })", "$GATE_RPCS = $(if ($BASE_OPTION -eq 'R') { $GATE_RPC4 -join ',' } else { '' })")]
EDITS["helper/root-policy-activation.py"] += [
  ('OPTIONS = {"P": "", "R": R5, "PC": "", "RC": R5}', 'R4 = "' + R4 + '"   # root native 04:35:38Z: ADMISSIBLE 3 of 4\nOPTIONS = {"P": "", "R": R4, "PC": "", "RC": R4}'),
  ('    ref = lambda v: "$R5" if v == R5 else "\'\'"', '    ref = lambda v: "$R4" if v == R4 else "\'\'"'),
  ('    return (f"$R5={q(R5)};$C={q(CARRIERS)};",', '    return (f"$R4={q(R4)};$C={q(CARRIERS)};",'),
  ("def check_local():\n", FR("runner-swap-def.py") + "def check_local():\n"),
  ('        for src, n in ((COORD, "node-policy-activation.ps1"), (GATEJS, "gate-proof.mjs")):', '        for src, n in ((COORD, "node-policy-activation.ps1"), (GATEJS, "gate-proof.mjs"), (SWAP[0], "bundle-swap.ps1"), (CAND_FILE, CAND_NAME)):'),
  ('        want = {d + "\\\\node-policy-activation.ps1": sha(COORD), d + "\\\\gate-proof.mjs": sha(GATEJS)}', '        want = {d + "\\\\node-policy-activation.ps1": sha(COORD), d + "\\\\gate-proof.mjs": sha(GATEJS), d + "\\\\bundle-swap.ps1": SWAP[1], d + "\\\\" + CAND_NAME: BUNDLE_SHA}'),
  ('x.add_argument("--cmd-fixture", action="store_true")', 'x.add_argument("--cmd-fixture", action="store_true"); x.add_argument("--swap-inspect", action="store_true"); x.add_argument("--swap-bundle", action="store_true"); x.add_argument("--swap-back", action="store_true")'),
  ("    if o.cmd_fixture:", FR("runner-swap-mode.py") + "    if o.cmd_fixture:")]
EDITS["tools/test_activation.py"] += [
  ("POLICY_R = b'set ENCLAVE_PLATFORM_HOST_POLICY=production\\r\\nset \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + R5.encode() + b'\"\\r\\n'",
   "R4 = '" + R4 + "'   # the gate's own quorum for R / RC (root native 04:35:38Z)\nPOLICY_R = b'set ENCLAVE_PLATFORM_HOST_POLICY=production\\r\\nset \"ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + R4.encode() + b'\"\\r\\n'"),
  ('        self.assertEqual(calls[0]["env"], {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R5})',
   '        self.assertEqual(calls[0]["env"], {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R4})'),
  ('"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R5, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": CARRIERS})', '"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R4, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": CARRIERS})'),
  ('self.assertEqual(len(g["proof"]["rpcHosts"]), 5)', 'self.assertEqual(len(g["proof"]["rpcHosts"]), 4)')]
EDITS["tools/test_runner.py"] += [
  ('[u.split("//")[1] for u in R.R5.split(",")]', '[u.split("//")[1] for u in R.R4.split(",")]'),
  ('"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5}', '"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R4}'),
  ('"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": R.CARRIERS}', '"ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R4, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": R.CARRIERS}'),
  ('if __name__ == "__main__": unittest.main()', FR("test-runner-swap.py") + '\nif __name__ == "__main__": unittest.main()')]
# ---- round 3b: read-only launcher-names inventory for the regeneration hazard
EDITS["helper/root-policy-activation.py"] += [
  ("def check_local():\n", FR("runner-names-def.py") + "def check_local():\n"),
  ('x.add_argument("--swap-back", action="store_true")', 'x.add_argument("--swap-back", action="store_true"); x.add_argument("--names", action="store_true")'),
  ("    if o.swap_inspect or o.swap_bundle or o.swap_back:", FR("runner-names-mode.py") + "    if o.swap_inspect or o.swap_bundle or o.swap_back:")]
EDITS["tools/test_runner.py"] += [("class SwapPath(unittest.TestCase):", FR("test-runner-names.py") + "class SwapPath(unittest.TestCase):")]
# ---- round 4 (root closeout + independent review): RC only; exact root-pinned post-migration launcher shas; R4 in the proof test
EDITS["helper/root-policy-activation.py"] += [
  ('LOCAL_NOW = "405db912b15c73e57334bef4ad2c1071695495010bb95e67c72f200c48e382f0"         # node-config.local.cmd after it (journal \'flag\')',
   'LOCAL_NOW = "405db912b15c73e57334bef4ad2c1071695495010bb95e67c72f200c48e382f0"         # node-config.local.cmd after it (journal \'flag\')\n'
   '# platform-carrier: the launcher shas the activation expects; root may pin the shas AFTER its config-persistence migration\n'
   '# (--expect-local / --expect-run-node, exact lowercase sha256): the activation then appends to, and rolls back to, those bytes\n'
   'EXPECT = {"local": LOCAL_NOW, "runNode": RUN_NODE_NOW}'),
  ('if (c.get("run-node.cmd") or {}).get("sha") != RUN_NODE_NOW: r.append("run-node.cmd is not the cutover\'s repaired 0fdc3699")',
   'if (c.get("run-node.cmd") or {}).get("sha") != EXPECT["runNode"]: r.append(f"run-node.cmd is not the expected {EXPECT[\'runNode\'][:8]} (cutover 0fdc3699 unless root pinned --expect-run-node)")'),
  ('if (c.get("node-config.local.cmd") or {}).get("sha") != LOCAL_NOW: r.append("node-config.local.cmd is not the cutover\'s 405db912 (changed since): root decides")',
   'if (c.get("node-config.local.cmd") or {}).get("sha") != EXPECT["local"]: r.append(f"node-config.local.cmd is not the expected {EXPECT[\'local\'][:8]} (cutover 405db912 unless root pinned --expect-local): root decides")'),
  ('a.add_argument("--run-id")', 'a.add_argument("--run-id"); a.add_argument("--expect-local"); a.add_argument("--expect-run-node")'),
  ("o = a.parse_args(argv); check_local(); m = transport();",
   "o = a.parse_args(argv)\n    for k, v in ((\"local\", o.expect_local), (\"runNode\", o.expect_run_node)):\n        if v is not None:\n            if not re.fullmatch(r\"[0-9a-f]{64}\", v): raise SystemExit(f\"--expect-{k}: an exact lowercase sha256\")\n            EXPECT[k] = v\n    check_local(); m = transport();"),
  ('def gate_text(js_remote, names=("PC", "RC")):', 'def gate_text(js_remote, names=("RC",)):'),
  ('(o.option,) if o.option else ("PC", "RC")), 150   # platform-carrier: the carrier pair (or one --option)', '(o.option,) if o.option else ("RC",)), 150   # platform-carrier: RC (or one --option)'),
  ('        if not o.option: raise SystemExit("--option P|R (root\'s choice; see RESULT.json \'options\')")\n',
   '        if not o.option: raise SystemExit("--option RC (the only option this package offers)")\n' + FR("runner-rc-only.py"))]
EDITS["tools/test_runner.py"] += [
  ('"runs": [{"option": "P", "result": {"verdict": v}}, {"option": "R",', '"runs": [{"option": "P", "result": {"verdict": v}}, {"option": "RC", "result": {"verdict": v}}, {"option": "R",'),
  ('rc = R.main(["--activate", "--option", "R", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate])', 'rc = R.main(["--activate", "--option", "RC", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate])'),
  ('self.assertEqual(prm["option"], "R");', 'self.assertEqual(prm["option"], "RC");'),
  ('self.assertEqual(R.main(["--activate", "--option", "P", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate]), 2)', 'self.assertEqual(R.main(["--activate", "--option", "RC", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate]), 2)'),
  ('with self.assertRaises(SystemExit): R.main(["--activate", "--option", "P", "--stage-receipt", st, "--preflight", pre])', 'with self.assertRaises(SystemExit): R.main(["--activate", "--option", "RC", "--stage-receipt", st, "--preflight", pre])'),
  ("class SwapPath(unittest.TestCase):", FR("test-runner-rc.py") + "class SwapPath(unittest.TestCase):")]
ALL = {"tools/test_gate_proof.mjs": [('const R5 = "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org";',
          'const R4 = "' + R4 + '";   // root native 04:35:38Z (platform-carrier round 4)', 1), ("R5", "R4", 4),
         ('test("option R: the 5 RPCs reach the gate and the majority is 3"', 'test("option R/RC: root\'s 4 proven RPCs reach the gate and the majority is 3"', 1),
         ("assert.equal(r.out.config.rpcHosts.length, 5);", "assert.equal(r.out.config.rpcHosts.length, 4);", 1)]}
# ---- round 5 (review against config-persistence-r3): exclusive temp + exclusive backup + an existing private dir verified
EDITS["helper/src/node-policy-activation.template.ps1"] += [
  ("#@BASE 266-353\n", "#@BASE 266-332\n" + FR("coord-r5-temp.ps1") + "#@BASE 345-353\n"),
  ('$before.local.backup = Join-Path $PRIV "node-config.local.cmd.before-$Run"; [IO.File]::WriteAllBytes($before.local.backup, $lb)',
   '# r5: the backup is created EXCLUSIVELY inside the verified private directory (never over an existing name), then written\n'
   '$before.local.backup = Join-Path $PRIV "node-config.local.cmd.before-$Run"\n'
   '$bfs = [IO.File]::Open($before.local.backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); try { $bfs.Write($lb, 0, $lb.Length) } finally { $bfs.Close() }')]
EDITS["tools/test_activation.py"] += [
  ('"Writers", "Readers", "PrivDir", "ProtectedTemp", "CasWrite",', '"Writers", "Readers", "CasWrite",'),
  ("class OldNegativeControl(unittest.TestCase):", FR("test-r5-temp.py") + "class OldNegativeControl(unittest.TestCase):")]
EDITS["tools/mutants.py"] = EDITS.get("tools/mutants.py", []) + [
  ("MUTANTS = [\n", "MUTANTS = [\n    (\"temp-not-exclusive (r5)\", \"$fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); $fs.Close()\", \"[IO.File]::WriteAllBytes($tmp, [byte[]]@())\", \"TempSafetyR5.test_existing_name_is_never_truncated_or_deleted\"),\n")]
def main():
    rec = {"prior": str(PRIOR), "candidateBundle": CAND, "files": {}}
    for rel, want in SRC.items():
        src = PRIOR / rel; got = sha(src)
        if want and got != want: raise SystemExit(f"prior {rel} is {got[:8]}, not the pinned {want[:8]}")
        text = src.read_text()
        for old, new in EDITS.get(rel, []):
            if text.count(old) != 1: raise SystemExit(f"{rel}: anchor not unique ({text.count(old)}): {old[:70]}")
            text = text.replace(old, new)
        for old, new, n in ALL.get(rel, []):
            if text.count(old) != n: raise SystemExit(f"{rel}: {old[:40]} occurs {text.count(old)}x, expected {n}")
            text = text.replace(old, new)
        dst = A / rel; dst.parent.mkdir(parents=True, exist_ok=True); dst.write_text(text)
        rec["files"][rel] = {"prior": got, "derived": sha(dst), "edits": len(EDITS.get(rel, []))}
    (A / "derive.json").write_text(json.dumps(rec, indent=1) + "\n"); print(json.dumps(rec, indent=1))
if __name__ == "__main__": main()
