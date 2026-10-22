class Names(unittest.TestCase):     # platform-carrier persistence inventory
    def test_text_fits_parses_and_reports(self):
        self.assertLessEqual(R.enc_len(R.H.m, R.NAMES, 60), R.LIMIT)
        code = "$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseInput($env:TXT,[ref]$t,[ref]$e);$e.Count"
        self.assertEqual(subprocess.run([PWSH, "-NoProfile", "-Command", code], env={**os.environ, "TXT": R.H.m.HEAD.replace("SECS", "60") + R.NAMES}, capture_output=True, text=True).stdout.strip(), "0")
        r = {"run-node.cmd": {"names": ["BASE_RPCS", "ENCLAVE_HOST_OWNERSHIP", "ENCLAVE_HOST_POLICY_DIR"]}, "node-config.cmd": {"names": ["APPS", "NODE_DIR"]},
             "node-config.local.cmd": {"names": ["BASE_RPCS", "ENCLAVE_NETWORK_WALLET_HOLD", "ENCLAVE_PLATFORM_HOST_POLICY", "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS"]}}
        rep = R.names_report(r)
        self.assertEqual(rep["onlyInRunNode"], ["ENCLAVE_HOST_OWNERSHIP", "ENCLAVE_HOST_POLICY_DIR"]); self.assertEqual(rep["inRunNodeAndLocal"], ["BASE_RPCS"])
        self.assertEqual(rep["platformPolicyNames"], ["ENCLAVE_PLATFORM_HOST_POLICY", "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS"])
    def test_names_regex_on_real_lines(self):
        import re as _re
        rx = _re.compile(r'(?im)^\s*set\s+"?([A-Za-z0-9_]+)=')
        t = 'set "BASE_RPCS=a,b"\r\nset ENCLAVE_HOST_OWNERSHIP=0x1\r\nrem set NOPE=1\r\n  set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS={"importDir":"C:/x"}"\r\n'
        self.assertEqual(rx.findall(t), ["BASE_RPCS", "ENCLAVE_HOST_OWNERSHIP", "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS"])
