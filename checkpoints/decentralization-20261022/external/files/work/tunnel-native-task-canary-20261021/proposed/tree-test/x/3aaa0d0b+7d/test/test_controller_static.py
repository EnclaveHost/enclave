#!/usr/bin/env python3
"""Static checks of tunnel_install.py v2 against the receiver and the VM files (no network, no remote call: ps/vm are
replaced by recorders). B1: one Windows name <= 20 everywhere, and the old 22-character name is rejected by the receiver's
own rule. B2: no ACL write on the shared backup parent. B6: every remote step fits root's transport limit, the task runs
only the pinned launcher, and the launcher refuses before the receiver on any trust/hash problem."""
import base64, hashlib, importlib.util, json, pathlib, re, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
TREE = HERE.parent
s = importlib.util.spec_from_file_location("ti", TREE / "tunnel_install.py"); ti = importlib.util.module_from_spec(s); s.loader.exec_module(ti)
RX = (TREE / "minipc/tunnel-receiver.ps1").read_text()
HEADF = ti.WORK / "nucbox-tls-20261021/root-activate-reviewed.py"
OLD_NAME = "enclave-control-tunnel"


def receiver_name_rule():
    return re.search(r"\$WINUSER -notmatch '([^']+)'", RX).group(1)


def receiver_block(user):
    """the receiver's $BLOCK, rendered from ITS source text (the PowerShell array literal), with $WINUSER substituted"""
    src = RX[RX.index("$BLOCK = @("):RX.index(") -join \"`r`n\"", RX.index("$BLOCK = @("))]
    toks = re.findall(r"(\$BEGIN|\$END|\"[^\"]*\"|'[^']*')", src)
    out = []
    for t in toks:
        if t == "$BEGIN": out.append(f"# BEGIN {user} (managed by tunnel-receiver.ps1; do not edit)")
        elif t == "$END": out.append(f"# END {user}")
        else: out.append(t[1:-1].replace("$WINUSER`", user).replace("$WINUSER", user))
    assert '$BEGIN = "# BEGIN $WINUSER (managed by tunnel-receiver.ps1; do not edit)"' in RX and '$END = "# END $WINUSER"' in RX
    return "\r\n".join(out)


class Recorder:
    def __init__(self, answer=None): self.scripts, self.answer = [], answer or {}
    def __call__(self, script, secs=90): self.scripts.append(script); return dict(self.answer)


def encoded_len(script):
    head = re.search(r'^HEAD = \((.*?)\)\n', HEADF.read_text(), re.S | re.M)
    # root's HEAD is a parenthesised concatenation of string literals: evaluate it as Python (literals only)
    h = eval("(" + head.group(1) + ")", {"__builtins__": {}}) if head else ""
    text = h.replace("SECS", "300") + script + ";$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"
    return len(base64.b64encode(text.encode("utf-16-le")))


