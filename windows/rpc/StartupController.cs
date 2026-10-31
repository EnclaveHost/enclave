// Trusted operator startup composition. Uses only the already defined/configured
// owned VM; cleanup arms before guardian and the guardian alone opens the gate.
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

public static class StartupController {
    static readonly List<IDisposable> Held=new List<IDisposable>();
    static readonly List<Process> Processes=new List<Process>();
    static readonly Dictionary<string,string> Tasks=new Dictionary<string,string>();
    static readonly List<string> Failures=new List<string>();
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
    static long Origin,Deadline,WorkerOrigin;
    static string Root,Entry;
    static ProtectedAttempt Vm,GuardianPin,StagingPin;
    static StartupCleanupWitness CleanupWitness;
    static readonly Dictionary<string,string> TaskImages=new Dictionary<string,string>();
    static readonly HashSet<string> IndependentTasks=new HashSet<string>();
    static readonly HashSet<int> IndependentProcesses=new HashSet<int>();
    static bool Admitted;
    static dynamic Folder;
    static ProtectedAttempt NamespacePin;
    static BoundedWorker.OwnerObserver Watchdog;
    const long MiB=1048576,GiB=1073741824;
    internal const long Required=20*GiB+18*GiB+39388*MiB+GiB+512*MiB+192*MiB+192*MiB+256*MiB;
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
    static long Admit(string observationPath,string observationHash){
        var os=One("SELECT LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"LastBootUpTime","TotalVisibleMemorySize","FreePhysicalMemory"});
        long free=checked(Convert.ToInt64(os["FreePhysicalMemory"])*1024);
        Hex(observationHash,64);byte[] raw=Read(observationPath,262144);
        if(ProtectedAttempt.Hash(raw)!=observationHash)throw new InvalidOperationException("Reviewed observation digest differs");
        var result=Obj(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(raw)));
        var obs=Obj(result["observation"]);var manager=Obj(obs["manager"]);
        if(Num(result["rc"])!=0||result["failure"]!=null||!Yes(result["readOnly"])||Num(obs["nodeExit"])!=0||!Yes(manager["completeTransport"])||Rows(manager["errors"]).Count!=0)
            throw new InvalidOperationException("Incomplete observation");
        var before=Obj(obs["physicalBefore"]);var after=Obj(obs["physicalAfter"]);
        double age=(DateTime.UtcNow-DateTime.Parse(Str(before["atUtc"]),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime()).TotalSeconds;
        if(age<0||age>300||Str(before["boot"])!=Str(after["boot"])||Str(after["boot"])!=TimeText(os["LastBootUpTime"]))throw new InvalidOperationException("Stale/different boot");
        if(Num(before["physicalBytes"])!=checked(Convert.ToInt64(os["TotalVisibleMemorySize"])*1024)||Num(after["physicalBytes"])!=Num(before["physicalBytes"]))throw new InvalidOperationException("Physical host differs");
        if(Json.Serialize(obs["before"])!=Json.Serialize(obs["after"]))throw new InvalidOperationException("Historical manager incarnation changed");
        IList recorded=Rows(Obj(obs["after"])["value"]);if(recorded.Count!=4)throw new InvalidOperationException("Four listeners required");
        var ports=new HashSet<long>();var filters=new List<string>();
        foreach(object item in recorded){var r=Obj(item);long port=Num(r["port"]),pid=Num(r["pid"]);if((port!=8091&&port!=8095&&port!=8097&&port!=9600)||!ports.Add(port)||pid<=0||pid>UInt32.MaxValue)throw new InvalidOperationException("Listener binding invalid");filters.Add("ProcessId="+pid);}
        var listeners=Query("root\\StandardCimv2","SELECT LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE (LocalPort=8091 OR LocalPort=8095 OR LocalPort=8097 OR LocalPort=9600) AND State=2",new[]{"LocalPort","OwningProcess"},16);
        var processes=Query("root\\cimv2","SELECT ProcessId,CreationDate,ExecutablePath FROM Win32_Process WHERE "+String.Join(" OR ",filters),new[]{"ProcessId","CreationDate","ExecutablePath"},16);
        if(listeners.Count!=4)throw new InvalidOperationException("Current listener count differs");
        foreach(object item in recorded){var r=Obj(item);long pid=Num(r["pid"]),port=Num(r["port"]);int listenerMatches=0,processMatches=0;
            foreach(var l in listeners)if(Convert.ToInt64(l["LocalPort"])==port&&Convert.ToInt64(l["OwningProcess"])==pid)listenerMatches++;
            foreach(var p in processes)if(Convert.ToInt64(p["ProcessId"])==pid&&TimeText(p["CreationDate"])==Str(r["created"])&&Str(p["ExecutablePath"])==Str(r["exe"]))processMatches++;
            if(listenerMatches!=1||processMatches!=1)throw new InvalidOperationException("Current manager incarnation differs");
        }
        var disk=One("SELECT FreeSpace FROM Win32_LogicalDisk WHERE DeviceID='C:'",new[]{"FreeSpace"});
        if(free<Required||Math.Min(Num(before["freeBytes"]),Num(after["freeBytes"]))<Required||Convert.ToInt64(disk["FreeSpace"])<StartupDiskBudget.Floor+StartupDiskBudget.MaximumBoot+StartupDiskBudget.Artifacts)
            throw new InvalidOperationException("Target qualification headroom refused");
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
    static Process Identity(string directory,string role,string token,bool independent){
        string path=Path.Combine(directory,role+".consumed");while(!File.Exists(path)){CheckTime();Thread.Sleep(5);}
        string[] fields=Encoding.UTF8.GetString(Read(path,4096)).Split(',');
        if(fields.Length!=4||fields[2]!=token||fields[3]!=role)throw new InvalidOperationException("Role binding differs");
        var p=Process.GetProcessById(Int32.Parse(fields[0],CultureInfo.InvariantCulture));Processes.Add(p);IntPtr held=p.Handle;
        if(p.HasExited||p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(fields[1],CultureInfo.InvariantCulture))throw new InvalidOperationException("Exact role incarnation unavailable");if(independent)IndependentProcesses.Add(p.Id);return p;
    }
    static void Schedule(string role,string arguments,string image,string directory,bool independent){
        CheckTime();if(!Admitted||(!independent&&(WorkerOrigin==0||BoundedWorker.MonotonicMilliseconds()>=WorkerOrigin+5000)))throw new InvalidOperationException("Original worker bootstrap cutoff");
        string name="EnclaveRpcStartup-"+Path.GetFileName(Root)+"-"+role;
        // Record intent before registration: a lost COM response is not a retry.
        Tasks.Add(name,arguments);TaskImages.Add(name,image);
        if(independent)IndependentTasks.Add(name);
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
        task.RegistrationInfo.Description="Owned RPC one-shot "+role+"; original permit deadline; no automatic retry";
        task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
        task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;
        task.Settings.ExecutionTimeLimit=independent?"PT16M":"PT30S";task.Settings.MultipleInstances=2;
        task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
        dynamic action=task.Actions.Create(0);action.Path=image;action.WorkingDirectory=directory;action.Arguments=arguments;
        dynamic registered=Folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
    }
    internal static OwnedVmPermit PermitFromDefinition(string raw,string exactGuid){
        if(raw==null||Encoding.UTF8.GetByteCount(raw)>4096)throw new ArgumentException("Definition bound");
        string[] f=raw.Split('\n');if(f.Length!=12)throw new ArgumentException("Definition shape");
        var p=new OwnedVmPermit(f[1],f[2],f[3],f[4],exactGuid,Path.Combine(f[5],"vm"),
            Int64.Parse(f[6],NumberStyles.None,CultureInfo.InvariantCulture),Int64.Parse(f[7],NumberStyles.None,CultureInfo.InvariantCulture),19*GiB,GiB);
        BootStartBinding.ValidateDefinition(raw,p);
        string parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclaveRpcVm-"+p.Attempt);
        if(f[5]!=Path.Combine(parent,p.Attempt))throw new InvalidOperationException("Original fixed owned VM root required");
        return p;
    }
    internal static void ValidateWindow(OwnedVmPermit p,long origin,long deadline,long now){
        if(origin<p.Origin||origin>now||now-origin>=5000||deadline<=now||deadline<=origin||deadline-origin>30000||deadline>p.Deadline)
            throw new InvalidOperationException("Startup controller must remain inside original permit and bootstrap window");
    }
    internal static string DefinedGuid(string raw){
        var d=StartRecords.Parse(raw,new[]{"receipt","system"});StartIdentity.Hex(StartRecords.Text(d["receipt"]),64);
        string path=StartRecords.Text(d["system"]);
        const string prefix="Msvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\"";
        if(path.Length!=prefix.Length+37||!path.StartsWith(prefix,StringComparison.Ordinal)||!path.EndsWith("\"",StringComparison.Ordinal))throw new InvalidOperationException("Exact canonical recorded definition system required");
        string guid=path.Substring(prefix.Length,36);Guid g;
        if(!Guid.TryParseExact(guid,"D",out g)||g==Guid.Empty||g.ToString("D")!=guid)throw new InvalidOperationException("Exact definition GUID required");return guid;
    }
    static void Cleanup(){
        // Never stop the independent VM cleanup/guardian because this short
        // operator controller finishes or fails. Their immutable deadlines remain.
        foreach(var pair in Tasks){
            if(IndependentTasks.Contains(pair.Key))continue;
            try{dynamic task=Folder.GetTask(pair.Key);dynamic d=task.Definition;dynamic a=d.Actions.Item(1);string user=d.Principal.UserId;
                if(d.Actions.Count!=1||(user!="SYSTEM"&&user!="S-1-5-18")||d.Principal.LogonType!=5||a.Path!=TaskImages[pair.Key]||a.WorkingDirectory!=Root||a.Arguments!=pair.Value)throw new InvalidOperationException("Task association differs");
                task.Enabled=false;task.Stop(0);Folder.DeleteTask(pair.Key,0);
            }catch{Failures.Add("Exact short task cleanup unconfirmed: "+pair.Key);}
        }
        foreach(var p in Processes){try{if(!IndependentProcesses.Contains(p.Id)&&!p.HasExited)Failures.Add("Exact short role still alive");}catch{Failures.Add("Exact role death unconfirmed");}try{p.Dispose();}catch{}}
        if(CleanupWitness!=null)CleanupWitness.Dispose();if(Vm!=null)Vm.Dispose();if(GuardianPin!=null)GuardianPin.Dispose();if(NamespacePin!=null)NamespacePin.Dispose();if(StagingPin!=null)StagingPin.Dispose();
        foreach(var h in Held)try{h.Dispose();}catch{Failures.Add("Input close failed");}
    }
    public static int Main(string[] args){
        Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;
        bool completed=false;string result=null,vmRoot=null;long free=0;
        try{
            // entry/hash, cleanup/hash, exact definition/hash, fresh observation/hash,
            // unique short worker nonce and original short controller window.
            if(args.Length!=13||args[0]!="--target")throw new ArgumentException("Explicit target startup arguments required");
            Origin=Int64.Parse(args[11],NumberStyles.None,CultureInfo.InvariantCulture);Deadline=Int64.Parse(args[12],NumberStyles.None,CultureInfo.InvariantCulture);
            Hex(args[2],64);Hex(args[4],64);Hex(args[6],64);Hex(args[8],64);Hex(args[10],32);
            if(args[9]!="start-once")throw new ArgumentException("Explicit one-shot startup operation required");
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);Watchdog=BoundedWorker.ArmOwnerObserver(Origin,Deadline,args[10]+args[10]+args[10]+args[10]);
            using(var id=WindowsIdentity.GetCurrent())if(id.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
            byte[] entry=Read(args[1],262144),cleanup=Read(args[3],262144),definition=Read(args[5],4096);
            if(ProtectedAttempt.Hash(entry)!=args[2]||ProtectedAttempt.Hash(cleanup)!=args[4]||ProtectedAttempt.Hash(definition)!=args[6])throw new InvalidOperationException("Reviewed startup image/definition differs");
            vmRoot=Path.GetDirectoryName(args[5]);if(Path.GetFileName(args[5])!="definition-plan.txt")throw new ArgumentException("Existing definition path required");
            StagingPin=ProtectedAttempt.PinStartupStaging(args[5],args[6],Origin,Deadline);
            string raw=new UTF8Encoding(false,true).GetString(definition),actual=DefinedGuid(StagingPin.ReadOnce("definition.system"));
            if(StagingPin.ReadBootDefinition()!=raw)throw new InvalidOperationException("Held original definition differs");
            var permit=PermitFromDefinition(raw,actual);ValidateWindow(permit,Origin,Deadline,BoundedWorker.MonotonicMilliseconds());
            if(Path.GetDirectoryName(permit.ConfigurationRoot)!=vmRoot||permit.ImageHash!=args[2]||permit.Boot!=ProtectedAttempt.CurrentBoot())throw new InvalidOperationException("Original VM source/boot/root differs");
            free=Admit(args[7],args[8]);
            // Consume before publishing any images or scheduling. Any interrupted
            // publication remains held; this entrypoint has no recovery/retry mode.
            Publish(Path.Combine(vmRoot,"startup-controller.consumed"),Encoding.UTF8.GetBytes(args[10]));
            Publish(Path.Combine(vmRoot,"entry.exe"),entry);Publish(Path.Combine(vmRoot,"cleanup.exe"),cleanup);
            string permitPath=Path.Combine(vmRoot,"vm-permit.txt"),permitHash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(permit.Encode()));
            Publish(permitPath,Encoding.UTF8.GetBytes(permit.Encode()));GuardianPin=ProtectedAttempt.PinVmGuardianController(permitPath,permitHash);
            if(GuardianPin.ReadBootDefinition()!=raw)throw new InvalidOperationException("Held definition changed");
            var cleanupBinding=StartupCleanupBinding.Read(GuardianPin);if(cleanupBinding.ImageHash!=args[4])throw new InvalidOperationException("Cleanup differs from original admission");GuardianPin.ReadCleanupImage(args[4]);
            // Establish the protected boot records/media before scheduling. Native
            // graph/physical admission is revalidated by the SYSTEM start worker.
            var boot=new BootStartBinding(GuardianPin,delegate{CheckTime();GuardianPin.CheckDeadline();});boot.Verify();
            string parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"EnclaveRpcStartup-"+args[10]);DirectoryNew(parent);Root=Path.Combine(parent,args[10]);DirectoryNew(Root);
            Entry=Path.Combine(Root,"entry.exe");Publish(Entry,entry);
            Admitted=true;
            Schedule("cleanup",Quote(permitPath)+" "+permitHash+" "+permit.Origin+" "+permit.Deadline,Path.Combine(vmRoot,"cleanup.exe"),vmRoot,true);
            while(!File.Exists(Path.Combine(vmRoot,"cleanup.armed"))){CheckTime();Thread.Sleep(5);}
            CleanupWitness=new StartupCleanupWitness(GuardianPin);CleanupWitness.Check();
            Schedule("guardian","guardian "+Quote(permitPath)+" "+permitHash+" "+permit.Origin+" "+permit.Deadline,Path.Combine(vmRoot,"entry.exe"),vmRoot,true);
            Process guardian=Identity(vmRoot,"guardian",GuardianPin.Token,true);uint guardianPid=(uint)guardian.Id;long guardianCreation=guardian.StartTime.ToUniversalTime().ToFileTimeUtc();
            WorkerOrigin=BoundedWorker.MonotonicMilliseconds();
            string contract=Path.Combine(Root,"contract.txt");
            byte[] contractBytes=Encoding.UTF8.GetBytes("owned-rpc-provider-worker-v1\n"+args[10]+"\n"+permit.Boot+"\n"+WorkerOrigin+"\n"+Deadline+"\n"+permit.ImageHash+"\nstart\n"+permitPath+"\n"+permitHash+"\n"+guardianPid+"\n"+guardianCreation+"\n");
            string contractHash=ProtectedAttempt.Hash(contractBytes);Publish(contract,contractBytes);NamespacePin=ProtectedAttempt.PinProviderController(contract,contractHash);
            Vm=ProtectedAttempt.PinVmJournalController(permitPath,permitHash,NamespacePin,false);
            if(Vm.ReadOptionalOnce("start.intent")!=null||Vm.ReadOptionalOnce("start.submit")!=null||Vm.ReadOptionalOnce("start.native")!=null)throw new InvalidOperationException("Original start already consumed");
            string arguments=Quote(contract)+" "+contractHash+" "+WorkerOrigin+" "+Deadline;
            Schedule("owner","owner "+arguments,Entry,Root,false);Schedule("observer","observer "+arguments,Entry,Root,false);
            Process owner=Identity(Root,"owner",NamespacePin.Token,false),observer=Identity(Root,"observer",NamespacePin.Token,false);
            CleanupWitness.Check();ValidateWindow(permit,WorkerOrigin,Deadline,BoundedWorker.MonotonicMilliseconds());
            // Only independently running guardian may attach the gated pair and
            // publish admit. The operator controller never opens that work gate.
            GuardianPin.WriteOnce("guardian.request",contract+"\n"+contractHash);
            foreach(var process in new[]{owner,observer})if(!process.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||process.ExitCode!=0)throw new InvalidOperationException("Exact start role outcome failed/unknown");
            if(NamespacePin.ReadOnce("owner.result")!="worker-complete;provider-fenced=false;reservation-release=false"||NamespacePin.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Exact start role receipts differ");
            result=NamespacePin.ReadOnce("child.result");CleanupWitness.Check();completed=true;
        }catch(Exception error){Failures.Add(error.GetType().Name+": "+error.Message);}
        finally{Cleanup();}
        Console.WriteLine(Json.Serialize(new{schema="owned-rpc-startup-controller/1",localWorkerCompleted=completed&&Failures.Count==0,origin=Origin,deadline=Deadline,root=Root,vmRoot=vmRoot,result=result,freeBytes=free,requiredFreeBytes=Required,independentTasksRetained=IndependentTasks.Count,failures=Failures,rpcReadinessProven=false,reservationMayRelease=false}));
        return completed&&Failures.Count==0?0:1;
    }
}

namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  // Read-only custody of the existing definition namespace BEFORE operator
  // publication. No start authority, no directory creation, no mutable fallback.
  internal static ProtectedAttempt PinStartupStaging(string path,string hash,long origin,long deadline){
   RequireAdministrator();return new ProtectedAttempt(path,hash,origin,deadline,true);
  }
  private ProtectedAttempt(string path,string hash,long origin,long deadline,bool staging){
   if(!staging)throw new ArgumentException("Explicit startup custody required");Hex(hash,64);LocalPath(path);
   if(Path.GetFileName(path)!="definition-plan.txt")throw new ArgumentException("Existing definition plan required");
   long now=BoundedWorker.MonotonicMilliseconds();
   if(origin<0||origin>now||now-origin>=5000||deadline<=now||deadline<=origin||deadline-origin>30000)throw new ArgumentException("Original staging deadline");
   Root=Path.GetDirectoryName(path);Nonce=Path.GetFileName(Root);Hex(Nonce,32);Boot=CurrentBoot();Origin=origin;Deadline=deadline;ContractHash=hash;LeaseProfile="startup-staging";recordOwner=AdminSid;
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');
    for(int i=0;i<parts.Length;i++){current=Path.Combine(current,parts[i]);HoldDirectory(current,i==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,4096),4096);if(Hash(raw)!=hash)throw new InvalidOperationException("Held definition hash differs");
    string[] fields=Utf8.GetString(raw).Split('\n');if(fields.Length!=12||fields[1]!=Nonce||fields[2]!=Boot||fields[5]!=Root)throw new InvalidOperationException("Original definition identity/root differs");CheckDeadline();
   }catch{Dispose();throw;}
  }
 }
}
