#!/usr/bin/env python3
"""LOCAL regression tests of the EnclaveSetup.cs bootstrap fixes (Linux pwsh 7 Add-Type / Roslyn on .NET 8; NOT Windows, NOT the
in-box csc: the native fixture is the proof). The EXACT member texts are extracted from the source (never retyped):
SetupProgram.QuoteArgs, SetupForm.Sha256, SetupForm.PinPolicy(string, SetupOptions) and the whole SetupOptions class; a
test-only stand-in for System.Web.Script.Serialization.JavaScriptSerializer (absent on .NET 8) is the only addition.
  local_csharp.py SRC [--frozen]   --frozen: negative control on the unpatched source (no pinning: the swap wins)"""
import json, pathlib, re, subprocess, sys, tempfile

PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
src = pathlib.Path(sys.argv[1]).read_text(); FROZEN = '--frozen' in sys.argv

def member(sig):   # the member starting at `sig`, through its matching closing brace
    i = src.index(sig); j = src.index('{', i); d = 0
    for k in range(j, len(src)):
        d += {'{': 1, '}': -1}.get(src[k], 0)
        if d == 0: return src[i:k + 1]
    raise SystemExit('unbalanced ' + sig)
def klass(name):
    i = src.index(f'    sealed class {name}'); return member(src[i:src.index('\n', i)].strip()) if False else member(f'sealed class {name}')

STANDIN = r'''
namespace System.Web.Script.Serialization {
  public class JavaScriptSerializer {   // TEST-ONLY stand-in (Windows has the real one in System.Web.Extensions)
    public string Serialize(object o) { return System.Text.Json.JsonSerializer.Serialize(o); }
    public T Deserialize<T>(string s) {
      var d = new System.Collections.Generic.Dictionary<string, object>();
      foreach (var p in System.Text.Json.JsonDocument.Parse(s).RootElement.EnumerateObject())
        d[p.Name] = p.Value.ValueKind == System.Text.Json.JsonValueKind.String ? (object)p.Value.GetString() : p.Value.ValueKind == System.Text.Json.JsonValueKind.True ? (object)true : p.Value.ValueKind == System.Text.Json.JsonValueKind.False ? (object)false : null;
      return (T)(object)d;
    }
  }
}'''
TESTS = r'''
  public static class LocalCheck {
    static System.Collections.Generic.List<string> L = new System.Collections.Generic.List<string>();
    static void Check(string n, bool ok) { L.Add((ok ? "PASS " : "FAIL ") + n); }
    static bool Throws(Action a, string w) { try { a(); return false; } catch (Exception e) { return e.Message.Contains(w); } }
    // Windows' documented argv rules (CommandLineToArgvW / CRT): reference parser for the round trip
    static string[] Split(string c) {
      var r = new System.Collections.Generic.List<string>(); int i = 0;
      while (i < c.Length) {
        while (i < c.Length && (c[i] == ' ' || c[i] == '\t')) i++; if (i >= c.Length) break;
        var b = new StringBuilder(); bool q = false;
        while (i < c.Length && (q || (c[i] != ' ' && c[i] != '\t'))) {
          int n = 0; while (i < c.Length && c[i] == '\\') { n++; i++; }
          if (i < c.Length && c[i] == '"') { b.Append('\\', n / 2); if (n % 2 == 1) { b.Append('"'); i++; } else { if (q && i + 1 < c.Length && c[i + 1] == '"') { b.Append('"'); i += 2; continue; } q = !q; i++; } }
          else { b.Append('\\', n); if (i < c.Length && !( !q && (c[i] == ' ' || c[i] == '\t'))) { b.Append(c[i]); i++; } }
        }
        r.Add(b.ToString());
      }
      return r.ToArray();
    }
    static bool Same(string[] a, string[] b) { if (a.Length != b.Length) return false; for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }
    public static string[] Run(string work, string policyJson, bool frozen) {
      string user = Path.Combine(work, "user"), wd = Path.Combine(work, "Enclave-setup"); Directory.CreateDirectory(user); Directory.CreateDirectory(wd);
      string given = Path.Combine(user, "release policy.json"); File.WriteAllText(given, policyJson); string pinned = Path.Combine(wd, "release-policy.pinned.json");
      var opt = new SetupOptions(); opt.Take("--release-policy", given);
      if (frozen) {
        File.WriteAllText(given, policyJson.Replace("test", "attacker"));
        Check("NEGATIVE frozen: install-host is handed the operator path, whose bytes were swapped after the download", opt.InstallArgs().Contains("\"" + given + "\"") && File.ReadAllText(given).Contains("attacker"));
        return L.ToArray();
      }
      SetupForm.PinPolicy(wd, opt);
      Check("P1 pinned into the work folder with its sha256; options point at the copy", opt.ReleasePolicy == pinned && File.ReadAllText(pinned) == policyJson && opt.PolicySha256.Length == 64);
      File.WriteAllText(given, policyJson.Replace("test", "attacker")); SetupForm.PinPolicy(wd, opt);
      Check("P2 a swapped operator file changes nothing; install-host gets the pinned copy", File.ReadAllText(pinned) == policyJson && opt.InstallArgs().Contains("\"" + pinned + "\"") && !opt.InstallArgs().Contains(given));
      File.WriteAllText(pinned, policyJson + " "); Check("P3 a changed pinned copy stops setup", Throws(delegate { SetupForm.PinPolicy(wd, opt); }, "changed or is missing")); File.WriteAllText(pinned, policyJson);
      string saved = Path.Combine(wd, "setup-options.json"); opt.Save(saved); var back = SetupOptions.Load(saved);
      Check("P4 restart round trip keeps the pinned path and sha256", back.ReleasePolicy == pinned && back.PolicySha256 == opt.PolicySha256);
      File.Delete(pinned); Check("P4b a pinned copy removed across the restart stops setup", Throws(delegate { SetupForm.PinPolicy(wd, back); }, "changed or is missing")); File.WriteAllText(pinned, policyJson);
      back.ReleasePolicy = given; Check("P5 saved options naming another path are refused", Throws(delegate { SetupForm.PinPolicy(wd, back); }, "not the copy pinned"));
      var big = new SetupOptions(); string bf = Path.Combine(user, "big.json"); File.WriteAllText(bf, new string(' ', 70000)); big.Take("--release-policy", bf);
      string wd2 = Path.Combine(work, "wd2"); Directory.CreateDirectory(wd2);
      Check("P6 an oversized policy is refused before any copy", Throws(delegate { SetupForm.PinPolicy(wd2, big); }, "missing or too large") && !File.Exists(Path.Combine(wd2, "release-policy.pinned.json")));
      var cases = new[] { new[] { "--release-policy", @"C:\Users\op\My Policies\p.json", "--referral", "abc" }, new[] { "--release-policy", @"C:\dir with space\" },
                          new[] { "--x", "say \"hi\"" }, new[] { "--empty", "" }, new[] { @"C:\a\\b\", "tab\tinside" }, new[] { "--uninstall" } };
      bool all = true; foreach (var c in cases) all &= Same(Split(SetupProgram.QuoteArgs(c)), c);
      Check("Q1 QuoteArgs round-trips (reference argv rules)", all);
      Check("Q2 negative control: string.Join splits the spaced path", !Same(Split(string.Join(" ", cases[0])), cases[0]));
      return L.ToArray();
    }
  }'''

