// Inert hosted-CI qualification only. No VM/provider API, service, network or DB.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Enclave.OwnedRpc;

static partial class Harness {
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    static string Exe { get { return Process.GetCurrentProcess().MainModule.FileName; } }
    static string Quote(string value) {
        if (value.IndexOf('"')>=0 || value.IndexOf('\n')>=0) throw new ArgumentException("Unexpected fixture path");
        return "\""+value+"\"";
    }
    static Dictionary<string,string> Env() {
        return new Dictionary<string,string> {
            {"SystemRoot",Environment.GetEnvironmentVariable("SystemRoot")},
            {"WINDIR",Environment.GetEnvironmentVariable("WINDIR")},
            {"TEMP",Path.GetTempPath()}, {"TMP",Path.GetTempPath()}
        };
    }
    static void Identity(string path) {
        using (var p=Process.GetCurrentProcess())
        using (var f=new StreamWriter(new FileStream(path+".pending",FileMode.CreateNew,FileAccess.Write,FileShare.None)))
            f.Write(p.Id+","+p.StartTime.ToUniversalTime().ToFileTimeUtc());
        File.Move(path+".pending",path);
    }
    static Process Observe(string path,int budget) {
        var clock=Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds<budget) {
            if (File.Exists(path)) {
                string[] fields=File.ReadAllText(path).Split(',');
                if (fields.Length==2 && fields[1].Length>0) {
                    var p=Process.GetProcessById(Int32.Parse(fields[0]));
                    // Acquire the exact live handle now, before any parent termination.
                    IntPtr held=p.Handle;
                    if (p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(fields[1])) {
                        p.Dispose(); throw new Exception("Fixture process incarnation differs");
                    }
                    return p;
                }
            }
            Thread.Sleep(10);
        }
        throw new Exception("Exact fixture identity unavailable");
    }
    static WorkerResult Run(string mode,string record,int duration) {
        return BoundedWorker.Run(Exe,Quote(Exe)+" helper "+mode+" "+Quote(record),
            Path.GetDirectoryName(Exe),Env(),BoundedWorker.MonotonicMilliseconds()+duration,2000,128UL*1024*1024);
    }
    static WorkerResult Guard(string record,int duration,Func<SuspendedWorkerBinding,bool> bind) {
        return BoundedWorker.RunGuarded(Exe,Quote(Exe)+" helper zero "+Quote(record),
            Path.GetDirectoryName(Exe),Env(),BoundedWorker.MonotonicMilliseconds()+duration,2000,128UL*1024*1024,bind);
    }
    static bool Closed(WorkerResult r) {
        return r.ProcessCreated && r.ProcessId>0 && r.CreationFileTime>0 && r.ExitCodeKnown &&
            r.ProcessExited && r.JobEmpty && r.HandleCleanupConfirmed && r.JobLimitsVerified &&
            r.InitialMembershipVerified &&
            !r.ProviderOperationFenced && !r.ReservationMayRelease;
    }
    static bool Dead(WorkerResult r) { return Closed(r) && String.IsNullOrEmpty(r.Failure); }
    static void Check(string name,bool passed,object details) {
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {name=name,passed=passed,details=details}));
        if (!passed) throw new Exception("Fixture failed: "+name);
    }
    static int Helper(string mode,string path) {
        Identity(path);
        if (mode=="invalid-observer-clock") {
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
            try {BoundedWorker.ArmOwnerObserver(Int64.MinValue,Int64.MaxValue,new string('a',128));}
            catch(ArgumentOutOfRangeException) {return 74;}
            return 75;
        }
        if (mode=="invalid-envelope") {
            bool rejected=false;
            try { BoundedWorker.EnterSupervisorEnvelope(1); }
            catch(ArgumentOutOfRangeException) { rejected=true; }
            if (!rejected) return 72;
            try { Run("zero",path+".unexpected",1000); }
            catch(InvalidOperationException) { return 71; }
            return 73;
        }
        if (mode=="zero") return 0;
        if (mode=="seven") return 7;
        if (mode=="sleep") { Thread.Sleep(5000); return 0; }
        if (mode=="descendant") {
            var info=new ProcessStartInfo(Exe,"helper sleep "+Quote(path+".child"));
            info.UseShellExecute=false; info.CreateNoWindow=true;
            using (var child=Process.Start(info)) { Thread.Sleep(1500); }
            return 0;
        }
        if (mode=="memory") {
            // Intrinsically bounded at 192MiB even if the candidate limit fails.
            try {
                var blocks=new List<byte[]>();
                for (int i=0;i<192;i++) { var b=new byte[1024*1024]; b[0]=1; blocks.Add(b); }
                GC.KeepAlive(blocks); return 0;
            } catch (OutOfMemoryException) { return 70; }
        }
        return 99;
    }
    static int Main(string[] args) {
        try {
            if (args.Length==5 && args[0]=="system-probe") return SystemProbe(args[1],args[2],Int64.Parse(args[3]),Int64.Parse(args[4]));
            if (args.Length==6 && args[0]=="observed-owner") return OwnerRole(args[1],args[2],args[3],Int64.Parse(args[4]),Int64.Parse(args[5]));
            if (args.Length==6 && args[0]=="owner-observer") return ObserverRole(args[1],args[2],args[3],Int64.Parse(args[4]),Int64.Parse(args[5]));
            if (args.Length==3 && args[0]=="helper") return Helper(args[1],args[2]);
            if (args.Length==2 && args[0]=="supervisor") { Run("sleep",args[1],4000); return 0; }
            if (args.Length!=2) return 98;
            var envelope=BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
            Check("supervisor-envelope-readback",envelope.ProcessId>0 && envelope.CreationFileTime>0 &&
                envelope.MembershipVerified && envelope.LimitsVerified &&
                envelope.JobCommitLimitBytes==256UL*1024*1024 && envelope.BootstrapPrivateBytes>0 &&
                !envelope.CoversPreAssignmentMemory && !envelope.BoundsWallTime && !envelope.ReservationMayRelease,envelope);
            bool repeatRefused=false;
            try { BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024); }
            catch(InvalidOperationException) { repeatRefused=true; }
            Check("supervisor-envelope-one-shot",repeatRefused,null);
            string dir=Path.GetFullPath(args[0]); Directory.CreateDirectory(dir);
            var invalidEnvelope=Run("invalid-envelope",Path.Combine(dir,"invalid-envelope"),3000);
            Check("invalid-envelope-poisons-work",Dead(invalidEnvelope) && invalidEnvelope.ExitCode==71 &&
                !invalidEnvelope.TimedOut && !invalidEnvelope.LocalSuccess &&
                !File.Exists(Path.Combine(dir,"invalid-envelope.unexpected")),invalidEnvelope);
            var zero=Run("zero",Path.Combine(dir,"zero"),3000);
            Check("normal-zero",Dead(zero) && zero.LocalSuccess,zero);
            var seven=Run("seven",Path.Combine(dir,"seven"),3000);
            Check("distinct-exit-seven",Dead(seven) && seven.ExitCode==7 && !seven.LocalSuccess,seven);
            var sleepy=Run("sleep",Path.Combine(dir,"sleep"),700);
            Check("bounded-timeout",Dead(sleepy) && sleepy.TimedOut && !sleepy.LocalSuccess && sleepy.ElapsedMilliseconds<3200,sleepy);
            var memory=Run("memory",Path.Combine(dir,"memory"),3000);
            Check("commit-memory-refusal",Dead(memory) && !memory.TimedOut && memory.ExitCode==70 &&
                File.Exists(Path.Combine(dir,"memory")) && !memory.LocalSuccess,memory);
            string childRecord=Path.Combine(dir,"descendant");
            WorkerResult descendants=null; Exception threadError=null;
            var thread=new Thread(delegate() { try { descendants=Run("descendant",childRecord,4000); } catch(Exception e) { threadError=e; } });
            thread.IsBackground=true; thread.Start();
            using (var child=Observe(childRecord+".child",3000)) {
                bool joined=thread.Join(6500);
                bool exited=child.WaitForExit(1000);
                Check("descendant-after-parent-exit",joined && threadError==null && descendants!=null &&
                    Dead(descendants) && !descendants.TimedOut && exited && child.ExitCode!=0,
                    new {worker=descendants,childExited=exited});
            }
            string deathRecord=Path.Combine(dir,"parent-death");
            var info=new ProcessStartInfo(Exe,"supervisor "+Quote(deathRecord));
            info.UseShellExecute=false; info.CreateNoWindow=true;
            var deathClock=Stopwatch.StartNew(); // Before spawn: excludes both natural helper and supervisor deadlines.
            using (var supervisor=Process.Start(info)) {
                IntPtr held=supervisor.Handle;
                Process child=null;
                try {
                    child=Observe(deathRecord,3000);
                    long supervisorCreation=supervisor.StartTime.ToUniversalTime().ToFileTimeUtc();
                    long childCreation=child.StartTime.ToUniversalTime().ToFileTimeUtc();
                    bool aliveBefore=!supervisor.HasExited && !child.HasExited;
                    long killElapsed=deathClock.ElapsedMilliseconds;
                    if (aliveBefore && killElapsed<4000) supervisor.Kill(); // Exact fixture-owned handle.
                    int remaining=(int)Math.Max(0,4000-deathClock.ElapsedMilliseconds);
                    bool parentExited=supervisor.WaitForExit(remaining);
                    remaining=(int)Math.Max(0,4000-deathClock.ElapsedMilliseconds);
                    bool childExited=child.WaitForExit(remaining);
                    long exitElapsed=deathClock.ElapsedMilliseconds;
                    // KILL_ON_JOB_CLOSE does not promise a nonzero exit code. Observe
                    // exact death before either independent natural deadline instead.
                    Check("supervisor-death-kills-private-job",aliveBefore && killElapsed<4000 &&
                        parentExited && childExited && exitElapsed<4000,
                        new {supervisor=supervisor.Id,child=child.Id,supervisorCreation=supervisorCreation,
                            childCreation=childCreation,aliveBefore=aliveBefore,killElapsed=killElapsed,
                            exitElapsed=exitElapsed,parentExited=parentExited,childExited=childExited,
                            parentExitCode=parentExited?(int?)supervisor.ExitCode:null,
                            childExitCode=childExited?(int?)child.ExitCode:null});
                } finally {
                    // Dispose is not termination. Own the exact supervisor on every
                    // path, including failure before a child receipt can be observed.
                    var cleanupErrors=new List<Exception>();
                    try {
                        if (!supervisor.HasExited) supervisor.Kill();
                        if (!supervisor.WaitForExit(3000)) throw new Exception("Supervisor cleanup unconfirmed");
                    } catch(Exception e) { cleanupErrors.Add(e); }
                    finally {
                        if (child!=null) {
                            try {
                                if (!child.HasExited) child.Kill();
                                if (!child.WaitForExit(3000)) throw new Exception("Bound fixture child cleanup unconfirmed");
                            } catch(Exception e) { cleanupErrors.Add(e); }
                            finally {
                                try { child.Dispose(); } catch(Exception e) { cleanupErrors.Add(e); }
                            }
                        }
                    }
                    if (cleanupErrors.Count>0) throw new AggregateException("Exact fixture cleanup failed",cleanupErrors);
                }
            }
            var invalid=BoundedWorker.Run(Path.Combine(dir,"absent.exe"),"absent",dir,Env(),
                BoundedWorker.MonotonicMilliseconds()+1000,1000,128UL*1024*1024);
            Check("invalid-executable-no-success",!invalid.ProcessCreated && !invalid.ExitCodeKnown &&
                !invalid.LocalSuccess && !String.IsNullOrEmpty(invalid.Failure),invalid);
            string guardedRecord=Path.Combine(dir,"guard-accept");
            bool boundIdentity=false;
            var guarded=Guard(guardedRecord,3000,delegate(SuspendedWorkerBinding b) {
                long creation,exit,kernel,user;
                boundIdentity=b.BorrowedProcessHandle!=IntPtr.Zero && GetProcessId(b.BorrowedProcessHandle)==b.ProcessId &&
                    GetProcessTimes(b.BorrowedProcessHandle,out creation,out exit,out kernel,out user) &&
                    creation==b.CreationFileTime && creation>0 && WaitForSingleObject(b.BorrowedProcessHandle,0)==258 &&
                    BoundedWorker.MonotonicMilliseconds()<b.AbsoluteDeadlineMilliseconds && !File.Exists(guardedRecord);
                return boundIdentity;
            });
            Check("guarded-binding-before-resume",boundIdentity && Dead(guarded) && guarded.GuardRequired &&
                guarded.GuardAccepted && guarded.Resumed && guarded.LocalSuccess && File.Exists(guardedRecord),guarded);
            string deniedRecord=Path.Combine(dir,"guard-deny");
            var denied=Guard(deniedRecord,3000,delegate(SuspendedWorkerBinding b) {return false;});
            Check("guarded-refusal-no-resume",Closed(denied) && denied.GuardRequired && !denied.GuardAccepted &&
                !denied.Resumed && !denied.LocalSuccess && !String.IsNullOrEmpty(denied.Failure) && !File.Exists(deniedRecord),denied);
            string thrownRecord=Path.Combine(dir,"guard-throw");
            var thrown=Guard(thrownRecord,3000,delegate(SuspendedWorkerBinding b) {throw new InvalidOperationException("fixture binding failure");});
            Check("guarded-exception-no-resume",Closed(thrown) && thrown.GuardRequired && !thrown.GuardAccepted &&
                !thrown.Resumed && !thrown.LocalSuccess && !String.IsNullOrEmpty(thrown.Failure) && !File.Exists(thrownRecord),thrown);
            string lateRecord=Path.Combine(dir,"guard-late");
            bool lateInvoked=false;
            var late=Guard(lateRecord,500,delegate(SuspendedWorkerBinding b) {lateInvoked=true;Thread.Sleep(600);return true;});
            Check("guarded-late-acceptance-no-resume",lateInvoked && Dead(late) && late.GuardRequired &&
                late.GuardAccepted && late.TimedOut && !late.Resumed && !late.LocalSuccess && !File.Exists(lateRecord),late);
            bool nullGuardRefused=false;
            try {Guard(Path.Combine(dir,"guard-null"),3000,null);}
            catch(ArgumentNullException) {nullGuardRefused=true;}
            Check("guarded-null-refused",nullGuardRefused && !File.Exists(Path.Combine(dir,"guard-null")),null);
            bool refused=false;
            try { BoundedWorker.Run(Exe,Quote(Exe),dir,Env(),BoundedWorker.MonotonicMilliseconds()-1,1000,128UL*1024*1024); }
            catch(ArgumentOutOfRangeException) { refused=true; }
            Check("expired-absolute-deadline",refused,null);
            var invalidObserverClock=Run("invalid-observer-clock",Path.Combine(dir,"invalid-observer-clock"),3000);
            Check("observer-overflow-clock-refused",Dead(invalidObserverClock) && invalidObserverClock.ExitCode==74 && !invalidObserverClock.TimedOut,invalidObserverClock);
            foreach(string mode in new[]{"normal","wrong-identity","late-bind","loss-before","loss-during","blocked-callback"}) ObserverCase(dir,mode);
            SystemCases(Path.GetFullPath(args[1]));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.GetType().Name+": "+error.Message); return 1; }
    }
}
