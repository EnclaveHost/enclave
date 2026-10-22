// ConfigNativeFixture.cs -- Windows-only SCRATCH fixture for config-persistence-r3 migrate-local-config.ps1 (d2ae8f69...).
// Runs the UNCHANGED script through `powershell.exe -NoProfile -NonInteractive -File` children on DUMMY files in a private scratch
// tree inside its own stage. It never reads or writes production configuration, never sets an execution policy, privilege or
// ACL outside its own scratch tree, never starts agents, installers, tasks or services. If the host's execution policy blocks
// -File, that is recorded as BLOCKED and nothing works around it. Children run inside root's reviewed FixtureJob (b82285d6), whose
// cleanup touches only this fixture's own job members. C# 5 / .NET Framework 4 (csc v4.0.30319). Exit 0 only when ALL PASS.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Enclave.Testing;

public static class ConfigNativeFixture {
  const string MigrateSha = "d2ae8f6965176045186f1da9373778ee3daeb0b6d5144d3c46b2b2c2ad54739f";
  const string FileSddl = "O:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)";            // every dummy file except the node hook
  const string NodeHookSddl = "O:SYD:PAI(A;;FR;;;SY)(A;;FA;;;BA)";        // SYSTEM-owned, a DACL distinct from the replacement's
  const string DirSddl = "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
  const int DeadlineMs = 360000, PsMs = 60000, CmdMs = 15000, Cap = 65536;
  static readonly string SY = "S-1-5-18", BA = "S-1-5-32-544";
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly List<Dictionary<string, object>> Checks = new List<Dictionary<string, object>>();
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static string stage, fx, ps, cmd; static bool blocked;
  static Dictionary<string, object> expected;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateSymbolicLinkW(string link, string target, int flags);

  static void Check(string name, bool? ok, string detail) {
    var c = new Dictionary<string, object>(); c["check"] = name; c["status"] = ok == null ? "UNKNOWN" : (ok.Value ? "PASS" : "FAIL");
    if (detail != null) c["detail"] = detail.Length > 400 ? detail.Substring(0, 400) : detail;
    Checks.Add(c); Console.Error.WriteLine(c["status"] + " " + name);
  }
  static string Sha(string p) { using (var s = SHA256.Create()) return BitConverter.ToString(s.ComputeHash(File.ReadAllBytes(p))).Replace("-", "").ToLowerInvariant(); }
  static string Owner(string p) { return File.GetAccessControl(p).GetOwner(typeof(SecurityIdentifier)).Value; }
  static string Access(string p) { return File.GetAccessControl(p).GetSecurityDescriptorSddlForm(AccessControlSections.Access); }
  static bool IsLink(string p) { var a = new FileInfo(p).Attributes; return (int)a != -1 && (a & FileAttributes.ReparsePoint) != 0; }
  static bool OnlySyBaAllowed(string p) {
    foreach (FileSystemAccessRule r in File.GetAccessControl(p).GetAccessRules(true, true, typeof(SecurityIdentifier)))
      if (r.AccessControlType == AccessControlType.Allow && r.IdentityReference.Value != SY && r.IdentityReference.Value != BA) return false;
    return true;
  }
  static void NewDir(string p) {
    if (Directory.Exists(p) || File.Exists(p)) throw new IOException("scratch path exists: " + p);
    var ds = new DirectorySecurity(); ds.SetSecurityDescriptorSddlForm(DirSddl); Directory.CreateDirectory(p, ds);
  }
  // a dummy file, private (and with its owner) from creation, exclusive
  static void WritePrivate(string p, byte[] bytes, string sddl) {
    var sec = new FileSecurity(); sec.SetSecurityDescriptorSddlForm(sddl);
    using (var f = new FileStream(p, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, sec)) { f.Write(bytes, 0, bytes.Length); f.Flush(true); }
  }

