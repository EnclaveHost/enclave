// Disposable hosted qualification for the actual SYSTEM provider worker.
// Synthetic VM permit only; never creates a VM or supplies a valid start guardian.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Enclave.OwnedRpc;

public static class ProviderWorkerQualification {
    static readonly List<IDisposable> Held=new List<IDisposable>();
    static readonly List<Process> Processes=new List<Process>();
    static readonly Dictionary<string,string> Tasks=new Dictionary<string,string>();
    static readonly List<string> Failures=new List<string>();
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
    static long Origin,Deadline;
    static string Root,Entry;
    static bool Admitted;
    static dynamic Folder;
    static ProtectedAttempt NamespacePin;
    static BoundedWorker.OwnerObserver Watchdog;
    const long MiB=1048576,GiB=1073741824;
    const long Required=18*GiB+39388*MiB+GiB+512*MiB+192*MiB+256*MiB;
    static void CheckTime(){if(BoundedWorker.MonotonicMilliseconds()>=Deadline)throw new TimeoutException("Original controller deadline");}
    static string Quote(string value){if(value.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Invalid path");return "\""+value+"\"";}
    static void Hex(string value,int length){if(value==null||value.Length!=length)throw new ArgumentException("Digest/nonce length");foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("Digest/nonce encoding");}
    static byte[] Read(string path,int limit){
        CheckTime();if(!Path.IsPathRooted(path)||path.StartsWith("\\\\"))throw new ArgumentException("Local absolute input required");
        var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);Held.Add(f);
        if(f.Length<1||f.Length>limit)throw new InvalidOperationException("Input bound");
        var b=new byte[(int)f.Length];int offset=0;
        while(offset<b.Length){int n=f.Read(b,offset,b.Length-offset);if(n==0)throw new IOException("Short input");offset+=n;}
        return b;
    }
    static Dictionary<string,object> Obj(object value){var d=value as Dictionary<string,object>;if(d==null)throw new InvalidOperationException("Object required");return d;}
    static IList Rows(object value){var a=value as IList;if(a==null||a.Count>128)throw new InvalidOperationException("Row bound");return a;}
    static string Str(object value){var s=value as string;if(s==null||s.Length>4096)throw new InvalidOperationException("String required");return s;}
    static long Num(object value){if(!(value is int)&&!(value is long))throw new InvalidOperationException("Integer required");return Convert.ToInt64(value,CultureInfo.InvariantCulture);}
    static bool Yes(object value){return value is bool&&(bool)value;}
    static List<Dictionary<string,object>> Query(string scope,string query,string[] properties,int maximum){
        CheckTime();var rows=new List<Dictionary<string,object>>();
        var options=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(3),ReturnImmediately=false,Rewindable=false};
        using(var search=new ManagementObjectSearcher(scope,query,options))using(var results=search.Get())
            foreach(ManagementObject row in results)using(row){
                if(rows.Count>=maximum)throw new InvalidOperationException("Management row bound");
                var item=new Dictionary<string,object>();foreach(string property in properties)item[property]=row[property];rows.Add(item);CheckTime();
            }
        return rows;
    }
    static Dictionary<string,object> One(string query,string[] properties){var rows=Query("root\\cimv2",query,properties,2);if(rows.Count!=1)throw new InvalidOperationException("Expected singleton");return rows[0];}
    static string TimeText(object value){return ManagementDateTimeConverter.ToDateTime(Str(value)).ToUniversalTime().ToString("o");}
    static long AdmitHosted() {
        var os=One("SELECT FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"FreePhysicalMemory"});
        long free=checked(Convert.ToInt64(os["FreePhysicalMemory"])*1024);
        if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted"||free<3*GiB)
            throw new InvalidOperationException("Disposable hosted qualification required");
        return free;
    }
    static void DirectoryNew(string path){
        if(Directory.Exists(path)||File.Exists(path))throw new InvalidOperationException("Consumed namespace");
        var acl=new DirectorySecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(path,acl); // PinController validates/holds raced objects BEFORE any launch.
    }
    static void Publish(string path,byte[] data){
        var acl=new FileSecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
        using(var f=new FileStream(path+".pending",FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,acl)){f.Write(data,0,data.Length);f.Flush(true);}
        File.Move(path+".pending",path);
    }
    static Process Identity(string role,string token){
        string path=Path.Combine(Root,role+".consumed");while(!File.Exists(path)){CheckTime();Thread.Sleep(5);}
        string[] fields=Encoding.UTF8.GetString(Read(path,4096)).Split(',');
        if(fields.Length!=4||fields[2]!=token||fields[3]!=role)throw new InvalidOperationException("Role binding differs");
        var p=Process.GetProcessById(Int32.Parse(fields[0],CultureInfo.InvariantCulture));Processes.Add(p);IntPtr held=p.Handle;
        if(p.HasExited||p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(fields[1],CultureInfo.InvariantCulture))throw new InvalidOperationException("Exact role incarnation unavailable");return p;
    }
    static void Schedule(string role,string arguments){
        CheckTime();if(!Admitted||BoundedWorker.MonotonicMilliseconds()>=Origin+5000)throw new InvalidOperationException("Original bootstrap cutoff");
        string name="EnclaveRpcProviderQualification-"+Path.GetFileName(Root)+"-"+role;Tasks.Add(name,arguments);
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
        task.RegistrationInfo.Description="One-shot provider worker qualification; no valid native start guardian";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
        task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;
        task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
        dynamic action=task.Actions.Create(0);action.Path=Entry;action.WorkingDirectory=Root;action.Arguments=arguments;
        dynamic registered=Folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
    }
    static void Cleanup(){
        foreach(var pair in Tasks){dynamic task=null;bool associated=false;
            try{task=Folder.GetTask(pair.Key);dynamic d=task.Definition;dynamic a=d.Actions.Item(1);
                string user=d.Principal.UserId;
                if(d.Actions.Count!=1||(user!="SYSTEM"&&user!="S-1-5-18")||d.Principal.LogonType!=5||a.Path!=Entry||a.WorkingDirectory!=Root||a.Arguments!=pair.Value)throw new InvalidOperationException("Task association differs");associated=true;
            }catch{Failures.Add("Exact task association unconfirmed: "+pair.Key);}
            if(associated){try{task.Enabled=false;}catch{Failures.Add("Task disable failed");}try{task.Stop(0);}catch{Failures.Add("Task stop failed");}try{Folder.DeleteTask(pair.Key,0);}catch{Failures.Add("Task removal failed");}}
        }
        foreach(var p in Processes){try{if(!p.HasExited)Failures.Add("Exact role still alive");}catch{Failures.Add("Exact death observation failed");}try{p.Dispose();}catch{Failures.Add("Process close failed");}}
        if(NamespacePin!=null)try{NamespacePin.Dispose();}catch{Failures.Add("Namespace close failed");}
        foreach(var f in Held)try{f.Dispose();}catch{Failures.Add("Input close failed");}
    }
    static void AdmissionFixtures() {
        Func<long,Dictionary<string,object>> health=mib=>new Dictionary<string,object>{{"managerEpoch","epoch-1"},{"memory",new Dictionary<string,object>{{"known",true},{"unknown",new object[0]},
            {"reservations",mib==0?new object[0]:new object[]{new Dictionary<string,object>{{"id","vm-1"},{"vmMiB",mib}}}}}};
        Action<Action> refuses=f=>{bool denied=false;try{f();}catch{denied=true;}if(!denied)throw new Exception("Pending authority unexpectedly admitted");};
        var a=health(39388);var b=health(0);var c=health(0);
        string valid=WindowsStartAdmission.PendingReceipt(new object[]{a,b,c});
        if(String.IsNullOrEmpty(valid))throw new Exception("Complete pending receipt missing");
        var unknown=health(0);Obj(unknown["memory"])["known"]=false;refuses(()=>WindowsStartAdmission.PendingReceipt(new object[]{unknown,b,c}));
        var missing=health(0);Obj(missing["memory"]).Remove("reservations");refuses(()=>WindowsStartAdmission.PendingReceipt(new object[]{missing,b,c}));
        refuses(()=>WindowsStartAdmission.PendingReceipt(new object[]{a,health(1),c}));
        var dup=health(1);Obj(dup["memory"])["reservations"]=new object[]{new Dictionary<string,object>{{"id","vm-1"},{"vmMiB",1}},new Dictionary<string,object>{{"id","vm-1"},{"vmMiB",1}}};refuses(()=>WindowsStartAdmission.PendingReceipt(new object[]{dup,b,c}));
        b["managerEpoch"]="epoch-2";if(valid==WindowsStartAdmission.PendingReceipt(new object[]{a,b,c}))throw new Exception("Manager generation change was hidden");
    }
    public static int Main(string[] args) {
        Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;bool passed=false,deniedStart=false;long free=0;
        ProtectedAttempt vmPin=null;string vmRoot=null,childResult=null;
        try {
            if(args.Length!=6||(args[0]!="--hosted-reconcile"&&args[0]!="--hosted-denied-start"&&args[0]!="--hosted-admission-fixtures"))throw new ArgumentException("Explicit disposable qualification mode required");
            deniedStart=args[0]=="--hosted-denied-start";
            Origin=Int64.Parse(args[4],NumberStyles.None,CultureInfo.InvariantCulture);Deadline=Int64.Parse(args[5],NumberStyles.None,CultureInfo.InvariantCulture);
            Hex(args[2],64);Hex(args[3],32);
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);Watchdog=BoundedWorker.ArmOwnerObserver(Origin,Deadline,args[3]+args[3]+args[3]+args[3]);
            using(var identity=WindowsIdentity.GetCurrent())if(identity.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
            byte[] entry=Read(args[1],262144);if(ProtectedAttempt.Hash(entry)!=args[2])throw new InvalidOperationException("Entry digest differs");
            free=AdmitHosted();
            if(args[0]=="--hosted-admission-fixtures") {
                AdmissionFixtures();Console.WriteLine(Json.Serialize(new{schema="owned-rpc-pending-fixtures/1",passed=true,fixtures=6,nativeSubmitted=false,vmsChanged=false,providerFenced=false,reservationMayRelease=false}));return 0;
            }
            string boot=ProtectedAttempt.CurrentBoot();
            string parent=Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)),"EnclaveRpcProviderQualification-"+args[3]);DirectoryNew(parent);Root=Path.Combine(parent,args[3]);DirectoryNew(Root);
            Publish(Path.Combine(Root,"controller.consumed"),Encoding.UTF8.GetBytes(args[3]));Entry=Path.Combine(Root,"entry.exe");Publish(Entry,entry);
            string vmNonce=Guid.NewGuid().ToString("N");vmRoot=Path.Combine(parent,vmNonce);DirectoryNew(vmRoot);Publish(Path.Combine(vmRoot,"entry.exe"),entry);
            var permit=new OwnedVmPermit(vmNonce,boot,new string('a',64),args[2],Guid.NewGuid().ToString("D"),Path.Combine(vmRoot,"vm"),Origin,Origin+900000,19*GiB,GiB);
            string permitPath=Path.Combine(vmRoot,"vm-permit.txt");byte[] permitBytes=Encoding.UTF8.GetBytes(permit.Encode());string permitHash=ProtectedAttempt.Hash(permitBytes);Publish(permitPath,permitBytes);
            uint guardianPid=0;long guardianCreation=0;
            // Negative start uses an actual held, live ADMIN controller as a wrong
            // guardian. It cannot satisfy the pinned SYSTEM guardian contract.
            if(deniedStart)using(var self=Process.GetCurrentProcess()){guardianPid=(uint)self.Id;guardianCreation=self.StartTime.ToUniversalTime().ToFileTimeUtc();}
            string operation=deniedStart?"start":"reconcile",contract=Path.Combine(Root,"contract.txt");
            byte[] bytes=Encoding.UTF8.GetBytes("owned-rpc-provider-worker-v1\n"+args[3]+"\n"+boot+"\n"+Origin+"\n"+Deadline+"\n"+args[2]+"\n"+operation+"\n"+permitPath+"\n"+permitHash+"\n"+guardianPid+"\n"+guardianCreation+"\n");
            string hash=ProtectedAttempt.Hash(bytes);Publish(contract,bytes);
            NamespacePin=ProtectedAttempt.PinProviderController(contract,hash);
            vmPin=ProtectedAttempt.PinVmJournalController(permitPath,permitHash,NamespacePin,false);
            if(!deniedStart){
                var id=new StartIdentity(permit.Attempt,boot,permit.AdmissionHash,permitHash,permit.VmGuid,permit.VmName,permit.OwnerNote,permit.ConfigurationRoot,permit.Origin,permit.Deadline,123,100,456,200,permit.ImageHash);
                var j=new OwnedVmStartJournal(vmPin,id);ProviderStart.Prepare(id,j);j.WriteOnce("start.submit",ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(id.Encode())));
            }
            Admitted=true;string token=args[3]+boot+hash;
            string arguments=Quote(contract)+" "+hash+" "+Origin+" "+Deadline;Schedule("owner","owner "+arguments);Schedule("observer","observer "+arguments);
            Process owner=Identity("owner",token),observer=Identity("observer",token);Publish(Path.Combine(Root,"admit"),Encoding.UTF8.GetBytes(token));
            if(!owner.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||owner.ExitCode!=(deniedStart?1:0))throw new InvalidOperationException("Exact owner outcome differs");
            if(!observer.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||observer.ExitCode!=0)throw new InvalidOperationException("Exact observer cleanup failed");
            string expectedOwner=deniedStart?"worker-failed;reservation-release=false":"worker-complete;provider-fenced=false;reservation-release=false";
            if(NamespacePin.ReadOnce("owner.result")!=expectedOwner||NamespacePin.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Role receipts differ");
            childResult=NamespacePin.ReadOptionalOnce("child.result");
            if(deniedStart?childResult!=null:childResult!="response-lost-held;settled=False;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Child outcome differs");
            if(deniedStart && NamespacePin.ReadOnce("child.refusal")!="guardian-image-mismatch")throw new InvalidOperationException("Expected exact guardian rejection was not observed");
            if(vmPin.ReadOptionalOnce("start.native")!=null||vmPin.ReadOptionalOnce("start.receipt")!=null)throw new InvalidOperationException("Unexpected native start path");
            if(vmPin.ReadOnce("start.submit")!=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(vmPin.ReadOnce("start.intent")) ))throw new InvalidOperationException("Consumed start intent lost");
            passed=true;
        } catch(Exception error){Failures.Add(error.GetType().Name+": "+error.Message);}
        finally{try{if(vmPin!=null)vmPin.Dispose();}catch{Failures.Add("VM namespace close failed");}finally{Cleanup();}}
        Console.WriteLine(Json.Serialize(new{schema="owned-rpc-provider-worker-qualification/1",passed=passed&&Failures.Count==0,deniedStart=deniedStart,origin=Origin,deadline=Deadline,elapsedMs=BoundedWorker.MonotonicMilliseconds()-Origin,root=Root,vmRoot=vmRoot,freeBytes=free,childResult=childResult,failures=Failures,nativeSubmitted=passed?(object)false:null,providerFenced=false,reservationMayRelease=false,vmsChanged=passed?(object)false:null}));
        return passed&&Failures.Count==0?0:1;
    }
}
