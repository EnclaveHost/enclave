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

    def test_b6_launcher_pins_and_refuses_first(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        t = ti.launcher_text(r"C:\ProgramData\Enclave\staging\tunnel-x", "guard", h)
        self.assertIn("'tunnel-receiver.ps1'='" + "a" * 64 + "'", t); self.assertIn("'params.json'='" + "b" * 64 + "'", t)
        self.assertLess(t.index("exit 9"), t.index("& (Join-Path $d 'tunnel-receiver.ps1') -Mode guard"), "the receiver only after every check")
        self.assertIn("0x500D0156", t); self.assertIn("0x500D0156", RX, "one write mask in the launcher and the receiver")
        self.assertTrue(ti.task_args("D", "apply", h).startswith("-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "))

    def test_b6_task_registration_is_verified_against_the_pinned_arguments(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        d = r"C:\ProgramData\Enclave\staging\tunnel-x"
        rec = Recorder({"state": "Ready", "user": "SYSTEM", "argSha": hashlib.sha256(ti.task_args(d, "guard", h).encode()).hexdigest()})
        ti.ps = rec
        self.assertTrue(ti.register_task("EnclaveTunnelGuard-x", "guard", d, "(Get-Date).AddMinutes(10)", h)["argsMatch"])
        rec.answer["argSha"] = "0" * 64
        self.assertFalse(ti.register_task("EnclaveTunnelGuard-x", "guard", d, "(Get-Date).AddMinutes(10)", h)["argsMatch"])
        # the launcher text travels as one PowerShell single-quoted literal: every quote doubled, nothing else changed
        body = rec.scripts[0][len("$L='"):rec.scripts[0].index("';$arg=")]
        self.assertEqual(body.replace("''", "'"), ti.launcher_text(d, "guard", h))

    def test_every_remote_step_fits_the_transport(self):
        h = {"tunnel-receiver.ps1": "a" * 64, "params.json": "b" * 64}
        d = r"C:\ProgramData\Enclave\staging\tunnel-20261021t235959z00"
        rec = Recorder(); ti.ps = rec
        ti.mkdir_protected(d); ti.seal_and_prove(d, ["params.json", "tunnel-receiver.ps1"]); ti.remove_dir(d); ti.minipc_listener()
        for m in ("guard", "apply", "rollback"): ti.register_task(f"EnclaveTunnelGuard-{'x' * 24}", m, d, "(Get-Date).AddMinutes(10)", h)
        with tempfile.TemporaryDirectory() as t:
            ti.REC = pathlib.Path(t)
            sleep, ti.time.sleep = ti.time.sleep, (lambda s: None)
            try: ti.poll_decision(d, "apply", tries=1)
            finally: ti.time.sleep = sleep
            ti.rec("minipc-stage-xabcdef", {"ok": True, "dir": d, "hashes": h})
            with self.assertRaises(SystemExit): ti.cmd_minipc_apply("xabcdef")          # stops at the fresh proof (recorder: {})
            ti.rec("verify-xabcdef", {"PASS": True}); ti.cmd_minipc_confirm("xabcdef")
            ti.cmd_minipc_preflight()
        big = max(rec.scripts, key=encoded_len)
        self.assertEqual(len(rec.scripts), 11, "stage dir x3, listener, 3 tasks, poll, fresh proof, confirm, preflight")
        self.assertLessEqual(encoded_len(big), 7900, big[:200])


if __name__ == "__main__":
    unittest.main(verbosity=2)