  class Child { public bool exited, timedOut, complete; public int code = -1; public string stdout = "", stderr = ""; }
  static Child Run(string file, string args, int ms) {
    var r = new Child();
    if (Clock.ElapsedMilliseconds + ms > DeadlineMs) { r.stderr = "fixture deadline"; return r; }
    var i = new ProcessStartInfo(file, args); i.UseShellExecute = false; i.CreateNoWindow = true; i.RedirectStandardOutput = true; i.RedirectStandardError = true; i.WorkingDirectory = fx;
    foreach (string k in i.EnvironmentVariables.Keys.Cast<string>().ToList()) if (k.StartsWith("ENCF_", StringComparison.OrdinalIgnoreCase)) i.EnvironmentVariables.Remove(k);
    using (var p = Process.Start(i)) {
      var o = p.StandardOutput.ReadToEndAsync(); var e = p.StandardError.ReadToEndAsync();
      r.exited = p.WaitForExit(ms); r.timedOut = !r.exited;
      if (!r.exited) { try { p.Kill(); } catch { } r.exited = p.WaitForExit(5000); }
      r.complete = r.exited && o.Wait(3000) && e.Wait(1000);
      if (r.exited) r.code = p.ExitCode;
      if (r.complete) { r.stdout = o.Result.Length > Cap ? o.Result.Substring(0, Cap) : o.Result; r.stderr = e.Result.Length > Cap ? e.Result.Substring(0, Cap) : e.Result; }
    }
    return r;
  }
  // the UNCHANGED script, by -File only; the policy in effect is whatever this process inherited (never set here)
  static Dictionary<string, object> Migrate(string root, string pins, string mode, string planSha) {
    if (blocked) return null;
    string a = "-NoProfile -NonInteractive -File \"" + Path.Combine(stage, "migrate-local-config.ps1") + "\" -Root \"" + root + "\" -Pins \"" + pins + "\" -Mode " + mode +
               (planSha != null ? " -PlanSha " + planSha : "");
    var c = Run(ps, a, PsMs);
    if (Regex.IsMatch(c.stderr + c.stdout, "running scripts is disabled|PSSecurityException|cannot be loaded because", RegexOptions.IgnoreCase)) {
      blocked = true; Check("execution policy allows -File for the staged script", false, "BLOCKED by the host's execution policy: nothing worked around"); return null; }
    if (!c.exited || c.timedOut || !c.complete || c.code != 0) { Check("powershell -File " + mode + " completed", null, "exited=" + c.exited + " timedOut=" + c.timedOut + " code=" + c.code + " " + c.stderr); return null; }
    try { return (Dictionary<string, object>)Json.DeserializeObject(c.stdout); } catch (Exception ex) { Check("powershell -File " + mode + " JSON", null, ex.Message); return null; }
  }
  static Dictionary<string, object> D(object o, string k) { var d = o as Dictionary<string, object>; return d != null && d.ContainsKey(k) ? d[k] as Dictionary<string, object> : null; }
  static string S(object o, string k) { var d = o as Dictionary<string, object>; return d != null && d.ContainsKey(k) && d[k] != null ? Convert.ToString(d[k]) : null; }
  static IEnumerable<string> Refused(Dictionary<string, object> planOut) { var p = D(planOut, "plan"); var r = p != null && p.ContainsKey("refused") ? p["refused"] as object[] : null; return r == null ? new string[0] : r.Select(x => Convert.ToString(x)); }

