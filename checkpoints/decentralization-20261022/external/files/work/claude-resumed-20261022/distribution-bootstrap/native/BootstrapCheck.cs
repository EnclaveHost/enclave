// distribution-bootstrap NATIVE check (ROOT-ONLY; compiled WITH the exact staged EnclaveSetup.cs + TrayTheme.cs by Windows'
// in-box csc, so it calls the real SetupForm.PinPolicy, SetupOptions and SetupProgram.QuoteArgs). Works only in a folder under
// %TEMP% that it is given; never touches ProgramData\Enclave-setup, never shows a window, installs nothing, no network.
// The policy it pins is the TEST fixture "policy: the base policy" (channel "test", mirror.invalid): never a release authority.
//   BootstrapCheck.exe <fixtures.json> <empty temp work dir>   -> one PASS/FAIL line per check, exit 0 when all pass
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace Enclave.Setup
{
    static class BootstrapCheck
    {
        [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int n);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
        static int failed;
        static void Check(string name, bool ok, string detail = "") { if (!ok) failed++; Console.WriteLine((ok ? "PASS  " : "FAIL  ") + name + (ok || detail == "" ? "" : "  (" + detail + ")")); }
        static bool Throws(Action a, string want) { try { a(); return false; } catch (Exception e) { return e.Message.Contains(want); } }
        static string[] Split(string cmd)   // what Windows' own argv splitter makes of a command line (the program name first)
        {
            int n; IntPtr p = CommandLineToArgvW("x.exe " + cmd, out n); var r = new string[n - 1];
            for (int i = 1; i < n; i++) r[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i * IntPtr.Size));
            LocalFree(p); return r;
        }
        static bool Same(string[] a, string[] b) { if (a.Length != b.Length) return false; for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }

        static int Main(string[] args)
        {
            string fixtures = args[0], work = Path.GetFullPath(args[1]);
            if (!work.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) { Console.WriteLine("FAIL  work dir must be under %TEMP%"); return 2; }
            var fx = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(File.ReadAllText(fixtures));
            string policyJson = null;
            foreach (Dictionary<string, object> c in (System.Collections.ArrayList)fx["cases"]) if ((string)c["name"] == "policy: the base policy") policyJson = (string)c["policyJson"];
            Check("fixture: the TEST base policy is present", policyJson != null);
            string user = Path.Combine(work, "user"), wd = Path.Combine(work, "Enclave-setup"); Directory.CreateDirectory(user); Directory.CreateDirectory(wd);
            string given = Path.Combine(user, "release policy (operator copy).json"); File.WriteAllText(given, policyJson);
            string pinned = Path.Combine(wd, "release-policy.pinned.json");

            // P1 pinning: the bytes move into the work folder once, with their sha256; every later use is that copy
            var opt = new SetupOptions(); opt.Take("--release-policy", given);
            SetupForm.PinPolicy(wd, opt);
            Check("P1 pinned copy in the work folder, sha256 recorded, options point at it", opt.ReleasePolicy == pinned && File.ReadAllText(pinned) == policyJson && opt.PolicySha256 != null && opt.PolicySha256.Length == 64);
            var keys0 = ReleaseChannel.LoadPolicy(opt.ReleasePolicy).Keys[0].Id;
            // P2 the operator's file is swapped after the download (another account writes Downloads): nothing follows it
            File.WriteAllText(given, policyJson.Replace("\"channel\":\"test\"", "\"channel\":\"attacker\""));
            SetupForm.PinPolicy(wd, opt);
            Check("P2 a swap of the operator's file after pinning changes nothing (download + install use the pinned bytes)", File.ReadAllText(pinned) == policyJson
                  && ReleaseChannel.LoadPolicy(opt.ReleasePolicy).Keys[0].Id == keys0 && opt.InstallArgs().Contains("\"" + pinned + "\""));
            // P3 the pinned copy itself is changed: setup stops
            File.WriteAllText(pinned, policyJson + " ");
            Check("P3 a changed pinned copy stops setup", Throws(delegate { SetupForm.PinPolicy(wd, opt); }, "changed or is missing"));
            File.WriteAllText(pinned, policyJson);
            // P4 across the Hyper-V restart: Save -> Load keeps the pinned path and sha256; a tamper in between still stops setup
            string saved = Path.Combine(wd, "setup-options.json"); opt.Save(saved);
            var back = SetupOptions.Load(saved);
            Check("P4 restart round trip keeps the pinned path and sha256", back.ReleasePolicy == pinned && back.PolicySha256 == opt.PolicySha256);
            SetupForm.PinPolicy(wd, back);
            File.WriteAllText(pinned, policyJson.Replace("mirror.invalid", "mirror2.invalid"));
            Check("P4b a pinned copy changed across the restart stops setup", Throws(delegate { SetupForm.PinPolicy(wd, back); }, "changed or is missing"));
            File.WriteAllText(pinned, policyJson);
            // P5 saved options that point the policy elsewhere (with a sha256) are refused, never followed
            back.ReleasePolicy = given;
            Check("P5 saved options naming another policy path are refused", Throws(delegate { SetupForm.PinPolicy(wd, back); }, "not the copy pinned"));
            // P6 an oversized policy is refused before anything is copied
            var big = new SetupOptions(); string bigFile = Path.Combine(user, "big.json"); File.WriteAllText(bigFile, new string(' ', 70000)); big.Take("--release-policy", bigFile);
            string wd2 = Path.Combine(work, "Enclave-setup-2"); Directory.CreateDirectory(wd2);
            Check("P6 an oversized policy is refused and not copied", Throws(delegate { SetupForm.PinPolicy(wd2, big); }, "missing or too large") && !File.Exists(Path.Combine(wd2, "release-policy.pinned.json")));

            // Q relaunch command line: the exact arguments come back from Windows' own splitter
            var cases = new[] {
                new[] { "--release-policy", @"C:\Users\op\My Policies\release-policy.json", "--referral", "abc" },
                new[] { "--release-policy", @"C:\dir with space\" }, new[] { "--x", "say \"hi\"" }, new[] { "--empty", "" },
                new[] { @"C:\a\\b\", @"tab	inside" }, new[] { "--uninstall" } };
            bool all = true; foreach (var c in cases) all &= Same(Split(SetupProgram.QuoteArgs(c)), c);
            Check("Q1 QuoteArgs round-trips spaces, trailing backslashes, quotes, empty and tab arguments", all);
            Check("Q2 negative control: the old string.Join splits a policy path with a space", !Same(Split(string.Join(" ", cases[0])), cases[0]));
            // INFORMATIONAL (not a pass/fail): did this compile decode the source's UTF-8 UI glyphs (no BOM, no /codepage)?
            var sp = (string[])typeof(SetupForm).GetField("Spinner", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static).GetValue(null);
            Console.WriteLine("INFO  utf8Glyphs=" + (sp[0] == "\u280B" ? "decoded" : "NOT decoded (" + sp[0].Length + " chars)"));
            Console.WriteLine(failed == 0 ? "ALL PASS" : failed + " FAILED");
            return failed == 0 ? 0 : 1;
        }
    }
}
