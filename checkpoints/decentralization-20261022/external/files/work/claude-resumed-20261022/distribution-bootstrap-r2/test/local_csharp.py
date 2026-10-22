#!/usr/bin/env python3
"""LOCAL regression tests of the EnclaveSetup.cs bootstrap fixes (Linux pwsh 7 Add-Type / Roslyn on .NET 8; NOT Windows, NOT the
in-box csc: the native fixture is the proof). The EXACT member texts are extracted from the source (never retyped):
SetupProgram.QuoteArgs, SetupForm.Sha256, SetupForm.ReadBounded, SetupForm.PinPolicy(string, SetupOptions) and the whole
SetupOptions class; a test-only stand-in for System.Web.Script.Serialization.JavaScriptSerializer (absent on .NET 8) is the only
addition.
  local_csharp.py SRC [--frozen|--r1]   --frozen: negative control on the unpatched source (no pinning: the swap wins)
                                        --r1: negative control on r1 6d707db7 (Length checked, then an unbounded read: a growing
                                        input whose Length reads small is pinned past 64 KiB)
The growing input is a FIFO (Length 0, 70000 bytes written by a thread): a Linux stand-in for "the bytes outrun the Length that
was checked". The Windows sharing-mode refusal (another writer holds the file open) is the native fixture's check P8."""
import json, os, pathlib, re, subprocess, sys, tempfile

PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
src = pathlib.Path(sys.argv[1]).read_text(); FROZEN = '--frozen' in sys.argv; R1 = '--r1' in sys.argv

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
    // a stream whose Length says 10 but which yields `total` bytes (the bound must hold on the bytes read)
    class GrowingStream : Stream {
      long total, pos; public GrowingStream(long t) { total = t; }
      public override bool CanRead { get { return true; } } public override bool CanSeek { get { return false; } } public override bool CanWrite { get { return false; } }
      public override long Length { get { return 10; } } public override long Position { get { return pos; } set { throw new NotSupportedException(); } }
      public override int Read(byte[] b, int o, int c) { int n = (int)Math.Min(c, Math.Min(4096, total - pos)); for (int i = 0; i < n; i++) b[o + i] = (byte)'a'; pos += n; return n; }
      public override void Flush() { } public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
      public override void SetLength(long v) { throw new NotSupportedException(); } public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
    }
    // the FIFO's writer: 70000 bytes, then close; a reader that stops early makes the write fail, which is expected
    public static System.Threading.Thread Feed(string fifo, int n) {
      var t = new System.Threading.Thread(delegate () { try { using (var f = new FileStream(fifo, FileMode.Open, FileAccess.Write)) f.Write(new byte[n], 0, n); } catch (Exception) { } });
      t.IsBackground = true; t.Start(); return t;
    }
    public static bool NoTemp(string d) { return Directory.GetFiles(d, "*.tmp-*").Length == 0; }
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
      Check("P6 an oversized policy is refused before any copy", Throws(delegate { SetupForm.PinPolicy(wd2, big); }, "missing or too large") && !File.Exists(Path.Combine(wd2, "release-policy.pinned.json")) && NoTemp(wd2));
      Check("R1 ReadBounded: a stream whose Length says 10 but yields 70000 bytes is refused", Throws(delegate { SetupForm.ReadBounded(new GrowingStream(70000), 65536); }, "more than 65536"));
      Check("R2 ReadBounded: exactly 65536 bytes are returned whole; 65537 are refused", SetupForm.ReadBounded(new GrowingStream(65536), 65536).Length == 65536 && Throws(delegate { SetupForm.ReadBounded(new GrowingStream(65537), 65536); }, "more than 65536"));
      var gr = new SetupOptions(); string fifo = Path.Combine(work, "grow.fifo"); gr.Take("--release-policy", fifo); string wd3 = Path.Combine(work, "wd3"); Directory.CreateDirectory(wd3);
      var th = Feed(fifo, 70000);
      Check("P7 a growing input (Length 0, 70000 bytes) is refused while reading; nothing is published", Throws(delegate { SetupForm.PinPolicy(wd3, gr); }, "missing or too large") && !File.Exists(Path.Combine(wd3, "release-policy.pinned.json")) && NoTemp(wd3) && gr.PolicySha256 == null);
      th.Join(10000);
      var ex = new SetupOptions(); string exf = Path.Combine(user, "exact.json"); File.WriteAllText(exf, new string(' ', 65536)); ex.Take("--release-policy", exf);
      string wd4 = Path.Combine(work, "wd4"); Directory.CreateDirectory(wd4); File.WriteAllText(Path.Combine(wd4, "release-policy.pinned.json"), "stale");
      SetupForm.PinPolicy(wd4, ex);
      Check("P8 exactly 64 KiB pins whole, replacing a stale copy; no temp file is left", File.ReadAllText(Path.Combine(wd4, "release-policy.pinned.json")).Length == 65536 && ex.ReleasePolicy == Path.Combine(wd4, "release-policy.pinned.json") && NoTemp(wd4));
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
    elif R1:   # r1's own PinPolicy: the growing FIFO passes its Length check and is copied whole, past the bound
        r1_tests = r'''
  public static class LocalCheck {
    public static string[] Run(string work, string policyJson, bool frozen) {
      string fifo = Path.Combine(work, "grow.fifo"), wd = Path.Combine(work, "wd"); Directory.CreateDirectory(wd);
      var opt = new SetupOptions(); opt.Take("--release-policy", fifo);
      var t = new System.Threading.Thread(delegate () { try { using (var f = new FileStream(fifo, FileMode.Open, FileAccess.Write)) f.Write(new byte[70000], 0, 70000); } catch (Exception) { } });
      t.IsBackground = true; t.Start();
      string r; try { SetupForm.PinPolicy(wd, opt); r = new FileInfo(Path.Combine(wd, "release-policy.pinned.json")).Length.ToString(); } catch (Exception e) { r = "refused: " + e.Message; }
      t.Join(10000);
      return new[] { (r == "70000" ? "PASS " : "FAIL ") + "NEGATIVE r1: the growing input passed the Length check and was pinned at " + r + " bytes (> 65536)" };
    }
  }'''
        pin = member('internal static void PinPolicy(string workDir, SetupOptions opt)'); sh = member('static string Sha256(string path)')
        body = 'namespace Enclave.Setup {\n static class SetupForm {\n' + sh + '\n' + pin + '\n }\n' + opts + r1_tests + '\n}'
    else:
        q = member('internal static string QuoteArgs'); pin = member('internal static void PinPolicy(string workDir, SetupOptions opt)'); sh = member('static string Sha256(string path)')
        rb = member('internal static byte[] ReadBounded(Stream s, int max)')
        if 'FileInfo' in pin or 'ReadAllBytes(opt.ReleasePolicy' in pin: raise SystemExit('PinPolicy still checks a Length and then reads unbounded')
        body = 'namespace Enclave.Setup {\n static class SetupProgram {\n' + q + '\n }\n static class SetupForm {\n' + sh + '\n' + rb + '\n' + pin + '\n }\n' + opts + TESTS + '\n}'
    return using + STANDIN + '\n' + body

