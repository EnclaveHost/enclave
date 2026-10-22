class TempSafetyR5(unittest.TestCase):     # platform-carrier r5: exclusive temp, never deleting what this run did not create
    def run_fn(self, script, scenario):
        """the coordinator's ProtectedTemp, its random suffix fixed to 'deadbeef' (test-only text substitution), with stub ACL cmdlets"""
        fns = Structure().fns(script)["fns"]; body = fns["ProtectedTemp"].replace("[guid]::NewGuid().ToString('N').Substring(0, 8)", "'deadbeef'")
        d = pathlib.Path(tempfile.mkdtemp(prefix="pa-temp-")); ref = d / "node-config.local.cmd"; ref.write_bytes(b"x"); tmp = pathlib.Path(str(ref) + ".nh-deadbeef")
        if scenario.startswith("foreign"): tmp.write_bytes(b"FOREIGN")
        setacl = "throw 'mock: ACL refused'" if scenario.endswith("aclfail") else ""
        code = ("function Get-Acl { param($LiteralPath) [pscustomobject]@{ Sddl = 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)' } }; function Set-Acl { param($LiteralPath, $AclObject) " + setacl + " }; "
                + body + "; try { $t = ProtectedTemp '" + str(ref) + "' '.nh-'; 'RET ' + $t } catch { 'THREW ' + $_.Exception.Message }")
        out = subprocess.run([PWSH, "-NoProfile", "-Command", code], capture_output=True, text=True).stdout.strip()
        return out, (tmp.read_bytes() if tmp.exists() else None)
    def test_existing_name_is_never_truncated_or_deleted(self):
        out, left = self.run_fn(SCRIPT, "foreign-aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertEqual(left, b"FOREIGN")
        out, left = self.run_fn(SCRIPT, "foreign"); self.assertTrue(out.startswith("THREW"), out); self.assertEqual(left, b"FOREIGN")
    def test_own_temp_created_empty_and_removed_only_on_its_own_failure(self):
        out, left = self.run_fn(SCRIPT, "ok"); self.assertTrue(out.startswith("RET "), out); self.assertEqual(left, b"")
        out, left = self.run_fn(SCRIPT, "aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertIsNone(left)
    def test_negative_control_base_truncates_and_deletes_a_foreign_file(self):
        out, left = self.run_fn(BASE, "foreign-aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertIsNone(left, "the base deleted a file it did not create")
        out, left = self.run_fn(BASE, "foreign"); self.assertTrue(out.startswith("RET"), out); self.assertEqual(left, b"", "the base truncated a file it did not create")
    def test_backup_exclusive_and_existing_private_dir_checked(self):
        t = SCRIPT.read_text()
        self.assertNotIn("WriteAllBytes($before.local.backup", t); self.assertIn("[IO.File]::Open($before.local.backup, [IO.FileMode]::CreateNew", t)
        pd = Structure().fns(SCRIPT)["fns"]["PrivDir"]; self.assertIn("AreAccessRulesProtected", pd); self.assertIn("ReparsePoint", pd); self.assertIn("GetOwner", pd)
        self.assertNotIn("WriteAllBytes($tmp, [byte[]]@())", Structure().fns(SCRIPT)["fns"]["ProtectedTemp"])
        cw = Structure().fns(SCRIPT)["fns"]["CasWrite"]; self.assertIn("aclKept = ((Get-Acl -LiteralPath $path).Sddl -eq $acl.Sddl)", cw)   # full SDDL incl. owner

