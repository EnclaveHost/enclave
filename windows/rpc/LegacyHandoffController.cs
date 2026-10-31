// Trusted operator controller for the explicit legacy handoff profile.
// Inspect reads inventory; cut persistently denies template reads. No VM operations.
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

public static class LegacyHandoffController {
    static readonly List<IDisposable> Held=new List<IDisposable>();
    static readonly List<Process> Processes=new List<Process>();
    static readonly Dictionary<string,string> Tasks=new Dictionary<string,string>();
    static readonly List<string> Failures=new List<string>();
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
    static long Origin,Deadline;
    static string Root,Entry,Operation,ManifestHash;
    static object InventoryResult;
    static bool Admitted;
    static dynamic Folder;
    static ProtectedAttempt NamespacePin;
    static BoundedWorker.OwnerObserver Watchdog;
    const long MiB=1048576,GiB=1073741824;
    const long Required=18*GiB+39388*MiB+GiB+512*MiB+192*MiB+256*MiB;
    internal static void RequireSeedCompletion(byte[] activation,string completion){
        if(activation==null||completion==null||completion!=ProtectedAttempt.Hash(activation))throw new InvalidOperationException("Seed completion missing or differs");
    }
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
    static long Admit(string[] args){
        var os=One("SELECT LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"LastBootUpTime","TotalVisibleMemorySize","FreePhysicalMemory"});
        long free=checked(Convert.ToInt64(os["FreePhysicalMemory"])*1024);
        Hex(args[6],64);byte[] raw=Read(args[5],262144);
        if(ProtectedAttempt.Hash(raw)!=args[6])throw new InvalidOperationException("Reviewed observation digest differs");
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
        string name="EnclaveRpcLegacyHandoff-"+Path.GetFileName(Root)+"-"+role;Tasks.Add(name,arguments);
        dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();Folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
        task.RegistrationInfo.Description="One-shot legacy handoff: "+Operation+"; no VM/provider operations";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
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
        Origin=BoundedWorker.MonotonicMilliseconds();Deadline=Origin+30000;bool passed=false;long free=0;
        try{
            if(args.Length!=11||args[0]!="--target")throw new ArgumentException("Explicit target handoff arguments required");
            Operation=args[4];
            if(Operation!="legacy-memory-inspect-v1"&&Operation!="legacy-memory-cut-v1"&&Operation!="legacy-memory-cut-seed-v1"&&Operation!="legacy-memory-resident-inspect-v1")throw new ArgumentException("Explicit operation required");
            // Parent supplies the original same-boot launch clock. A delayed
            // CreateProcess/SSH delivery must not earn a fresh startup window.
            Origin=Int64.Parse(args[args.Length-2],NumberStyles.None,CultureInfo.InvariantCulture);
            Deadline=Int64.Parse(args[args.Length-1],NumberStyles.None,CultureInfo.InvariantCulture);
            Hex(args[2],64);Hex(args[3],32);
            BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);Watchdog=BoundedWorker.ArmOwnerObserver(Origin,Deadline,args[3]+args[3]+args[3]+args[3]);
            using(var identity=WindowsIdentity.GetCurrent())if(identity.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
            byte[] entry=Read(args[1],262144);if(ProtectedAttempt.Hash(entry)!=args[2])throw new InvalidOperationException("Entry digest differs");
            Hex(args[8],64);byte[] manifest=Read(args[7],65536);ManifestHash=args[8];
            if(ProtectedAttempt.Hash(manifest)!=ManifestHash)throw new InvalidOperationException("Reviewed handoff manifest differs");
            free=Admit(args);string boot=ProtectedAttempt.CurrentBoot();
            string parent=Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)),"EnclaveRpcLegacyHandoff-"+args[3]);DirectoryNew(parent);Root=Path.Combine(parent,args[3]);DirectoryNew(Root);
            Publish(Path.Combine(Root,"controller.consumed"),Encoding.UTF8.GetBytes(args[3]));Entry=Path.Combine(Root,"entry.exe");Publish(Entry,entry);
            Publish(Path.Combine(Root,"handoff.json"),manifest);
            string contract=Path.Combine(Root,"contract.txt");byte[] bytes=Encoding.UTF8.GetBytes("owned-rpc-legacy-handoff-v1\n"+args[3]+"\n"+boot+"\n"+Origin+"\n"+Deadline+"\n"+args[2]+"\n"+Operation+"\n"+ManifestHash+"\n");string hash=ProtectedAttempt.Hash(bytes);Publish(contract,bytes);
            NamespacePin=ProtectedAttempt.PinLegacyHandoffController(contract,hash);Admitted=true;string token=args[3]+boot+hash;
            string arguments=Quote(contract)+" "+hash+" "+Origin+" "+Deadline;Schedule("owner","owner "+arguments);Schedule("observer","observer "+arguments);
            Process owner=Identity("owner",token),observer=Identity("observer",token);Publish(Path.Combine(Root,"admit"),Encoding.UTF8.GetBytes(token));
            foreach(var p in new[]{owner,observer})if(!p.WaitForExit((int)Math.Max(0,Deadline-BoundedWorker.MonotonicMilliseconds()))||p.ExitCode!=0){
                throw new InvalidOperationException("Exact role completion failed");
            }
            if(Encoding.UTF8.GetString(Read(Path.Combine(Root,"owner.result"),4096))!="handoff-complete;provider-fenced=false;reservation-release=false"||Encoding.UTF8.GetString(Read(Path.Combine(Root,"observer.result"),4096))!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Role receipts incomplete");
            var receipt=Obj(Json.DeserializeObject(Encoding.UTF8.GetString(Read(Path.Combine(Root,"handoff.result"),4096))));
            if(Str(receipt["schema"])!="legacy-memory-handoff-result/2"||Str(receipt["manifest"])!=ManifestHash||
               !(receipt["inspectOnly"] is bool)||(bool)receipt["inspectOnly"]!=((Operation=="legacy-memory-inspect-v1"||Operation=="legacy-memory-resident-inspect-v1"))||
               !False(receipt["providerSettled"])||!False(receipt["capacityAdmitted"])||!False(receipt["reservationMayRelease"])||!False(receipt["poolSeeded"]))
                throw new InvalidOperationException("Handoff result authority differs");
            long count=Num(receipt["vmCount"]),cutAt=Num(receipt["cutAt"]),sum=0;
            if(count<0||count>32||(((Operation=="legacy-memory-inspect-v1"||Operation=="legacy-memory-resident-inspect-v1"))?cutAt!=0:(cutAt<Origin||cutAt>=Deadline)))throw new InvalidOperationException("Handoff cut binding differs");
            var rows=new List<object>();var index=new List<string>();var ids=new HashSet<string>();
            for(int n=0;n<count;n++){
                string name="vm-"+(char)('a'+n/26)+(char)('a'+n%26);byte[] raw=Read(Path.Combine(Root,name),4096);
                var row=Obj(Json.DeserializeObject(Encoding.UTF8.GetString(raw)));Guid id;
                if(row.Count!=5||!Guid.TryParseExact(Str(row["guid"]),"D",out id)||!ids.Add(id.ToString("D"))||
                   Num(row["cutAt"])!=cutAt||Str(row["manifest"])!=ManifestHash||Num(row["maximumBytes"])<=0)throw new InvalidOperationException("VM inventory binding differs");
                var memory=Obj(row["memory"]);
                if(memory.Count!=6||Str(memory["Rule"])!="fixed-memory-virtual-quantity/1"||!False(memory["DynamicMemoryEnabled"])||
                   Num(memory["Bytes"])!=Num(row["maximumBytes"])||Num(memory["VirtualQuantityMiB"])<=0||
                   checked(Num(memory["VirtualQuantityMiB"])*1048576)!=Num(row["maximumBytes"])||
                   Num(memory["ReservationMiB"])>Num(memory["VirtualQuantityMiB"])||Num(memory["ReservationMiB"])<0||
                   Num(memory["LimitMiB"])<Num(memory["VirtualQuantityMiB"]))throw new InvalidOperationException("Static memory receipt differs");
                sum=checked(sum+Num(row["maximumBytes"]));index.Add(id.ToString("D")+":"+ProtectedAttempt.Hash(raw));rows.Add(row);
            }
            if(sum!=Num(receipt["maximumBytes"])||Encoding.UTF8.GetString(Read(Path.Combine(Root,"handoff.inventory"),4096))!="legacy-vm-inventory/1\n"+String.Join("\n",index))
                throw new InvalidOperationException("VM inventory sum/index differs");
            object seed=null;
            if(Operation=="legacy-memory-cut-seed-v1"){
                byte[] activation=Read(Path.Combine(Root,"pool.activation"),4096);
                RequireSeedCompletion(activation,Encoding.UTF8.GetString(Read(Path.Combine(Root,"pool.complete"),4096)));
                var seeded=Obj(Json.DeserializeObject(Encoding.UTF8.GetString(activation)));
                var expectedSeed=new LegacyPoolSeed(Obj(Obj(Json.DeserializeObject(Encoding.UTF8.GetString(manifest)))["pool"]),boot);
                if(seeded.Count!=18||Str(seeded["configPath"])!=Path.Combine(expectedSeed.Root,"pool.txt")||Str(seeded["poolHash"])!=expectedSeed.Hash||
                   Num(seeded["capacityBytes"])!=expectedSeed.Capacity||Num(seeded["physicalBytes"])!=expectedSeed.Physical||Num(seeded["nonPoolReserveBytes"])!=expectedSeed.NonPoolReserve||
                   Num(seeded["floorBytes"])!=expectedSeed.Floor||Num(seeded["variationBytes"])!=expectedSeed.Variation||Num(seeded["prospectiveBytes"])!=expectedSeed.Prospective||
                   Str(seeded["schema"])!="legacy-pool-seed/1"||Str(seeded["manifest"])!=ManifestHash||Str(seeded["boot"])!=boot||
                   Num(seeded["initialBytes"])!=sum||Num(seeded["initialCount"])!=count||!False(seeded["providerSettled"])||!False(seeded["capacityAdmitted"])||!False(seeded["reservationMayRelease"])||
                   Str(seeded["cutHash"])!=ProtectedAttempt.Hash(Read(Path.Combine(Root,"handoff.cut"),4096))||
                   Str(seeded["inventoryHash"])!=ProtectedAttempt.Hash(Read(Path.Combine(Root,"handoff.inventory"),4096)))throw new InvalidOperationException("Seed association differs");
                seed=seeded;
            }
            object resident=null;
            if(Operation=="legacy-memory-resident-inspect-v1"){
                var r=Obj(Json.DeserializeObject(Encoding.UTF8.GetString(Read(Path.Combine(Root,"handoff.resident"),4096))));
                if(r.Count!=11||Str(r["schema"])!="legacy-resident-memory/1"||Str(r["manifest"])!=ManifestHash||Str(r["boot"])!=boot||
                   Num(r["observedAt"])<Origin||Num(r["observedAt"])>=Deadline||Num(r["configuredBytes"])!=sum)throw new InvalidOperationException("Resident sample binding differs");
                var map=Obj(r["residents"]);long assigned=0;
                if(map.Count!=rows.Count)throw new InvalidOperationException("Resident sample missing GUIDs");
                foreach(object item in rows){var row=Obj(item);string guid=Str(row["guid"]);long bytes=Num(map[guid]);if(bytes<0||bytes>Num(row["maximumBytes"]))throw new InvalidOperationException("Resident quantity exceeds commitment");assigned=checked(assigned+bytes);}
                long physical=Num(r["physicalBytes"]),available=Num(r["freeBytes"]);
                if(physical<=0||available<0||available>physical||assigned>physical-available||Num(r["assignedBytes"])!=assigned||Num(r["latentBytes"])!=sum-assigned||Num(r["nonPoolBytes"])!=physical-available-assigned)throw new InvalidOperationException("Resident accounting differs");
                resident=r;
            }
            InventoryResult=new{receipt=receipt,vms=rows,seed=seed,resident=resident};passed=true;
        }catch(Exception error){
            Failures.Add(error.GetType().Name+": "+error.Message);
            try{
                if(NamespacePin!=null&&File.Exists(Path.Combine(Root,"handoff.failure"))){
                    var d=Obj(Json.DeserializeObject(Encoding.UTF8.GetString(Read(Path.Combine(Root,"handoff.failure"),4096))));
                    var phases=new HashSet<string>{"initial","input-schema","input-parent-open","input-parent-authority","input-file-open","input-file-authority","input-file-identity","input-file-read","issuer-binding","inspect-inventory","seed-preflight","pool-seed","resident-inspection","definition-cut","cut-inventory"};
                    if(d.Count!=9||Str(d["schema"])!="legacy-handoff-failure/1"||Str(d["manifest"])!=ManifestHash||!phases.Contains(Str(d["phase"]))||!False(d["capacityAdmitted"])||!False(d["reservationMayRelease"])||Num(d["inputIndex"]) < -1||Num(d["inputIndex"])>=128||Num(d["parentDepth"]) < -1||Num(d["parentDepth"])>128)throw new InvalidOperationException("Invalid public failure receipt");
                    Failures.Add("Public handoff diagnostic: "+Json.Serialize(new{phase=Str(d["phase"]),inputIndex=Num(d["inputIndex"]),parentDepth=Num(d["parentDepth"]),hresult=Num(d["hresult"]),nativeError=Num(d["nativeError"])}));
                }
            }catch{Failures.Add("Public handoff diagnostic unavailable");}
        }finally{Cleanup();}
        Console.WriteLine(Json.Serialize(new{schema="owned-rpc-target-legacy-handoff/1",passed=passed&&Failures.Count==0,operation=Operation,manifest=ManifestHash,inventory=InventoryResult,origin=Origin,deadline=Deadline,elapsedMs=BoundedWorker.MonotonicMilliseconds()-Origin,root=Root,freeBytes=free,requiredFreeBytes=Required,failures=Failures,providerFenced=false,reservationMayRelease=false,vmsChanged=false}));
        return passed&&Failures.Count==0?0:1;
    }
}
