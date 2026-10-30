// Disposable hosted-CI SYSTEM tasks only. Not a production task launcher.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Enclave.OwnedRpc;

static partial class Harness {
    static readonly List<string> TaskDiagnostics=new List<string>();
    static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
    static void SecureDirectory(string path) {
        var sd=new DirectorySecurity();sd.SetOwner(Admin);sd.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{Admin,SystemUser})sd.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(path,sd);
    }
    static void SecureFile(string path,byte[] data) {
        var sd=new FileSecurity();sd.SetOwner(Admin);sd.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{Admin,SystemUser})sd.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
        using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,sd)){
            f.Write(data,0,data.Length);f.Flush(true);
        }
    }
    static string PrepareContract(string root,string entry,string boot,long origin,long deadline,bool writable) {
        SecureDirectory(root);SecureFile(Path.Combine(root,"entry.exe"),File.ReadAllBytes(entry));
        string text="owned-rpc-inert-v1\n"+Path.GetFileName(root)+"\n"+boot+"\n"+origin+"\n"+deadline+"\n"+
            ProtectedAttempt.Hash(File.ReadAllBytes(entry))+"\ninert-v1\n";
        byte[] bytes=Encoding.UTF8.GetBytes(text);SecureFile(Path.Combine(root,"contract.txt"),bytes);
        if(writable) {
            var acl=Directory.GetAccessControl(root);acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"),FileSystemRights.WriteData,AccessControlType.Allow));
            Directory.SetAccessControl(root,acl);
        }
        return ProtectedAttempt.Hash(bytes);
    }
    static dynamic TaskFolder() {
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();return service.GetFolder("\\");
    }
    static string Schedule(string executable,string arguments,List<string> ownedTasks) {
        // This controller is reachable only from the hosted-CI qualification path.
        if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true" || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")
            throw new InvalidOperationException("Hosted CI task controller only");
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();
        dynamic folder=service.GetFolder("\\"),task=service.NewTask(0);
        string name="EnclaveRpcInertCI-"+Guid.NewGuid().ToString("N");
        task.RegistrationInfo.Description="Disposable inert qualification only; no VM or provider calls";
        task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
        task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;
        task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;
        task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
        // CI-only bounded diagnostic transport. Production entry has no shell path.
        string output=Path.Combine(Path.GetDirectoryName(executable),name+".out"),error=Path.Combine(Path.GetDirectoryName(executable),name+".err");
        foreach(string value in new[]{executable,arguments,output,error})
            if(value.IndexOfAny(new[]{'&','|','<','>','^','%','!','\r','\n'})>=0)throw new ArgumentException("CI shell metacharacter refused");
        TaskDiagnostics.Add(output);TaskDiagnostics.Add(error);
        dynamic action=task.Actions.Create(0);action.Path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
        action.Arguments="/d /s /c \""+Quote(executable)+" "+arguments+" 1>"+Quote(output)+" 2>"+Quote(error)+"\"";
        action.WorkingDirectory=Path.GetDirectoryName(executable);
        // TASK_CREATE only. Record exact unique name before possibly ambiguous COM return.
        ownedTasks.Add(name);dynamic registered=folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);
        registered.Run(null);return name;
    }
    static Process SystemIdentity(string path,long deadline) {
        long identityDeadline=Math.Min(deadline,BoundedWorker.MonotonicMilliseconds()+4000);
        Await(path,identityDeadline);string[] value=Get(path).Split(',');
        var p=Process.GetProcessById(Int32.Parse(value[0]));IntPtr handle=p.Handle;
        if(p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(value[1]) || p.HasExited){p.Dispose();throw new Exception("Exact SYSTEM task incarnation unavailable");}
        return p;
    }
    static void DeleteOwnedTasks(List<string> names) {
        // Never infer death from these calls. PASS assertions require exact retained
        // handles first. On an earlier failure cleanup remains unqualified and CI fails.
        var failures=new List<Exception>();
        foreach(string name in names) {
            dynamic folder=null,task=null;
            try {folder=TaskFolder();}catch(Exception e){failures.Add(new Exception(name+": folder unavailable",e));continue;}
            try {task=folder.GetTask(name);}catch(Exception e){failures.Add(new Exception(name+": task association unavailable (absence is not death)",e));}
            if(task!=null) {
                try {Console.Error.WriteLine("Owned CI task "+name+" diagnostic LastTaskResult="+task.LastTaskResult);}
                catch(Exception e){failures.Add(new Exception(name+": diagnostic unavailable",e));}
                try {task.Enabled=false;}catch(Exception e){failures.Add(new Exception(name+": disable failed",e));}
                try {task.Stop(0);}catch(Exception e){failures.Add(new Exception(name+": stop request failed",e));}
            }
            try {folder.DeleteTask(name,0);}catch(Exception e){failures.Add(new Exception(name+": delete failed",e));}
        }
        if(failures.Count>0)throw new AggregateException("Owned CI task cleanup incomplete; not a death proof",failures);
    }

    static int SystemProbe(string root,string token,long origin,long deadline) {
        ProtectedAttempt.RequireSystem();BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
        BoundedWorker.ArmOwnerObserver(origin,deadline,token);Identity(Path.Combine(root,"probe"));
        Await(Path.Combine(root,"probe-admit"),deadline);
        var settings=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(Get(Path.Combine(root,"cases.json")));
        var checks=new Dictionary<string,bool>();string good=settings["good"],hash=settings["hash"];
        bool badHash=false;try {using(var a=new ProtectedAttempt(Path.Combine(good,"contract.txt"),new string('0',64))) {}}
        catch(InvalidOperationException e){badHash=e.Message=="Contract digest mismatch";}checks["system-contract-wrong-hash"]=badHash;
        bool writable=false;try {using(var a=new ProtectedAttempt(Path.Combine(settings["writable"],"contract.txt"),settings["writableHash"])) {}}
        catch(InvalidOperationException e){writable=e.Message.StartsWith("Untrusted namespace mutation right:",StringComparison.Ordinal);}checks["system-contract-writable-namespace"]=writable;
        bool wrongBoot=false;try {using(var a=new ProtectedAttempt(Path.Combine(settings["boot"],"contract.txt"),settings["bootHash"])) {}}
        catch(InvalidOperationException e){wrongBoot=e.Message=="Attempt belongs to another boot";}checks["system-contract-wrong-boot"]=wrongBoot;
        using(var a=new ProtectedAttempt(Path.Combine(good,"contract.txt"),hash)) {
            bool immutable=false;try {using(var f=File.Open(Path.Combine(good,"contract.txt"),FileMode.Open,FileAccess.Write,FileShare.ReadWrite)) {}}
            catch(IOException){immutable=true;}
            checks["system-held-contract-refuses-write"]=immutable;
            bool heldDirectory=false;try {Directory.Move(good,good+"-moved");}catch(IOException){heldDirectory=true;}
            checks["system-held-directory-refuses-rename"]=heldDirectory;
            a.WriteOnce("qualification.consumed",a.Token);
            bool repeated=false;try {a.WriteOnce("qualification.consumed",a.Token);}catch(IOException){repeated=true;}
            checks["system-consumed-record-no-replay"]=repeated;
        }
        Put(Path.Combine(root,"probe-results"),new JavaScriptSerializer().Serialize(checks));
        foreach(bool passed in checks.Values)if(!passed)return 1;return 0;
    }
    static void SystemCases(string entry) {
        string root=Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)),"EnclaveRpcInertCI-"+Guid.NewGuid().ToString("N"));
        SecureDirectory(root);var tasks=new List<string>();Process owner=null,observer=null,probe=null;
        try {
            long origin=BoundedWorker.MonotonicMilliseconds(),deadline=origin+20000;string boot=ProtectedAttempt.CurrentBoot();
            string attempt=Path.Combine(root,Guid.NewGuid().ToString("N"));string hash=PrepareContract(attempt,entry,boot,origin,deadline,false);
            string contract=Path.Combine(attempt,"contract.txt"),exe=Path.Combine(attempt,"entry.exe");
            string arguments=Quote(contract)+" "+hash+" "+origin+" "+deadline;
            Schedule(exe,"owner "+arguments,tasks);Schedule(exe,"observer "+arguments,tasks);
            owner=SystemIdentity(Path.Combine(attempt,"owner.consumed"),deadline);
            observer=SystemIdentity(Path.Combine(attempt,"observer.consumed"),deadline);
            bool alive=!owner.HasExited&&!observer.HasExited;
            SecureFile(Path.Combine(attempt,"admit"),Encoding.UTF8.GetBytes(Path.GetFileName(attempt)+boot+hash));
            bool ownerDead=owner.WaitForExit((int)Math.Max(0,deadline-BoundedWorker.MonotonicMilliseconds()));
            bool observerDead=observer.WaitForExit((int)Math.Max(0,deadline-BoundedWorker.MonotonicMilliseconds()));
            bool complete=alive&&ownerDead&&observerDead&&owner.ExitCode==0&&observer.ExitCode==0&&
                Get(Path.Combine(attempt,"owner.result"))=="inert-complete;provider-fenced=false;reservation-release=false"&&
                Get(Path.Combine(attempt,"observer.result"))=="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false";
            Check("system-separate-task-protected-entry",complete,new {ownerPid=owner.Id,observerPid=observer.Id,ownerDead=ownerDead,observerDead=observerDead,
                elapsed=BoundedWorker.MonotonicMilliseconds()-origin,providerFenced=false,reservationRelease=false});
            // Fresh distinct fixture clock/namespace, not a renewal of the completed attempt.
            origin=BoundedWorker.MonotonicMilliseconds();deadline=origin+20000;
            string good=Path.Combine(root,Guid.NewGuid().ToString("N")),bad=Path.Combine(root,Guid.NewGuid().ToString("N")),badBoot=Path.Combine(root,Guid.NewGuid().ToString("N"));
            var settings=new Dictionary<string,string>{{"good",good},{"hash",PrepareContract(good,entry,boot,origin,deadline,false)},
                {"writable",bad},{"writableHash",PrepareContract(bad,entry,boot,origin,deadline,true)},
                {"boot",badBoot},{"bootHash",PrepareContract(badBoot,entry,Guid.NewGuid().ToString("N"),origin,deadline,false)}};
            SecureFile(Path.Combine(root,"cases.json"),Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(settings)));
            string probeExe=Path.Combine(root,"probe.exe");SecureFile(probeExe,File.ReadAllBytes(Exe));
            string token=Guid.NewGuid().ToString("N")+boot+new string('b',64);
            Schedule(probeExe,"system-probe "+Quote(root)+" "+token+" "+origin+" "+deadline,tasks);
            probe=SystemIdentity(Path.Combine(root,"probe"),deadline);SecureFile(Path.Combine(root,"probe-admit"),Encoding.UTF8.GetBytes(token));
            bool probeDead=probe.WaitForExit((int)Math.Max(0,deadline-BoundedWorker.MonotonicMilliseconds()));
            if(!probeDead || probe.ExitCode!=0)throw new Exception("SYSTEM negative qualification failed or exact death missing");
            var checks=new JavaScriptSerializer().Deserialize<Dictionary<string,bool>>(Get(Path.Combine(root,"probe-results")));
            if(checks.Count!=6)throw new Exception("Incomplete SYSTEM negative qualification");
            foreach(var pair in checks)Check(pair.Key,pair.Value,new {exactProbeDeath=probeDead,pid=probe.Id});
        } finally {
            try {
                var diagnosticFailures=new List<Exception>();
                foreach(string path in TaskDiagnostics) {
                    try {
                        if(!File.Exists(path))continue;
                        using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)) {
                            var bytes=new byte[4097];int count=0;
                            while(count<bytes.Length){int n=stream.Read(bytes,count,bytes.Length-count);if(n==0)break;count+=n;}
                            Console.Error.WriteLine("CI task diagnostic (possibly incomplete) "+Path.GetFileName(path)+": "+Encoding.UTF8.GetString(bytes,0,Math.Min(count,4096)));
                            if(count>4096)throw new Exception("CI task diagnostic exceeded collection bound");
                        }
                    }catch(Exception e){Console.Error.WriteLine("CI diagnostic unavailable: "+Path.GetFileName(path)+": "+e.GetType().Name);diagnosticFailures.Add(e);}
                }
                if(diagnosticFailures.Count>0)throw new AggregateException("CI diagnostic collection incomplete",diagnosticFailures);
            } finally {
                try {Clean(observer);}finally {try {Clean(owner);}finally {try {Clean(probe);}finally {DeleteOwnedTasks(tasks);}}}
            }
        }
    }
}
