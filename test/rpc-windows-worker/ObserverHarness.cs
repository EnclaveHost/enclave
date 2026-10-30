// Disposable CI transport only: private fixture directory, bounded atomic files.
// This does not qualify SYSTEM namespace ACLs, task bootstrap, or production IPC.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using Enclave.OwnedRpc;

static partial class Harness {
    static void Put(string path,string value) {
        if(value.Length>4096) throw new Exception("Fixture message bound");
        using(var f=new StreamWriter(new FileStream(path+".new",FileMode.CreateNew,FileAccess.Write,FileShare.None))) f.Write(value);
        File.Move(path+".new",path);
    }
    static string Get(string path) {
        using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
            if(f.Length>4096) throw new Exception("Fixture message too large");
            using(var r=new StreamReader(f)) return r.ReadToEnd();
        }
    }
    static void Await(string path,long deadline) {
        while(!File.Exists(path)) {
            if(BoundedWorker.MonotonicMilliseconds()>=deadline) throw new Exception("Fixture original deadline");
            Thread.Sleep(5);
        }
    }
    static Process Held(string identity) {
        string[] x=Get(identity).Split(',');
        var p=Process.GetProcessById(Int32.Parse(x[0]));
        IntPtr held=p.Handle;
        long creation,exit,kernel,user;
        if(!GetProcessTimes(held,out creation,out exit,out kernel,out user) || creation!=Int64.Parse(x[1]) ||
            WaitForSingleObject(held,0)!=258) {p.Dispose();throw new Exception("Held fixture incarnation differs");}
        return p;
    }
    static int OwnerRole(string dir,string mode,string token,long origin,long deadline) {
        Identity(Path.Combine(dir,"owner"));
        Await(Path.Combine(dir,"attached"),Math.Min(deadline,origin+5000));
        if(Get(Path.Combine(dir,"attached"))!=token) throw new Exception("Owner admission token differs");
        using(var observer=Held(Path.Combine(dir,"observer"))) {
            long observerCreation=observer.StartTime.ToUniversalTime().ToFileTimeUtc();
            BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
            string helper=mode=="loss-during"?"sleep":"zero";
            var result=BoundedWorker.RunGuarded(Exe,Quote(Exe)+" helper "+helper+" "+Quote(Path.Combine(dir,"ran")),
                Path.GetDirectoryName(Exe),Env(),deadline,1000,128UL*1024*1024,delegate(SuspendedWorkerBinding b) {
                    long remote=BoundedWorker.DuplicateChildToObserver(b,observer.Handle,(uint)observer.Id,observerCreation);
                    Put(Path.Combine(dir,"binding"),remote+","+b.ProcessId+","+b.CreationFileTime+","+token+","+deadline);
                    if(mode=="blocked-callback") Thread.Sleep(5000); // Independent observer must kill us first.
                    while(!File.Exists(Path.Combine(dir,"release"))) {
                        if(File.Exists(Path.Combine(dir,"rejected"))) return false;
                        BoundedWorker.VerifyObserverBeforeResume(observer.Handle,(uint)observer.Id,observerCreation,deadline);
                        Thread.Sleep(5);
                    }
                    if(Get(Path.Combine(dir,"release"))!=token) throw new Exception("Fixture release binding differs");
                    BoundedWorker.VerifyObserverBeforeResume(observer.Handle,(uint)observer.Id,observerCreation,deadline);
                    return true;
                });
            Put(Path.Combine(dir,"owner-result"),new JavaScriptSerializer().Serialize(result));
            return mode=="wrong-identity" ? (Closed(result) && !result.Resumed && !result.LocalSuccess?0:82) : (result.LocalSuccess?0:83);
        }
    }
    static int ObserverRole(string dir,string mode,string token,long origin,long deadline) {
        BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
        var guard=BoundedWorker.ArmOwnerObserver(origin,deadline,token);
        Identity(Path.Combine(dir,"observer"));
        Await(Path.Combine(dir,"arm"),Math.Min(deadline,origin+5000));
        Await(Path.Combine(dir,"owner"),Math.Min(deadline,origin+5000));
        using(var owner=Held(Path.Combine(dir,"owner"))) {
            guard.AttachGatedOwner(owner.Handle,(uint)owner.Id,owner.StartTime.ToUniversalTime().ToFileTimeUtc());
            Put(Path.Combine(dir,"attached"),token);
            Await(Path.Combine(dir,"binding"),deadline);
            Await(Path.Combine(dir,"child-held"),deadline);
            string[] b=Get(Path.Combine(dir,"binding")).Split(',');
            if(b.Length!=5) throw new Exception("Fixture binding shape");
            if(mode=="late-bind") Thread.Sleep((int)Math.Max(1,deadline-BoundedWorker.MonotonicMilliseconds()+100));
            try {
                guard.BindTransferredChild(Int64.Parse(b[0]),UInt32.Parse(b[1]),
                    Int64.Parse(b[2])+(mode=="wrong-identity"?1:0),b[3],Int64.Parse(b[4]));
            } catch(InvalidOperationException) {
                if(mode!="wrong-identity") throw;
                Put(Path.Combine(dir,"rejected"),token);
            }
            if(guard.ChildBound) {
                Put(Path.Combine(dir,"bound"),token);
                Await(Path.Combine(dir,"approve"),deadline);
                Put(Path.Combine(dir,"release"),token);
            }
            while(!owner.WaitForExit(5)) {
                if(BoundedWorker.MonotonicMilliseconds()>=deadline) throw new Exception("Owner did not exit");
            }
            bool empty=guard.ObserveOwnerTreeExited();
            Put(Path.Combine(dir,"observer-result"),empty?"exact-owner-death-and-empty":"unconfirmed");
            return empty?0:84;
        }
    }
    static Process Role(string role,string dir,string mode,string token,long origin,long deadline) {
        var info=new ProcessStartInfo(Exe,role+" "+Quote(dir)+" "+mode+" "+token+" "+origin+" "+deadline);
        info.UseShellExecute=false;info.CreateNoWindow=true;
        var p=Process.Start(info);IntPtr held=p.Handle;return p;
    }
    static void Clean(Process p) {
        if(p==null) return;
        try {if(!p.HasExited)p.Kill();if(!p.WaitForExit(2000))throw new Exception("Exact observer fixture cleanup unconfirmed");}
        finally {p.Dispose();}
    }
    static void ObserverCase(string root,string mode) {
        string dir=Path.Combine(root,"observer-"+mode);Directory.CreateDirectory(dir);
        string token=Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N")+new string('a',64);
        // The token's boot/digest components are synthetic CI context, not a target boot attestation.
        long origin=BoundedWorker.MonotonicMilliseconds();
        bool deadlineCase=mode=="late-bind" || mode=="blocked-callback";
        long deadline=origin+(deadlineCase?2500:5000);
        Process owner=null,observer=null,child=null;
        try {
            owner=Role("observed-owner",dir,mode,token,origin,deadline);
            observer=Role("owner-observer",dir,mode,token,origin,deadline);
            long ownerCreation=owner.StartTime.ToUniversalTime().ToFileTimeUtc();
            long observerCreation=observer.StartTime.ToUniversalTime().ToFileTimeUtc();
            // Controller already holds both exact handles before allowing assignment.
            Put(Path.Combine(dir,"arm"),token);
            Await(Path.Combine(dir,"binding"),deadline);
            string[] binding=Get(Path.Combine(dir,"binding")).Split(',');
            Put(Path.Combine(dir,"child-identity"),binding[1]+","+binding[2]);
            child=Held(Path.Combine(dir,"child-identity"));
            long childCreation=child.StartTime.ToUniversalTime().ToFileTimeUtc();
            bool allAlive=!owner.HasExited && !observer.HasExited && !child.HasExited;
            Put(Path.Combine(dir,"child-held"),token);
            long killElapsed=-1;
            if(mode=="loss-before" || mode=="loss-during") {
                Await(Path.Combine(dir,"bound"),deadline);
                if(mode=="loss-during") {
                    Put(Path.Combine(dir,"approve"),token);Await(Path.Combine(dir,"ran"),deadline);
                }
                allAlive=allAlive && !owner.HasExited && !observer.HasExited && !child.HasExited;
                killElapsed=BoundedWorker.MonotonicMilliseconds()-origin;
                if(!allAlive || killElapsed>=3500)throw new Exception("Observer-loss precondition unavailable");
                observer.Kill(); // Exact pre-held observer; never a PID or task-state kill.
            } else if(mode=="normal") {
                Await(Path.Combine(dir,"bound"),deadline);Put(Path.Combine(dir,"approve"),token);
            }
            long collectionDeadline=deadlineCase?deadline+1000:origin+4000;
            bool observerDead=observer.WaitForExit((int)Math.Max(0,collectionDeadline-BoundedWorker.MonotonicMilliseconds()));
            bool ownerDead=owner.WaitForExit((int)Math.Max(0,collectionDeadline-BoundedWorker.MonotonicMilliseconds()));
            bool childDead=child.WaitForExit((int)Math.Max(0,collectionDeadline-BoundedWorker.MonotonicMilliseconds()));
            long end=BoundedWorker.MonotonicMilliseconds();
            bool ran=File.Exists(Path.Combine(dir,"ran"));
            bool passed=allAlive && observerDead && ownerDead && childDead && end<=collectionDeadline;
            if(mode=="normal" || mode=="wrong-identity") passed=passed && owner.ExitCode==0 && observer.ExitCode==0 &&
                Get(Path.Combine(dir,"observer-result"))=="exact-owner-death-and-empty" && ran==(mode=="normal");
            if(mode=="loss-before" || mode=="loss-during") passed=passed && end<deadline && ran==(mode=="loss-during");
            if(deadlineCase) passed=passed && observer.ExitCode==124 && !ran && end>=deadline &&
                !File.Exists(Path.Combine(dir,"release"));
            // Assertion precedes fallback cleanup; cleanup must never manufacture PASS.
            Check("independent-observer-"+mode,passed,new {origin=origin,deadline=deadline,
                ownerPid=owner.Id,ownerCreation=ownerCreation,observerPid=observer.Id,observerCreation=observerCreation,
                childPid=child.Id,childCreation=childCreation,allAliveBefore=allAlive,killElapsed=killElapsed,
                elapsed=end-origin,observerDead=observerDead,ownerDead=ownerDead,childDead=childDead,ran=ran,
                observerExit=observerDead?(int?)observer.ExitCode:null,ownerExit=ownerDead?(int?)owner.ExitCode:null,
                childExit=childDead?(int?)child.ExitCode:null,providerOperationFenced=false,reservationMayRelease=false});
        } finally {
            // Always attempt all three cleanups even if an earlier cleanup fails.
            try {Clean(observer);} finally {try {Clean(owner);} finally {Clean(child);}}
        }
    }
}
