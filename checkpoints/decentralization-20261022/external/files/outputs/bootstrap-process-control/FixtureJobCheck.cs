using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Enclave.Testing;

public static class FixtureJobCheck {
    static Process Start(string args, bool redirect) {
        ProcessStartInfo info = new ProcessStartInfo(typeof(FixtureJobCheck).Assembly.Location, args);
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardOutput = redirect; info.RedirectStandardError = redirect;
        return Process.Start(info);
    }
    static void Check(bool pass, string label) {
        Console.WriteLine((pass ? "PASS " : "FAIL ") + label);
        if (!pass) throw new Exception(label);
    }
    public static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "hold") { Thread.Sleep(60000); return 0; }
        if (args.Length == 2 && args[0] == "orphan") {
            using (Process child = Start("hold", false)) {
                File.WriteAllText(args[1], child.Id.ToString());
                Console.WriteLine("parent ready"); Console.Out.Flush();
                Thread.Sleep(60000);
            }
            return 0;
        }
        if (args.Length != 1) return 2;
        string work = Path.GetFullPath(args[0]);
        if (!Directory.Exists(work) || work.IndexOf('"') >= 0) return 2;
        Process decoy = null, parent = null, orphan = null;
        FixtureJob job = null;
        try {
            // Before joining the inner job: a deliberate decoy whose command line
            // mentions the same work folder. Only this retained handle owns it.
            decoy = Start("hold \"" + work + "\"", false);
            job = new FixtureJob();
            Check(!job.Contains(decoy.Handle), "same-path decoy is outside fixture job");
            string pidFile = Path.Combine(work, "orphan.pid");
            parent = Start("orphan \"" + pidFile + "\"", true);
            var stdout = parent.StandardOutput.ReadToEndAsync();
            var stderr = parent.StandardError.ReadToEndAsync();
            Stopwatch wait = Stopwatch.StartNew();
            while ((!File.Exists(pidFile) || new FileInfo(pidFile).Length == 0) && wait.ElapsedMilliseconds < 5000) Thread.Sleep(10);
            int pid = int.Parse(File.ReadAllText(pidFile));
            orphan = Process.GetProcessById(pid);
            Check(job.Contains(parent.Handle) && job.Contains(orphan.Handle), "child and grandchild inherit job membership");
            JobCleanup zero = job.StopChildren(0);
            Check(!zero.ok && !parent.HasExited, "zero budget cannot report cleanup success");
            parent.Kill(); Check(parent.WaitForExit(2000), "direct parent stopped through its retained handle");
            Check(!orphan.HasExited && !stdout.Wait(100), "orphan holds output after parent exit");
            JobCleanup result = job.StopChildren(8000);
            Check(result.ok && orphan.WaitForExit(0), "orphan stopped and entire job drained");
            Check(stdout.Wait(1000) && stderr.Wait(1000) && stdout.Result.Contains("parent ready"), "inherited output completes after cleanup");
            Check(!decoy.HasExited, "unrelated same-path decoy survives cleanup");
            Check(job.StopChildren(1000).ok, "repeated cleanup is safe");
            job.Dispose(); Check(!job.StopChildren(1000).ok, "unavailable job never reports clean");
            Console.WriteLine("ALL PASS"); return 0;
        } catch (Exception e) { Console.WriteLine("FAIL " + e); return 1; }
        finally {
            if (job != null) { JobCleanup last = job.StopChildren(8000); job.Dispose(); }
            if (decoy != null) { if (!decoy.HasExited) decoy.Kill(); decoy.WaitForExit(3000); decoy.Dispose(); }
            if (parent != null) parent.Dispose();
            if (orphan != null) orphan.Dispose();
        }
    }
}
