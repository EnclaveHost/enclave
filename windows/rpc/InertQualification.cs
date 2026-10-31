// Trusted operator's finite controller. No VM/provider mutation or arbitrary worker.
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

public static class InertQualification {
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
    static long Admit(string[] args,bool hosted){
        var os=One("SELECT LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"LastBootUpTime","TotalVisibleMemorySize","FreePhysicalMemory"});
        long free=checked(Convert.ToInt64(os["FreePhysicalMemory"])*1024);
        if(hosted){
            if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted"||free<3*GiB)
                throw new InvalidOperationException("Disposable hosted headroom required");
            return free;
        }
        Hex(args[5],64);byte[] raw=Read(args[4],262144);
        if(ProtectedAttempt.Hash(raw)!=args[5])throw new InvalidOperationException("Reviewed observation digest differs");
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
        if(free<Required||Math.Min(Num(before["freeBytes"]),Num(after["freeBytes"]))<Required||Convert.ToInt64(disk["FreeSpace"])<16*GiB+16*MiB)
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
    static Process Identity(string role,string token){
        string path=Path.Combine(Root,role+".consumed");while(!File.Exists(path)){CheckTime();Thread.Sleep(5);}
        string[] fields=Encoding.UTF8.GetString(Read(path,4096)).Split(',');
        if(fields.Length!=4||fields[2]!=token||fields[3]!=role)throw new InvalidOperationException("Role binding differs");
        var p=Process.GetProcessById(Int32.Parse(fields[0],CultureInfo.InvariantCulture));Processes.Add(p);IntPtr held=p.Handle;
        if(p.HasExited||p.StartTime.ToUniversalTime().ToFileTimeUtc()!=Int64.Parse(fields[1],CultureInfo.InvariantCulture))throw new InvalidOperationException("Exact role incarnation unavailable");return p;
    }
    static void Schedule(string role,string arguments){
        CheckTime();if(!Admitted||BoundedWorker.MonotonicMilliseconds()>=Origin+5000)throw new InvalidOperationException("Original bootstrap cutoff");
        string name="EnclaveRpcQualification-"+Path.GetFileName(Root)+"-"+role;Tasks.Add(name,arguments);
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
        task.RegistrationInfo.Description="One-shot inert RPC qualification; no VM/provider operations";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
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
    public static int Main(string[] args){
        Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;bool passed=false,hosted=false;long free=0;
        try{
            if(args.Length!=4&&args.Length!=6)throw new ArgumentException("Explicit qualification arguments required");hosted=args[0]=="--hosted-ci";
            if((hosted&&args.Length!=4)||(!hosted&&(args[0]!="--target"||args.Length!=6)))throw new ArgumentException("Qualification mode refused");
            Hex(args[2],64);Hex(args[3],32);
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);Watchdog=BoundedWorker.ArmOwnerObserver(Origin,Deadline,args[3]+args[3]+args[3]+args[3]);
            using(var identity=WindowsIdentity.GetCurrent())if(identity.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
            byte[] entry=Read(args[1],262144);if(ProtectedAttempt.Hash(entry)!=args[2])throw new InvalidOperationException("Entry digest differs");
            free=Admit(args,hosted);string boot=ProtectedAttempt.CurrentBoot();
            string parent=Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)),"EnclaveRpcQualification-"+args[3]);DirectoryNew(parent);Root=Path.Combine(parent,args[3]);DirectoryNew(Root);
            Publish(Path.Combine(Root,"controller.consumed"),Encoding.UTF8.GetBytes(args[3]));Entry=Path.Combine(Root,"entry.exe");Publish(Entry,entry);
            string contract=Path.Combine(Root,"contract.txt");byte[] bytes=Encoding.UTF8.GetBytes("owned-rpc-inert-v1\n"+args[3]+"\n"+boot+"\n"+Origin+"\n"+Deadline+"\n"+args[2]+"\ninert-v1\n");string hash=ProtectedAttempt.Hash(bytes);Publish(contract,bytes);
            NamespacePin=ProtectedAttempt.PinController(contract,hash);Admitted=true;string token=args[3]+boot+hash;
            string arguments=Quote(contract)+" "+hash+" "+Origin+" "+Deadline;Schedule("owner","owner "+arguments);Schedule("observer","observer "+arguments);
            Process owner=Identity("owner",token),observer=Identity("observer",token);Publish(Path.Combine(Root,"admit"),Encoding.UTF8.GetBytes(token));
            foreach(var p in new[]{owner,observer})if(!p.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||p.ExitCode!=0)throw new InvalidOperationException("Exact role completion failed");
            if(Encoding.UTF8.GetString(Read(Path.Combine(Root,"owner.result"),4096))!="inert-complete;provider-fenced=false;reservation-release=false"||Encoding.UTF8.GetString(Read(Path.Combine(Root,"observer.result"),4096))!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Role receipts incomplete");
            passed=true;
        }catch(Exception error){Failures.Add(error.GetType().Name+": "+error.Message);}finally{Cleanup();}
        Console.WriteLine(Json.Serialize(new{schema="owned-rpc-target-inert/2",passed=passed&&Failures.Count==0,hostedCi=hosted,origin=Origin,deadline=Deadline,elapsedMs=BoundedWorker.MonotonicMilliseconds()-Origin,root=Root,freeBytes=free,requiredFreeBytes=Required,failures=Failures,providerFenced=false,reservationMayRelease=false,vmsChanged=false}));
        return passed&&Failures.Count==0?0:1;
    }
}