def main():
    code = build(); t = pathlib.Path(tempfile.mkdtemp(prefix='bootstrap-cs-')); (t / 'shim.cs').write_text(code)
    policy = json.dumps({'format': 'enclave-windows-release-policy/v1', 'channel': 'test', 'keys': ['ecdsa-p256:TEST-ONLY-NOT-PARSED-HERE'], 'threshold': 1, 'mirrors': ['https://mirror.invalid/windows/']})
    ps = f"$ErrorActionPreference='Stop'; Add-Type -IgnoreWarnings -TypeDefinition ([IO.File]::ReadAllText('{t / 'shim.cs'}')) -ReferencedAssemblies System.Memory,System.Text.Json,System.Text.RegularExpressions,System.Security.Cryptography,System.Collections,System.Runtime,System.Console,System.Threading,System.Threading.Thread 2>&1; " \
         f"[Enclave.Setup.LocalCheck]::Run('{t / 'w'}', [IO.File]::ReadAllText('{t / 'p.json'}'), ${'true' if FROZEN else 'false'})"
    (t / 'p.json').write_text(policy); (t / 'w').mkdir(); os.mkfifo(t / 'w' / 'grow.fifo')
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True, timeout=300)
    lines = [l for l in r.stdout.splitlines() if l.startswith(('PASS', 'FAIL'))]
    print('\n'.join(lines) or (r.stdout[-2000:] + r.stderr[-2000:]))
    import shutil; shutil.rmtree(t, ignore_errors=True)
    ok = r.returncode == 0 and lines and all(l.startswith('PASS') for l in lines)
    print(json.dumps({'pass': sum(l.startswith('PASS') for l in lines), 'fail': sum(l.startswith('FAIL') for l in lines), 'frozen': FROZEN, 'r1': R1}))
    return 0 if ok else 1

if __name__ == '__main__': sys.exit(main())