class ControllerStatic(unittest.TestCase):
    def test_b1_one_windows_name_within_the_sam_limit(self):
        rule = receiver_name_rule()
        self.assertLessEqual(len(ti.WINUSER), 20); self.assertTrue(re.fullmatch(rule, ti.WINUSER))
        self.assertIsNone(re.fullmatch(rule, OLD_NAME), "the receiver itself refuses the old 22-character name")
        self.assertEqual(len(OLD_NAME), 22)
        sh = (TREE / "vm/enclave-control-tunnel-minipc.sh").read_text()
        self.assertIn(f'USER_AT="${{TUNNEL_USER:-{ti.WINUSER}}}"', sh, "the VM connects as the new Windows name")
        self.assertIn(f'WHO = E("V_USER", "{ti.WINUSER}")', (TREE / "vm/verify-negative.py").read_text())
        self.assertIn('"sudo -u enclave-control-tunnel"', (TREE / "vm/verify-negative.py").read_text(), "the Linux account is unchanged")
        self.assertLessEqual(len(ti.DESC), 48)

    def test_b1_block_rendering_is_identical_in_python_and_powershell(self):
        self.assertEqual(ti.managed_block(), receiver_block(ti.WINUSER))
        self.assertIn(f"Match User {ti.WINUSER}\r\n", ti.managed_block()); self.assertNotIn(OLD_NAME, ti.managed_block())

    def test_b2_no_acl_write_on_any_pre_existing_directory(self):
        self.assertNotIn("PrivateDir", RX)
        targets = re.findall(r"Set-Acl -LiteralPath (\$\w+)", RX)
        self.assertEqual(sorted(set(targets)), ["$CFG", "$f"], "Set-Acl only on the keys file this run wrote and sshd_config (its own ACL put back)")
        self.assertNotRegex(RX, r"icacls[^\n]*\$BPARENT")
        self.assertIn("if (-not (Test-Path -LiteralPath $BPARENT)) { [void][IO.Directory]::CreateDirectory($BPARENT)", RX)
        self.assertIn("[IO.Directory]::CreateDirectory($BACKUP, $ds)", RX)

    def test_b3_apply_records_ownership_before_mutating(self):
        i_state = RX.index("SaveState $state\n# the run's OWN backup dir")
        self.assertLess(RX.index("if ($why.Count) { Done ('refused: '"), i_state, "every refusal happens before state.json exists")
        self.assertLess(RX.index("$state.createdSid = $sid; SaveState $state"), RX.index("[IO.File]::WriteAllText($KEYS"))
        self.assertLess(RX.index("$state.keysWritten = (Sha $KEYS); SaveState $state"), RX.index("ReplaceFile $tmp\n$state.configWritten"))
        self.assertNotIn("Remove-LocalUser -Name", RX); self.assertIn("Remove-LocalUser -SID $sid", RX)

    def test_p1_ancestor_rename_rights_are_proven_absent_before_anything_runs(self):
        """independent review P1: stage and the fresh apply proof report every ancestor problem, and both refuse unless
        the list is EMPTY; the receiver refuses apply on any (native sandbox H exercises it)"""
        rec = Recorder({"trust": [], "files": {}}); ti.ps = rec
        ti.seal_and_prove(r"C:\ProgramData\Enclave\staging\tunnel-x", ["params.json"]); ti.fresh_proof(r"C:\ProgramData\Enclave\staging\tunnel-x")
        for sc in rec.scripts: self.assertIn("ancestors=@(A $d)", sc); self.assertIn("function A($p)", sc)
        self.assertIn("0x100D0040", ti.ANC); self.assertIn("-band 2", ti.ANC, "inherit-only ACEs do not apply to the object")
        src = (TREE / "tunnel_install.py").read_text()
        self.assertIn('ok = proof.get("ancestors") == [] and', src)
        self.assertIn('if proof.get("ancestors") != [] or proof.get("trust")', src)
        self.assertIn("foreach ($x in @(AncestorProblems $Dir)) { $why += \"staging ancestor: $x\" }", RX)
        self.assertLess(RX.index("AncestorProblems $Dir)"), RX.index("if ($why.Count) { Done ('refused: '"))

    def test_b6_launcher_pins_and_refuses_first(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        t = ti.launcher_text(r"C:\ProgramData\Enclave\staging\tunnel-x", "guard", h)
        self.assertIn("-ne '" + "a" * 64 + "'){$bad+='hash tunnel-receiver.ps1'}", t); self.assertIn("-ne '" + "b" * 64 + "'){$bad+='hash params.json'}", t)
        run = "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($rb).TrimStart([char]0xFEFF))) -Mode guard -Dir $d"
        self.assertTrue(t.endswith(run), "it runs exactly the bytes it hashed ($rb, read once), last")
        self.assertEqual(t.count("$rb="), 1); self.assertLess(t.index("exit 9"), t.index(run), "the receiver only after every check")
        self.assertNotIn("ExecutionPolicy", t + ti.task_args("D", "guard", h), "no execution-policy change of any scope")
        self.assertIn("0x500D0156", t); self.assertIn("0x500D0156", RX, "one write mask in the launcher and the receiver")
        self.assertTrue(ti.task_args("D", "apply", h).startswith("-NoProfile -NonInteractive -EncodedCommand "))

    def test_b6_task_registration_is_verified_against_the_pinned_arguments(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        d = r"C:\ProgramData\Enclave\staging\tunnel-x"
        rec = Recorder({"state": "Ready", "user": "SYSTEM", "triggers": 1, "argSha": hashlib.sha256(ti.task_args(d, "guard", h).encode()).hexdigest(),
                        "actions": 1, "exe": ti.PS_EXE, "logon": "ServiceAccount", "level": "Highest"})   # 7d P6: + the definition step
        ti.ps = rec
        self.assertTrue(ti.register_task("EnclaveTunnelGuard-x", "guard", d, "(Get-Date).AddMinutes(10)", h)["argsMatch"])
        self.assertIn("-Trigger $tr", rec.scripts[-2]); self.assertNotRegex(rec.scripts[-2], r"Register-ScheduledTask [^;]*-Force", "never overwrite a task of the same name")   # 7d P6: [-1] is the definition read
        rec.answer["argSha"] = "0" * 64
        self.assertFalse(ti.register_task("EnclaveTunnelGuard-x", "guard", d, "(Get-Date).AddMinutes(10)", h)["argsMatch"])
        # apply/rollback: NO trigger (run only by an explicit start after this check); a trigger there is a mismatch
        rec.answer.update(argSha=hashlib.sha256(ti.task_args(d, "apply", h).encode()).hexdigest(), triggers=0)
        self.assertTrue(ti.register_task("EnclaveTunnelApply-x", "apply", d, None, h)["argsMatch"]); self.assertNotIn("-Trigger", rec.scripts[-2]); self.assertNotIn("New-ScheduledTaskTrigger", rec.scripts[-2])
        rec.answer["triggers"] = 1
        self.assertFalse(ti.register_task("EnclaveTunnelApply-x", "apply", d, None, h)["argsMatch"])
        # the launcher text travels as one PowerShell single-quoted literal: every quote doubled, nothing else changed
        rec.answer["exe"] = "C:\\x\\powershell.exe"; rec.answer["triggers"] = 0                   # 7d P6: a wrong exe is a mismatch
        self.assertFalse(ti.register_task("EnclaveTunnelApply-x", "apply", d, None, h)["argsMatch"])
        body = rec.scripts[0][len("$L='"):rec.scripts[0].index("';$arg=")]
        self.assertEqual(body.replace("''", "'"), ti.launcher_text(d, "guard", h))

    def test_every_remote_step_fits_the_transport(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        d = r"C:\ProgramData\Enclave\staging\tunnel-" + "x" * 16                 # RUN is at most 16 (tunnel_install main)
        rec = Recorder(); ti.ps = rec
        ti.mkdir_protected(d); ti.seal_and_prove(d, ["params.json", "tunnel-receiver.ps1"]); ti.remove_dir(d); ti.minipc_listener()
        ti.start_task(f"EnclaveTunnelApply-{'x' * 16}"); ti.drop_task(f"EnclaveTunnelApply-{'x' * 16}")
        for m in ("guard", "apply", "rollback"): ti.register_task(f"EnclaveTunnelGuard-{'x' * 16}", m, d, "(Get-Date).AddMinutes(10)", h)
        with tempfile.TemporaryDirectory() as t:
            ti.REC = pathlib.Path(t)
            sleep, ti.time.sleep = ti.time.sleep, (lambda s: None)
            try: ti.poll_decision(d, "apply", tries=1)
            finally: ti.time.sleep = sleep
            ti.rec("minipc-stage-xabcdef", {"ok": True, "dir": d, "hashes": h})
            with self.assertRaises(SystemExit): ti.cmd_minipc_apply("xabcdef")          # stops at the fresh proof (recorder: {})
            ti.rec("verify-xabcdef", {"PASS": True}); ti.cmd_minipc_confirm("xabcdef")
            ti.cmd_minipc_preflight()
        self.assertIn('re.fullmatch(r"[a-z0-9]{6,16}", rest[0])', (TREE / "tunnel_install.py").read_text())
        rec.scripts += ti.built_scripts("x" * 16)[:-1]          # + every change-step script incl. the SYSTEM canary (not the bare launcher)
        big = max(rec.scripts, key=encoded_len)
        self.assertEqual(len(rec.scripts), 13 + 12 + 8, "7d P2/P6: +1 definition read per register_task (3 + 3 in built_scripts), +2 drop_when_done in built_scripts; stage dir x3, listener, start, drop, 3 tasks, poll, fresh proof, confirm, preflight + built_scripts")
        self.assertLessEqual(encoded_len(big), 7900, big[:200])


if __name__ == "__main__":
    unittest.main(verbosity=2)
