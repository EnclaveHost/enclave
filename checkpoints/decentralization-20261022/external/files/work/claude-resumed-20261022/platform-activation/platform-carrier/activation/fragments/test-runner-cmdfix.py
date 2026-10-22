    def test_cmd_fixture_text_fits_and_parses(self):     # platform-carrier
        t = R.cmdfix_text(r"C:\ProgramData\Enclave\staging\policyact-0123456789ab")
        self.assertLessEqual(R.enc_len(R.H.m, t, 60), R.LIMIT); self.assertLessEqual(R.enc_len(R.H.m, R.parse_text(t), 60), R.LIMIT)
        self.assertIn('set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS={"importDir":"C:/ProgramData/Enclave/node/policy-import"}"', t)
        code = "$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseInput($env:TXT,[ref]$t,[ref]$e);$e.Count"
        out = subprocess.run([PWSH, "-NoProfile", "-Command", code], env={**os.environ, "TXT": R.H.m.HEAD.replace("SECS", "60") + t}, capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "0")