  static Dictionary<string, string> CmdEnv(string launcher) {
    var c = Run(cmd, "/d /c \"" + launcher + "\"", CmdMs);
    if (!c.exited || c.timedOut || !c.complete || c.code != 0) { Check("cmd.exe " + Path.GetFileName(launcher) + " ran", null, "code=" + c.code + " " + c.stderr); return null; }
    var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (string l in c.stdout.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries)) { int i = l.IndexOf('='); if (i > 0 && l.StartsWith("ENCF_", StringComparison.OrdinalIgnoreCase)) env[l.Substring(0, i)] = l.Substring(i + 1); }
    return env;
  }
  static bool SameEnv(Dictionary<string, string> a, object expectedObj) {
    var e = expectedObj as Dictionary<string, object>; if (a == null || e == null || a.Count != e.Count) return false;
    foreach (var kv in e) { string v; if (!a.TryGetValue(kv.Key, out v) || v != Convert.ToString(kv.Value)) return false; }
    return true;
  }
  static string MakeCase(string name, bool plain) {
    string d = Path.Combine(fx, name); NewDir(d);
    var map = new Dictionary<string, string> { { "run-node.cmd", plain ? "run-node.plain.cmd" : "run-node.cmd" }, { "run-shield.cmd", plain ? "run-shield.plain.cmd" : "run-shield.cmd" },
      { "node-config.cmd", "node-config.cmd" }, { "shield-config.cmd", "shield-config.cmd" }, { "node-config.local.cmd", "node-config.local.cmd" } };
    foreach (var kv in map) WritePrivate(Path.Combine(d, kv.Key), File.ReadAllBytes(Path.Combine(stage, kv.Value)), kv.Key == "node-config.local.cmd" ? NodeHookSddl : FileSddl);
    return d;
  }
  static Dictionary<string, string> Hashes(string d) { return Directory.GetFiles(d).ToDictionary(f => Path.GetFileName(f), f => IsLink(f) ? "link" : Sha(f)); }
  static bool SameHashes(Dictionary<string, string> a, Dictionary<string, string> b) { return a.Count == b.Count && a.All(kv => b.ContainsKey(kv.Key) && b[kv.Key] == kv.Value); }
  static void Rewrite(string d, string launcher, string from) { File.Delete(Path.Combine(d, launcher)); WritePrivate(Path.Combine(d, launcher), File.ReadAllBytes(Path.Combine(stage, from)), FileSddl); }

  static void MainCase() {
    var m = D(expected, "main"); string d = MakeCase("c1", false), hook = Path.Combine(d, "node-config.local.cmd");
    var node0 = CmdEnv(Path.Combine(d, "run-node.cmd")); var shield0 = CmdEnv(Path.Combine(d, "run-shield.cmd"));
    Check("cmd.exe: node launcher effective ENCF_* before migration = expected", SameEnv(node0, m["effectiveNode"]), null);
    Check("cmd.exe: shield launcher effective ENCF_* before migration = expected", SameEnv(shield0, m["effectiveShield"]), null);
    string owner0 = Owner(hook), access0 = Access(hook), sha0 = Sha(hook), runNode0 = Sha(Path.Combine(d, "run-node.cmd"));
    // the hook's DACL (SYSTEM read-only) differs from the replacement's (SYSTEM full): DACL preservation is observable
    Check("fixture node hook is SYSTEM-owned, SYSTEM read-only", owner0 == SY && access0.Contains("(A;;FR;;;SY)"), owner0 + " " + access0);
    var plan = Migrate(d, Path.Combine(stage, "pins-main.json"), "plan", null); if (plan == null) return;
    var hooks = D(D(plan, "plan"), "hooks"); string planSha = S(plan, "planSha");
    Check("plan: nothing refused", !Refused(plan).Any(), string.Join(" | ", Refused(plan)));
    Check("plan: node hook before/after = expected", S(D(hooks, "node-config.local.cmd"), "before") == S(m, "nodeLocalBefore") && S(D(hooks, "node-config.local.cmd"), "after") == S(m, "nodeLocalAfter"), null);
    Check("plan: shield hook created, after = expected", S(D(hooks, "shield-config.local.cmd"), "before") == "absent" && S(D(hooks, "shield-config.local.cmd"), "after") == S(m, "shieldLocalAfter"), null);
    var exec = Migrate(d, Path.Combine(stage, "pins-main.json"), "execute", planSha); if (exec == null) return;
    Check("execute with the exact planSha: MIGRATED", S(exec, "result") == "MIGRATED", S(exec, "error"));
    Check("node hook bytes = expected after", File.Exists(hook) && !IsLink(hook) && Sha(hook) == S(m, "nodeLocalAfter"), null);
    Check("node hook OWNER unchanged (SYSTEM)", Owner(hook) == SY, Owner(hook));
    Check("node hook DACL unchanged (exact SDDL)", Access(hook) == access0, Access(hook));
    string backup = S(D(D(exec, "done"), "node-config.local.cmd"), "backup");
    Check("backup holds the original bytes and owner", backup != null && File.Exists(backup) && Sha(backup) == sha0 && Owner(backup) == SY, backup == null ? "no backup" : Owner(backup));
    Check("backup directory is new and private", backup != null && OnlyDirSyBa(Path.GetDirectoryName(backup)), null);
    string sh = Path.Combine(d, "shield-config.local.cmd");
    Check("new shield hook: expected bytes, Administrators-owned, protected, SYSTEM/Administrators only", File.Exists(sh) && Sha(sh) == S(m, "shieldLocalAfter") && Owner(sh) == BA &&
          File.GetAccessControl(sh).AreAccessRulesProtected && OnlySyBaAllowed(sh), File.Exists(sh) ? Owner(sh) : "absent");
    Check("no replacement temp left", Directory.GetFiles(d, ".*.migrate-*.tmp").Length == 0, null);
    Check("source launcher not modified by the migration", Sha(Path.Combine(d, "run-node.cmd")) == runNode0, null);
    Rewrite(d, "run-node.cmd", "run-node.rewritten.cmd"); Rewrite(d, "run-shield.cmd", "run-shield.rewritten.cmd");
    Check("cmd.exe: after migration + launcher rewrite, node effective ENCF_* unchanged (precedence kept)", SameEnv(CmdEnv(Path.Combine(d, "run-node.cmd")), m["effectiveNode"]), null);
    Check("cmd.exe: after migration + launcher rewrite, shield effective ENCF_* unchanged", SameEnv(CmdEnv(Path.Combine(d, "run-shield.cmd")), m["effectiveShield"]), null);
    // re-plan of the migrated state: nothing left to move, nothing changes
    var pins = new Dictionary<string, object> { { "format", "enclave-local-config-pins/v1" }, { "extra", new object[0] },
      { "files", new Dictionary<string, object> { { "run-node.cmd", Sha(Path.Combine(d, "run-node.cmd")) }, { "run-shield.cmd", Sha(Path.Combine(d, "run-shield.cmd")) },
                                                  { "node-config.local.cmd", Sha(hook) }, { "shield-config.local.cmd", Sha(sh) } } },
      { "sources", new Dictionary<string, object> { { "run-node.cmd", new object[0] }, { "run-shield.cmd", new object[0] } } } };
    string pinsAfter = Path.Combine(fx, "pins-c1-after.json"); WritePrivate(pinsAfter, Encoding.ASCII.GetBytes(Json.Serialize(pins)), FileSddl);
    var before = Hashes(d); var again = Migrate(d, pinsAfter, "plan", null); if (again == null) return;
    var h2 = D(D(again, "plan"), "hooks");
    Check("re-plan after migration: nothing refused, nothing to change", !Refused(again).Any() && h2.Values.All(v => S(v, "before") == S(v, "after")), string.Join(" | ", Refused(again)));
    Check("re-plan wrote nothing", SameHashes(before, Hashes(d)), null);
  }
  static bool OnlyDirSyBa(string p) {
    var a = Directory.GetAccessControl(p); if (!a.AreAccessRulesProtected) return false;
    foreach (FileSystemAccessRule r in a.GetAccessRules(true, true, typeof(SecurityIdentifier))) if (r.AccessControlType == AccessControlType.Allow && r.IdentityReference.Value != SY && r.IdentityReference.Value != BA) return false;
    var o = a.GetOwner(typeof(SecurityIdentifier)).Value; return o == SY || o == BA;
  }
  static void ControlCase() {
    var c = D(expected, "controlRewriteWithoutMigration"); var m = D(expected, "main"); string d = MakeCase("c1-control", false);
    Rewrite(d, "run-node.cmd", "run-node.rewritten.cmd"); Rewrite(d, "run-shield.cmd", "run-shield.rewritten.cmd");
    var n = CmdEnv(Path.Combine(d, "run-node.cmd")); var s = CmdEnv(Path.Combine(d, "run-shield.cmd"));
    Func<Dictionary<string, string>, Dictionary<string, object>, string> lost = (got, want) => got == null ? null :
      string.Join(",", want.Where(kv => { string v; return !got.TryGetValue(kv.Key, out v) || v != Convert.ToString(kv.Value); }).Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal));
    Check("cmd.exe CONTROL: a rewrite WITHOUT migration loses exactly the expected node settings",
          lost(n, (Dictionary<string, object>)m["effectiveNode"]) == string.Join(",", ((object[])c["nodeLostOrChanged"]).Select(x => Convert.ToString(x))), lost(n, (Dictionary<string, object>)m["effectiveNode"]));
    Check("cmd.exe CONTROL: ... and the expected shield setting",
          lost(s, (Dictionary<string, object>)m["effectiveShield"]) == string.Join(",", ((object[])c["shieldLostOrChanged"]).Select(x => Convert.ToString(x))), null);
  }
  static void PlainCase() {
    string d = MakeCase("c3-plain", true); var before = Hashes(d); string hook = Path.Combine(d, "node-config.local.cmd"), o0 = Owner(hook);
    var plan = Migrate(d, Path.Combine(stage, "pins-plain.json"), "plan", null); if (plan == null) return;
    var hooks = D(D(plan, "plan"), "hooks");
    Check("plain: nothing refused, nothing to move, shield hook stays absent", !Refused(plan).Any() && hooks.Values.All(v => S(v, "before") == S(v, "after")) && S(D(hooks, "shield-config.local.cmd"), "after") == "absent", null);
    var exec = Migrate(d, Path.Combine(stage, "pins-plain.json"), "execute", S(plan, "planSha")); if (exec == null) return;
    Check("plain: execute MIGRATED with no write", S(exec, "result") == "MIGRATED" && SameHashes(before, Hashes(d)) && !File.Exists(Path.Combine(d, "shield-config.local.cmd")) && Owner(hook) == o0, null);
  }
  static void RefusalCases() {
    string d = MakeCase("c4-badpin", false); var before = Hashes(d);
    var plan = Migrate(d, Path.Combine(stage, "pins-badpin.json"), "plan", null);
    if (plan != null) {
      Check("bad pin: plan REFUSED (value-hash list)", Refused(plan).Any(x => x.Contains(S(D(expected, "badpin"), "refusedContains"))), string.Join(" | ", Refused(plan)));
      var exec = Migrate(d, Path.Combine(stage, "pins-badpin.json"), "execute", S(plan, "planSha"));
      if (exec != null) Check("bad pin: execute REFUSED, nothing written", S(exec, "result") == "REFUSED" && SameHashes(before, Hashes(d)), S(exec, "result"));
    }
    d = MakeCase("c5-wrongplansha", false); before = Hashes(d);
    var x5 = Migrate(d, Path.Combine(stage, "pins-main.json"), "execute", new string('f', 64));
    if (x5 != null) Check("wrong planSha: REFUSED, nothing written", S(x5, "result") == "REFUSED" && SameHashes(before, Hashes(d)), S(x5, "result"));
  }
  static void LinkCases(List<string> links) {
    // file symbolic link at the node hook (needs SeCreateSymbolicLinkPrivilege in this token: UNKNOWN when not held; never enabled)
    string d = MakeCase("c6-symlink", false), hook = Path.Combine(d, "node-config.local.cmd"), target = Path.Combine(d, "link-target.cmd");
    WritePrivate(target, File.ReadAllBytes(Path.Combine(stage, "link-target.cmd")), FileSddl); File.Delete(hook);
    if (!CreateSymbolicLinkW(hook, target, 0)) Check("symlink hook refused", null, "symbolic link not supported for this token (Win32 " + Marshal.GetLastWin32Error() + ")");
    else {
      links.Add(hook); string t0 = Sha(target);
      var plan = Migrate(d, Path.Combine(stage, "pins-main.json"), "plan", null);
      if (plan != null) {
        Check("symlink hook: plan REFUSED (reparse point)", Refused(plan).Any(x => x.Contains("reparse point")), string.Join(" | ", Refused(plan)));
        var exec = Migrate(d, Path.Combine(stage, "pins-main.json"), "execute", S(plan, "planSha"));
        if (exec != null) Check("symlink hook: execute REFUSED, link target unchanged", S(exec, "result") == "REFUSED" && Sha(target) == t0, S(exec, "result"));
      }
    }
    // a directory junction as the root (no privilege needed), made by cmd.exe's mklink inside this scratch tree only
    string real = MakeCase("c7-junction-target", false), j = Path.Combine(fx, "c7-junction"); var before = Hashes(real);
    var mk = Run(cmd, "/d /c mklink /J \"" + j + "\" \"" + real + "\"", CmdMs);
    if (!(mk.exited && mk.code == 0 && Directory.Exists(j) && IsLink(j))) Check("junction root refused", null, "junction not created: code=" + mk.code);
    else {
      links.Add(j);
      var plan = Migrate(j, Path.Combine(stage, "pins-main.json"), "plan", null);
      if (plan != null) {
        Check("junction root: plan REFUSED (root reparse point)", Refused(plan).Any(x => x.Contains("root directory unsafe: a reparse point")), string.Join(" | ", Refused(plan)));
        var exec = Migrate(j, Path.Combine(stage, "pins-main.json"), "execute", S(plan, "planSha"));
        if (exec != null) Check("junction root: execute REFUSED, target unchanged", S(exec, "result") == "REFUSED" && SameHashes(before, Hashes(real)), S(exec, "result"));
      }
    }
  }
  // links removed by this fixture (the LINK only, never through it); then no reparse point may remain anywhere under fx
  static int RemoveLinks(List<string> links) {
    foreach (string l in links) { try { if (Directory.Exists(l)) Directory.Delete(l, false); else File.Delete(l); } catch { } }
    int left = 0; var todo = new Stack<string>(); todo.Push(fx);
    while (todo.Count > 0) { string dir = todo.Pop();
      foreach (string e in Directory.GetFileSystemEntries(dir)) { if (IsLink(e)) { left++; continue; } if (Directory.Exists(e)) todo.Push(e); } }
    return left;
  }

  public static int Main(string[] args) {
    var result = new Dictionary<string, object>(); var links = new List<string>(); int reparseLeft = -1; JobCleanup jc = null; bool ready = false;
    FixtureJob job = null;
    try {
      if (args.Length != 1) throw new Exception("one stage argument required");
      stage = Path.GetFullPath(args[0]);
      if (!Regex.IsMatch(stage, @"^C:\\ProgramData\\Enclave\\staging\\config-native-fixture-[0-9a-f]{12}$", RegexOptions.IgnoreCase) || !Directory.Exists(stage) || IsLink(stage)) throw new Exception("wrong stage");
      if (Sha(Path.Combine(stage, "migrate-local-config.ps1")) != MigrateSha) throw new Exception("migrate-local-config.ps1 is not the pinned r3");
      var manifest = (Dictionary<string, object>)Json.DeserializeObject(File.ReadAllText(Path.Combine(stage, "fixture-manifest.json")));
      foreach (var kv in (Dictionary<string, object>)manifest["files"]) if (Sha(Path.Combine(stage, kv.Key)) != Convert.ToString(kv.Value)) throw new Exception("pin differs: " + kv.Key);
      expected = (Dictionary<string, object>)Json.DeserializeObject(File.ReadAllText(Path.Combine(stage, "expected.json")));
      ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
      cmd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
      job = new FixtureJob();
      fx = Path.Combine(stage, "fx"); NewDir(fx);
      Check("scratch tree private from creation", OnlyDirSyBa(fx), null);
      ready = true;
      var pol = Run(ps, "-NoProfile -NonInteractive -Command \"Get-ExecutionPolicy -List | ForEach-Object { $_.Scope.ToString() + '=' + $_.ExecutionPolicy.ToString() }\"", PsMs);
      result["executionPolicyAsInherited"] = pol.complete ? pol.stdout.Trim() : "unknown";
      MainCase(); ControlCase(); PlainCase(); RefusalCases(); LinkCases(links);
    } catch (Exception e) { Check("fixture ran", false, e.GetType().Name + ": " + e.Message); }
    finally {
      try { if (ready) reparseLeft = RemoveLinks(links); } catch (Exception e) { Check("links removed", null, e.Message); }
      if (job != null) { jc = job.StopChildren(10000); job.Dispose(); }
    }
    bool allPass = Checks.Count > 0 && Checks.All(c => (string)c["status"] == "PASS") && !blocked;
    bool cleanupClean = reparseLeft == 0 && jc != null && jc.ok;
    result["fixture"] = "config-native-fixture"; result["stage"] = stage; result["checks"] = Checks; result["blockedByExecutionPolicy"] = blocked;
    result["reparseLeft"] = reparseLeft; result["jobCleanup"] = jc == null ? null : new Dictionary<string, object> { { "ok", jc.ok }, { "found", jc.found }, { "killed", jc.killed }, { "why", jc.why } };
    result["counts"] = Checks.GroupBy(c => (string)c["status"]).ToDictionary(g => g.Key, g => (object)g.Count());
    result["allPass"] = allPass; result["cleanupClean"] = cleanupClean; result["elapsedMs"] = Clock.ElapsedMilliseconds;
    Console.WriteLine(Json.Serialize(result));
    if (allPass && cleanupClean) { Console.WriteLine("ALL PASS"); return 0; }
    return 1;
  }
}
