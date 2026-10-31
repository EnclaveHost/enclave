// Independently scheduled SYSTEM startup deadline controller.
// No VM creation/start and no release. Native cleanup uses exact existing worker.
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

public static class StartupCleanupController {
    static readonly List<IDisposable> Held=new List<IDisposable>();
    static readonly List<Process> Processes=new List<Process>();
    static readonly Dictionary<string,string> Tasks=new Dictionary<string,string>();
    static readonly List<string> Failures=new List<string>();
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
    static ProtectedAttempt Vm;
    static long Origin,Deadline;
    static string Root,Entry,Operation;
    static object CleanupResult;
    static bool Admitted;
    static StartupDiskWatch Disk;
    static dynamic Folder;
    static ProtectedAttempt NamespacePin;
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
    static bool False(object value){return value is bool&&!(bool)value;}
    static bool Yes(object value){return value is bool&&(bool)value;}
    static void DirectoryNew(string path){
        if(Directory.Exists(path)||File.Exists(path))throw new InvalidOperationException("Consumed namespace");
        var acl=new DirectorySecurity();acl.SetOwner(SystemUser);acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(path,acl); // PinController validates/holds raced objects BEFORE any launch.
    }
    static void Publish(string path,byte[] data){
        var acl=new FileSecurity();acl.SetOwner(SystemUser);acl.SetAccessRuleProtection(true,false);
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
        string name="EnclaveRpcStartupCleanup-"+Path.GetFileName(Root)+"-"+role;Tasks.Add(name,arguments);
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
        task.RegistrationInfo.Description="One-shot exact startup cleanup: "+Operation+"; exact original VM stop/reconcile only";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
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
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr process,uint code);
    internal static long CleanupDeadline(long origin,long deadline,long now){
        if(origin<0||origin>Int64.MaxValue-930000||deadline!=origin+900000||now<origin||now>=deadline)throw new ArgumentException("Original cleanup arming window");return deadline+30000;
    }
    internal static void ArmAbsoluteDeadline(long deadline){
        var armed=new ManualResetEvent(false);new Thread(delegate(){armed.Set();while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep((int)Math.Max(1,Math.Min(10,deadline-BoundedWorker.MonotonicMilliseconds())));if(!TerminateProcess(GetCurrentProcess(),127))Environment.FailFast("Cleanup deadline failed");}){IsBackground=true}.Start();
        if(!armed.WaitOne(1000))throw new InvalidOperationException("Independent cleanup watchdog not armed");
    }
    static readonly StartupAdoptionPoll Adoption=new StartupAdoptionPoll();
    static bool Adopted(){
        return Adoption.Check(
            delegate { return BoundedWorker.MonotonicMilliseconds()<Vm.VmPermit.Deadline; },
            delegate { return Vm.ReadOptionalOnce("startup.adoption"); },
            delegate(string raw) {
                var d=StartRecords.Parse(raw,new[]{"schema","permit","boot","vmGuid","startIntent","startReceipt","reportHash","observedAt","decision"});
                string report=StartRecords.Text(d["reportHash"]);Vm.ReadStartupReport(report);
                StartupOperatorAdoption.Validate(raw,Vm.VmPermit,Vm.ContractHash,Vm.ReadOnce("start.intent"),Vm.ReadOnce("start.receipt"),report,BoundedWorker.MonotonicMilliseconds());
            },
            delegate { Vm.WriteOnce("cleanup.adoption-refused","invalid-operator-adoption;cleanup-still-required"); });
    }
    public static int Main(string[] args){
        bool off=false,adopted=false,aborted=false;long originalOrigin=0,originalDeadline=0;
        try{
            if(args.Length!=4)throw new ArgumentException("Exact original permit/hash/origin/deadline required");
            originalOrigin=Int64.Parse(args[2],NumberStyles.None,CultureInfo.InvariantCulture);originalDeadline=Int64.Parse(args[3],NumberStyles.None,CultureInfo.InvariantCulture);
            Deadline=CleanupDeadline(originalOrigin,originalDeadline,BoundedWorker.MonotonicMilliseconds());
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ArmAbsoluteDeadline(Deadline);ProtectedAttempt.RequireSystem();
            Vm=ProtectedAttempt.OpenStartupCleanup(args[0],args[1],originalOrigin,originalDeadline);
            var binding=StartupCleanupBinding.Read(Vm);Vm.ReadCleanupImage(binding.ImageHash);
            using(var self=Process.GetCurrentProcess()){
                if(!String.Equals(self.MainModule.FileName,Path.Combine(Vm.Root,"cleanup.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Exact cleanup image path required");
                Vm.WriteOnce("cleanup.consumed",binding.Armed(Vm,(uint)self.Id,self.StartTime.ToUniversalTime().ToFileTimeUtc()));
            }
            string nonce=Guid.NewGuid().ToString("N"),parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclaveRpcStartupCleanup-"+nonce);DirectoryNew(parent);Root=Path.Combine(parent,nonce);DirectoryNew(Root);
            byte[] image=Read(Vm.Executable,262144);if(ProtectedAttempt.Hash(image)!=Vm.ExecutableHash)throw new InvalidOperationException("Original provider image changed");Entry=Path.Combine(Root,"entry.exe");Publish(Entry,image);
            Disk=new StartupDiskWatch(Vm.PinStartupDiskSample(),BoundedWorker.MonotonicMilliseconds);
            while(!Disk.Healthy()&&!Disk.Failed){Vm.CheckDeadline();Thread.Sleep(10);}
            if(Disk.Failed)throw new InvalidOperationException("Initial disk observation failed");
            Vm.WriteOnce("cleanup.armed",Vm.ReadOnce("cleanup.consumed"));
            while(BoundedWorker.MonotonicMilliseconds()<originalDeadline){
                if(!Disk.Healthy()){
                    Vm.WriteOnce("startup.abort",StartupAbort.Encode(Vm.VmPermit,Vm.ContractHash,BoundedWorker.MonotonicMilliseconds()));aborted=true;
                    StartupAbort.CloseGuardian(Vm);break;
                }
                if(Adopted()&&Disk.Healthy()){adopted=true;break;}Thread.Sleep(100);
            }
            if(adopted){Vm.WriteOnce("cleanup.result","operator-adopted;readiness-proven=false;reservation-release=false");}
            else{
                Vm.CheckDeadline();Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Math.Min(originalDeadline+29000,Origin+29000);ArmAbsoluteDeadline(Deadline+1000);
                if(Origin>=Deadline||Deadline-Origin>30000)throw new InvalidOperationException("Cleanup dispatch window exhausted");
                string intent=Vm.ReadOnce("start.intent");var id=StartIdentity.Decode(intent);Vm.VmPermit.Bind(id,Vm.ContractHash);
                Operation=Vm.ReadOptionalOnce("stop.submit")==null&&Vm.ReadOptionalOnce("stop.native")==null?"stop":"stop-reconcile";
                Vm.WriteOnce("cleanup.dispatch",Root+";"+Operation+";"+Origin+";"+Deadline);
                byte[] raw=Encoding.UTF8.GetBytes("owned-rpc-provider-worker-v1\n"+nonce+"\n"+Vm.Boot+"\n"+Origin+"\n"+Deadline+"\n"+Vm.ExecutableHash+"\n"+Operation+"\n"+args[0]+"\n"+args[1]+"\n0\n0\n");
                string contract=Path.Combine(Root,"contract.txt"),hash=ProtectedAttempt.Hash(raw);Publish(contract,raw);NamespacePin=ProtectedAttempt.PinProviderController(contract,hash);Admitted=true;
                string token=nonce+Vm.Boot+hash,arguments=Quote(contract)+" "+hash+" "+Origin+" "+Deadline;
                Schedule("owner","owner "+arguments);Schedule("observer","observer "+arguments);
                Process owner=Identity("owner",token),observer=Identity("observer",token);Publish(Path.Combine(Root,"admit"),Encoding.UTF8.GetBytes(token));
                foreach(var process in new[]{owner,observer})if(!process.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||process.ExitCode!=0)throw new InvalidOperationException("Exact cleanup role completion failed");
                if(Encoding.UTF8.GetString(Read(Path.Combine(Root,"owner.result"),4096))!="worker-complete;provider-fenced=false;reservation-release=false"||Encoding.UTF8.GetString(Read(Path.Combine(Root,"observer.result"),4096))!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Exact cleanup roles missing receipts");
                string result=Encoding.UTF8.GetString(Read(Path.Combine(Root,"child.result"),4096));
                off=result=="owned-off-zero-observed;start-settled=True;stop-settled=True;owned-off-zero=True;provider-fenced=false;reservation-release=false";
                CleanupResult=result;Vm.WriteOnce("cleanup.result",off?"owned-off-zero-observed;reservation-release=false":"cleanup-unconfirmed-held;reservation-release=false");
            }
        }catch(Exception error){Failures.Add(error.GetType().Name+": "+error.Message);}
        finally{if(Disk!=null)Disk.Dispose();Cleanup();if(Vm!=null)Vm.Dispose();}
        Console.WriteLine(Json.Serialize(new{schema="owned-rpc-startup-cleanup/1",completed=(off||adopted)&&Failures.Count==0,ownedOffZero=off,operatorAdopted=adopted,diskAborted=aborted,rpcReadinessProven=false,originalOrigin=originalOrigin,originalDeadline=originalDeadline,result=CleanupResult,failures=Failures,reservationMayRelease=false}));
        return (off||adopted)&&Failures.Count==0?0:1;
    }
}