def build():
    using = 'using System; using System.Collections.Generic; using System.IO; using System.Security.Cryptography; using System.Text; using System.Text.RegularExpressions; using System.Web.Script.Serialization;\n'
    opts = member('sealed class SetupOptions')
    if FROZEN:   # the unpatched source: only its own SetupOptions, and only the old flow
        frozen_tests = r'''
  public static class LocalCheck {
    public static string[] Run(string work, string policyJson, bool frozen) {
      string user = Path.Combine(work, "user"); Directory.CreateDirectory(user); string given = Path.Combine(user, "release policy.json"); File.WriteAllText(given, policyJson);
      var opt = new SetupOptions(); opt.Take("--release-policy", given);
      File.WriteAllText(given, policyJson.Replace("test", "attacker"));   // another account swaps the operator's file after the download
      bool handed = opt.InstallArgs().Contains("\"" + given + "\"") && File.ReadAllText(given).Contains("attacker");
      return new[] { (handed ? "PASS " : "FAIL ") + "NEGATIVE frozen: install-host is handed the operator path, whose bytes were swapped after the download" };
    }
  }'''
        body = 'namespace Enclave.Setup {\n' + opts + frozen_tests + '\n}'
    else:
        q = member('internal static string QuoteArgs'); pin = member('internal static void PinPolicy(string workDir, SetupOptions opt)'); sh = member('static string Sha256(string path)')
        body = 'namespace Enclave.Setup {\n static class SetupProgram {\n' + q + '\n }\n static class SetupForm {\n' + sh + '\n' + pin + '\n }\n' + opts + TESTS + '\n}'
    return using + STANDIN + '\n' + body

def main():
    code = build(); t = pathlib.Path(tempfile.mkdtemp(prefix='bootstrap-cs-')); (t / 'shim.cs').write_text(code)
    policy = json.dumps({'format': 'enclave-windows-release-policy/v1', 'channel': 'test', 'keys': ['ecdsa-p256:TEST-ONLY-NOT-PARSED-HERE'], 'threshold': 1, 'mirrors': ['https://mirror.invalid/windows/']})
    ps = f"$ErrorActionPreference='Stop'; Add-Type -IgnoreWarnings -TypeDefinition ([IO.File]::ReadAllText('{t / 'shim.cs'}')) -ReferencedAssemblies System.Memory,System.Text.Json,System.Text.RegularExpressions,System.Security.Cryptography,System.Collections,System.Runtime,System.Console 2>&1; " \
         f"[Enclave.Setup.LocalCheck]::Run('{t / 'w'}', [IO.File]::ReadAllText('{t / 'p.json'}'), ${'true' if FROZEN else 'false'})"
    (t / 'p.json').write_text(policy); (t / 'w').mkdir()
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True, timeout=300)
    lines = [l for l in r.stdout.splitlines() if l.startswith(('PASS', 'FAIL'))]
    print('\n'.join(lines) or (r.stdout[-2000:] + r.stderr[-2000:]))
    import shutil; shutil.rmtree(t, ignore_errors=True)
    ok = r.returncode == 0 and lines and all(l.startswith('PASS') for l in lines)
    print(json.dumps({'pass': sum(l.startswith('PASS') for l in lines), 'fail': sum(l.startswith('FAIL') for l in lines), 'frozen': FROZEN}))
    return 0 if ok else 1

if __name__ == '__main__': sys.exit(main())
