// Actual local host admission for a start worker. No hosted-mode bypass.
// All native reads run inside the separately supervised provider worker.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Management;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
internal sealed partial class WindowsStartAdmission {
    const long MiB=1048576,GiB=1073741824;
    // Whole stack + prospective apps + real host floor + variation + extra
    // transient startup overhead including 192 MiB for the original independent cleanup keeper. Existing VM allocations are already in free.
    internal const long Required=20*GiB+39388*MiB+18*GiB+GiB+512*MiB+192*MiB;
    internal const long NativeRequired=Required+192*MiB; // second native keeper:128MiB job+64MiB startup allowance
    readonly ProtectedAttempt vm;readonly string admissionHash;readonly long began;readonly LegacyHandoff.Completion completed;readonly bool freshInventory;readonly Func<object[],string> nativeAuthority;
    readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    WindowsStartAdmission(ProtectedAttempt vm,string admissionHash,LegacyHandoff.Completion completed,bool freshInventory=false,Func<object[],string> nativeAuthority=null){this.nativeAuthority=nativeAuthority;this.vm=vm;this.admissionHash=admissionHash;this.completed=completed;this.freshInventory=freshInventory;began=BoundedWorker.MonotonicMilliseconds();}
    string stage="begin";
    internal const long FreshnessMilliseconds=4000;
    internal static void RequireFresh(long began,long now,string stage) {
        if(began<0||now<began||now-began>FreshnessMilliseconds)throw new TimeoutException("Aggregate start observation exceeds four seconds; phase="+stage+" elapsedMs="+(now>=began&&began>=0?(now-began).ToString(CultureInfo.InvariantCulture):"invalid"));
    }
    void CheckTime(){vm.CheckDeadline();RequireFresh(began,BoundedWorker.MonotonicMilliseconds(),stage);}
    void Stage(string value){CheckTime();stage=value;CheckTime();}
    // Minted by the trusted reader only after all four live listener bindings
    // match held process identities. Never serialized or shared across leases.
    internal sealed class IssuerListeners {
        readonly ProtectedAttempt lease;readonly long began;readonly uint first,second;int consumed;
        internal IssuerListeners(ProtectedAttempt lease,long began,uint first,uint second){
            if(lease==null||began<lease.Origin||first==0||second==0||first==second)throw new ArgumentException("Listener observation binding");
            lease.CheckDeadline();RequireFresh(began,BoundedWorker.MonotonicMilliseconds(),"listeners");
            this.lease=lease;this.began=began;this.first=first;this.second=second;
        }
        internal List<Dictionary<string,object>> Take(ProtectedAttempt reader){
            if(System.Threading.Interlocked.Exchange(ref consumed,1)!=0||!Object.ReferenceEquals(lease,reader))throw new InvalidOperationException("Listener observation consumed or foreign");
            lease.CheckDeadline();RequireFresh(began,BoundedWorker.MonotonicMilliseconds(),"issuer-listeners");
            return new List<Dictionary<string,object>>{
                new Dictionary<string,object>{{"LocalPort",8091},{"OwningProcess",first}},
                new Dictionary<string,object>{{"LocalPort",8095},{"OwningProcess",second}}};
        }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Memory {
        internal uint Size,Load;internal ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,ExtendedAvailable;
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string root,out ulong available,out ulong total,out ulong free);
    [DllImport("kernel32.dll",SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(SafeWaitHandle process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeWaitHandle process,uint flags,StringBuilder image,ref uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeWaitHandle process,uint milliseconds);
    internal static Memory Physical() {
        var memory=new Memory{Size=(uint)Marshal.SizeOf(typeof(Memory))};
        if(memory.Size!=64||!GlobalMemoryStatusEx(ref memory))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(memory.Total==0||memory.Total>Int64.MaxValue||memory.Available>memory.Total)throw new InvalidOperationException("Physical memory shape differs");
        return memory;
    }
    internal static long DiskAvailable() {
        ulong available,total,free;if(!GetDiskFreeSpaceExW(@"C:\",out available,out total,out free))throw new Win32Exception(Marshal.GetLastWin32Error());
        ulong value=Math.Min(available,free);if(total==0||value>total||value>Int64.MaxValue)throw new InvalidOperationException("Disk capacity shape differs");
        return (long)value; // Respect caller quota as well as total volume free space.
    }
    internal static long ManagerCreation(Dictionary<string,object> native,Dictionary<string,object> recorded) {
        long exact;string text=Str(native["creationFileTime"]);
        if(!Int64.TryParse(text,NumberStyles.None,CultureInfo.InvariantCulture,out exact)||exact<=0||exact.ToString(CultureInfo.InvariantCulture)!=text||
            Num(native["pid"])!=Num(recorded["pid"])||!Yes(native["alive"])||Str(native["image"])!=Str(recorded["exe"]))throw new InvalidOperationException("Native manager receipt differs");
        // WMI datetime has microsecond precision. Cross-bind that historical
        // value, then compare the full 100-ns native creation on the held handle.
        long cim=DateTime.Parse(Str(recorded["created"]),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime().ToFileTimeUtc();
        if(cim/10!=exact/10)throw new InvalidOperationException("Native and CIM manager receipt disagree");
        return exact;
    }
    // Query/synchronize only. Hold the exact manager through both end checks;
    // access failure, PID reuse, exit and image mismatch are admission failures.
    internal sealed class HeldManager:IDisposable {
        readonly SafeWaitHandle handle;readonly uint pid;readonly long created;
        internal HeldManager(uint pid,long created,string image) {
            if(pid==0||created<=0||String.IsNullOrEmpty(image))throw new ArgumentException("Exact manager identity required");
            this.pid=pid;this.created=created;handle=OpenProcess(0x100000|0x1000,false,pid);
            if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);}
            try{Check();var value=new StringBuilder(1024);uint length=(uint)value.Capacity;
                if(!QueryFullProcessImageNameW(handle,0,value,ref length))throw new Win32Exception(Marshal.GetLastWin32Error());
                if(!String.Equals(image,value.ToString(),StringComparison.Ordinal))throw new InvalidOperationException("Current manager image differs");
            }catch{handle.Dispose();throw;}
        }
        internal void Check(){
            long actual,exit,kernel,user;
            if(handle.IsClosed||handle.IsInvalid||GetProcessId(handle)!=pid||!GetProcessTimes(handle,out actual,out exit,out kernel,out user)||actual!=created||WaitForSingleObject(handle,0)!=258)
                throw new InvalidOperationException("Current manager incarnation differs");
        }
        public void Dispose(){handle.Dispose();}
    }
    static Dictionary<string,object> Obj(object value){var d=value as Dictionary<string,object>;if(d==null)throw new InvalidOperationException("Object required");return d;}
    static IList Rows(object value){var a=value as IList;if(a==null||a.Count>128)throw new InvalidOperationException("Row bound");return a;}
    static string Str(object value){var s=value as string;if(s==null||s.Length>4096)throw new InvalidOperationException("String required");return s;}
    static long Num(object value){if(!(value is int)&&!(value is long))throw new InvalidOperationException("Integer required");return Convert.ToInt64(value,CultureInfo.InvariantCulture);}
    static bool Yes(object value){return value is bool&&(bool)value;}
    List<Dictionary<string,object>> Query(string scope,string query,string[] properties,int maximum){
        CheckTime();var rows=new List<Dictionary<string,object>>();
        var options=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(3),ReturnImmediately=false,Rewindable=false};
        using(var search=new ManagementObjectSearcher(scope,query,options))using(var results=search.Get())
            foreach(ManagementObject row in results)using(row){
                if(rows.Count>=maximum)throw new InvalidOperationException("Management row bound");
                var item=new Dictionary<string,object>();foreach(string property in properties)item[property]=row[property];rows.Add(item);CheckTime();
            }
        return rows;
    }
    Dictionary<string,object> GetLocal(int port,string path) {
        CheckTime();var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+path);
        request.Proxy=null;request.AllowAutoRedirect=false;request.KeepAlive=false;request.Method="GET";
        request.Timeout=1000;request.ReadWriteTimeout=1000;
        try {
            using(var response=(HttpWebResponse)request.GetResponse()) {
                if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("Pending authority unavailable");
                using(var stream=response.GetResponseStream())using(var output=new MemoryStream()) {
                    var block=new byte[4096];int n;
                    while((n=stream.Read(block,0,block.Length))!=0){CheckTime();if(output.Length+n>262144)throw new InvalidOperationException("Pending response bound");output.Write(block,0,n);}
                    CheckTime();return Obj(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(output.ToArray())));
                }
            }
        }finally{request.Abort();}
    }
    string NativeAppReceipt(){
        var rows=new List<object>();foreach(int port in new[]{8091,8095,8097})rows.Add(new Dictionary<string,object>{{"port",port},{"health",GetLocal(port,"/health")},{"vms",GetLocal(port,"/vms")}});
        return nativeAuthority(rows.ToArray());
    }
    // Missing legacy reservation fields remain UNKNOWN, not an empty queue.
    // All three managers must expose complete current reservations; duplicate
    // managers are counted conservatively rather than guessed to share a pool.
    string LivePending() {
        return PendingReceipt(new object[]{GetLocal(8091,"/health"),GetLocal(8095,"/health"),GetLocal(8097,"/health")});
    }
    internal static string PendingReceipt(object[] managers) {
        if(managers==null||managers.Length!=3)throw new InvalidOperationException("All three manager authorities required");
        var receipts=new List<object>();long total=0;
        for(int index=0;index<managers.Length;index++) {
            int port=new[]{8091,8095,8097}[index];
            var h=Obj(managers[index]);string epoch=Str(h["managerEpoch"]);if(epoch.Length==0)throw new InvalidOperationException("Manager epoch absent");
            var m=Obj(h["memory"]);
            if(!Yes(m["known"])||Rows(m["unknown"]).Count!=0)throw new InvalidOperationException("Pending commitment authority incomplete");
            var reservations=new SortedDictionary<string,long>(StringComparer.Ordinal);
            foreach(object row in Rows(m["reservations"])) {
                var r=Obj(row);string id=Str(r["id"]);long mib=Num(r["vmMiB"]);
                if(id.Length==0||mib<=0||mib>39388||reservations.ContainsKey(id))throw new InvalidOperationException("Unbounded/ambiguous pending commitment");
                reservations.Add(id,mib);total=checked(total+mib);
            }
            receipts.Add(new object[]{port,epoch,reservations});
        }
        if(total>39388)throw new InvalidOperationException("Current pending growth exceeds reviewed allowance");
        return new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32}.Serialize(receipts);
    }
    // This is an equality receipt, never a capacity or pending-memory authority.
    // Legacy queued/refused/stopped records can omit memMb. Preserve absence and
    // null distinctly from zero; active/held allocations must still name memory.
    internal static string DeploymentReceipt(Dictionary<string,object> data,bool raw) {
        return DeploymentReceipt(data,raw,false);
    }
    // Only the caller holding a verified completed allocation cut may compare
    // these retry states as equivalent while that cut remains held. This never authorizes an
    // allocation: all IDs, memory and isolation flags remain in the receipt.
    internal static string DeploymentReceipt(Dictionary<string,object> data,bool raw,bool fencedRetries) {
        var values=new SortedDictionary<string,object>(StringComparer.Ordinal);
        foreach(object row in Rows(data["deployments"])) {
            var r=Obj(row);string id=Str(r["id"]),status=Str(r["status"]);
            object amount;bool present=r.TryGetValue("memMb",out amount),known=present&&amount!=null;
            long memory=known?Num(amount):0;
            if(id.Length==0||status.Length==0||memory<0||values.ContainsKey(id))throw new InvalidOperationException("Node commitment identity incomplete");
            object isolation;bool has=raw?r.TryGetValue("isolation",out isolation)&&isolation!=null:Yes(r["hasIsolation"]);
            object held,retire;r.TryGetValue("isolationHeld",out held);r.TryGetValue("isolationRetireFailed",out retire);
            if(!known&&(status=="running"||status=="claiming"||has||Yes(held)||Yes(retire)))throw new InvalidOperationException("Allocated or claiming node memory unknown");
            bool retry=fencedRetries&&known&&memory>0&&!has&&!Yes(held)&&!Yes(retire)&&(status=="failed"||status=="claiming");
            object state=retry?(object)new object[]{"fenced-unallocated-retry"}:status;
            values.Add(id,new object[]{state,present,known? (object)memory:null,has,Yes(held),Yes(retire)});
        }
        return new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32}.Serialize(values);
    }
    // Diagnostics describe only the two already-compared receipts. No extra
    // observation, new authority, changed equality, or raw host payload logging.
    // Field bits: status=1, memory-present=2, memory=4, isolation=8,
    // held=16, retire=32; missing identity=64. First ID is ordinal-sorted.
    internal static string DeploymentDifference(string expected,string actual) {
        try {
            var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
            var a=Obj(json.DeserializeObject(expected));var b=Obj(json.DeserializeObject(actual));
            var ids=new SortedSet<string>(a.Keys,StringComparer.Ordinal);ids.UnionWith(b.Keys);
            if(ids.Count>256)throw new InvalidOperationException("Diagnostic identity bound");
            int changed=0,mask=0;string first=null;object firstA=null,firstB=null;
            foreach(string id in ids){
                object av,bv;bool ap=a.TryGetValue(id,out av),bp=b.TryGetValue(id,out bv);
                if(ap==bp&&json.Serialize(av)==json.Serialize(bv))continue;
                changed++;
                if(first!=null)continue;
                first=id;firstA=av;firstB=bv;
                if(!ap||!bp){mask=64;continue;}
                var ar=Rows(av);var br=Rows(bv);if(ar.Count!=6||br.Count!=6)throw new InvalidOperationException("Diagnostic shape");
                for(int i=0;i<6;i++)if(json.Serialize(ar[i])!=json.Serialize(br[i]))mask|=1<<i;
            }
            Func<object,int,string> bounded=(value,limit)=>{string text=json.Serialize(value);return text.Length<=limit?text:"sha256:"+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(text));};
            string result="rows="+a.Count+"/"+b.Count+" changed="+changed+" first="+bounded(first,80)+" mask="+mask+
                " expected="+bounded(firstA,120)+" actual="+bounded(firstB,120);
            if(result.Length>450)throw new InvalidOperationException("Diagnostic message bound");
            return result;
        }catch{return "comparison-detail-unavailable";}
    }
    void Read() {
        var held=new List<HeldManager>();try{Read(held);}finally{foreach(var process in held)process.Dispose();}
    }
    void Read(List<HeldManager> held) {
        Stage("physical-before");var os=Physical();long free=(long)os.Available;CheckTime();
        Stage("reviewed-observation");
        byte[] raw=vm.ReadAdmission(admissionHash);
        var result=Obj(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(raw)));
        var obs=Obj(result["observation"]);var manager=Obj(obs["manager"]);
        if(Num(result["rc"])!=0||result["failure"]!=null||!Yes(result["readOnly"])||Num(obs["nodeExit"])!=0||!Yes(manager["completeTransport"])||Rows(manager["errors"]).Count!=0)
            throw new InvalidOperationException("Incomplete observation");
        Dictionary<string,object> node=null;
        foreach(object row in Rows(manager["observations"])) {var r=Obj(row);if(Str(r["label"])=="node-after"){if(node!=null||Num(r["port"])!=9600||Str(r["path"])!="/v1/host/state")throw new InvalidOperationException("Node observation binding");node=Obj(r["data"]);}}
        if(node==null)throw new InvalidOperationException("Reviewed node commitments missing");
        Stage("node-before");var liveNode=GetLocal(9600,"/v1/host/state");
        if(completed!=null)completed.CheckHeld();
        string liveNodeExact=DeploymentReceipt(liveNode,true,completed!=null);
        // The completed cut and pool have already been validated before this
        // read; VerifyResources checks them again below. Legacy unfenced mode
        // keeps strict equality. Completed mode compares only failed/claiming
        // retry metadata equivalently, with held cut/pool checked at both ends.
        string nodeExpected=DeploymentReceipt(node,false,completed!=null);
        string nodeActual=DeploymentReceipt(liveNode,true,completed!=null);
        if(nodeActual!=nodeExpected)throw new InvalidOperationException("Node commitments changed since review: "+DeploymentDifference(nodeExpected,nodeActual));
        Stage("pending-before");string pending=completed==null?LivePending():completed.Receipt;
        var before=Obj(obs["physicalBefore"]);var after=Obj(obs["physicalAfter"]);
        double age=(DateTime.UtcNow-DateTime.Parse(Str(before["atUtc"]),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime()).TotalSeconds;
        if(age<0||age>300||Str(before["boot"])!=Str(after["boot"])||Str(obs["bootNative"])!=vm.Boot||vm.Boot!=ProtectedAttempt.CurrentBoot())throw new InvalidOperationException("Stale/different boot");
        if(Num(before["physicalBytes"])!=(long)os.Total||Num(after["physicalBytes"])!=Num(before["physicalBytes"]))throw new InvalidOperationException("Physical host differs");
        if(Json.Serialize(obs["before"])!=Json.Serialize(obs["after"]))throw new InvalidOperationException("Historical manager incarnation changed");
        IList recorded=Rows(Obj(obs["after"])["value"]);if(recorded.Count!=4)throw new InvalidOperationException("Four listeners required");
        Stage("manager-handles");var ports=new HashSet<long>();
        var nativeManagers=new Dictionary<long,Dictionary<string,object>>();
        foreach(object item in Rows(obs["nativeManagers"])){var row=Obj(item);long pid=Num(row["pid"]);if(nativeManagers.ContainsKey(pid))throw new InvalidOperationException("Duplicate native manager receipt");nativeManagers.Add(pid,row);}
        if(nativeManagers.Count!=4)throw new InvalidOperationException("Four exact native manager receipts required");
        foreach(object item in recorded){var r=Obj(item);long port=Num(r["port"]),pid=Num(r["pid"]);if((port!=8091&&port!=8095&&port!=8097&&port!=9600)||!ports.Add(port)||pid<=0||pid>UInt32.MaxValue)throw new InvalidOperationException("Listener binding invalid");held.Add(new HeldManager((uint)pid,ManagerCreation(nativeManagers[pid],r),Str(r["exe"])));CheckTime();}
        Stage("listeners");var listeners=Query("root\\StandardCimv2","SELECT LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE (LocalPort=8091 OR LocalPort=8095 OR LocalPort=8097 OR LocalPort=9600) AND State=2",new[]{"LocalPort","OwningProcess"},16);
        if(listeners.Count!=4)throw new InvalidOperationException("Current listener count differs");
        uint firstIssuer=0,secondIssuer=0;
        foreach(object item in recorded){var r=Obj(item);long pid=Num(r["pid"]),port=Num(r["port"]);int listenerMatches=0;
            foreach(var l in listeners)if(Convert.ToInt64(l["LocalPort"])==port&&Convert.ToInt64(l["OwningProcess"])==pid)listenerMatches++;
            if(listenerMatches!=1)throw new InvalidOperationException("Current manager incarnation differs");
            if(port==8091)firstIssuer=(uint)pid;else if(port==8095)secondIssuer=(uint)pid;
        }
        var issuerListeners=freshInventory&&completed!=null?new IssuerListeners(vm,began,firstIssuer,secondIssuer):null;
        string nativeBefore=null;if(nativeAuthority!=null){Stage("native-app-before");nativeBefore=NativeAppReceipt();}
        Stage("disk");long disk=DiskAvailable(),required=nativeAuthority==null?Required:NativeRequired;CheckTime();
        if(free<required||Math.Min(Num(before["freeBytes"]),Num(after["freeBytes"]))<required||disk<16*GiB+4*GiB+256*MiB)
            throw new InvalidOperationException("Target qualification headroom refused");
        Stage("physical-after");var end=Physical();CheckTime();
        if(ProtectedAttempt.CurrentBoot()!=vm.Boot||end.Total!=os.Total||end.Available<(ulong)required)throw new InvalidOperationException("End-of-admission host state differs");
        if(!freshInventory){Stage("pending-and-node-after");
            if((completed==null&&LivePending()!=pending)||DeploymentReceipt(GetLocal(9600,"/v1/host/state"),true,completed!=null)!=liveNodeExact)throw new InvalidOperationException("Pending commitments changed during admission");}
        Stage("pool-resources");if(completed!=null){if(freshInventory)completed.Verify(issuerListeners);else completed.VerifyResources();}
        if(freshInventory){Stage("node-after-current-inventory");
            string finalNode=DeploymentReceipt(GetLocal(9600,"/v1/host/state"),true,completed!=null);
            if(finalNode!=liveNodeExact)throw new InvalidOperationException("Node commitments changed during current inventory verification: "+DeploymentDifference(liveNodeExact,finalNode));}
        if(completed!=null)completed.CheckHeld();
        if(nativeAuthority!=null){Stage("native-app-after");if(NativeAppReceipt()!=nativeBefore)throw new InvalidOperationException("Native original manager record changed during admission");}
        Stage("manager-handles-after");foreach(var process in held){process.Check();CheckTime();}
        CheckTime();
    }
    internal static void Verify(ProtectedAttempt vm,ProtectedAttempt reader,ref LegacyHandoff.Completion completed){
        if(vm==null||vm.VmPermit==null||reader==null)throw new ArgumentException("Held VM permit and short provider reader required");
        reader.CheckDeadline();
        var reviewed=Obj(new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32}.DeserializeObject(new UTF8Encoding(false,true).GetString(vm.ReadAdmission(vm.VmPermit.AdmissionHash))));
        object binding;
        if(reviewed.TryGetValue("legacyCutSeed",out binding)){
            if(completed==null)completed=new LegacyHandoff.Completion(Obj(binding),Obj(reviewed["sharedPhysicalPool"]),reader,vm);
            else completed.Verify();
        }else if(completed!=null)throw new InvalidOperationException("Completed handoff mode cannot disappear");
        new WindowsStartAdmission(vm,vm.VmPermit.AdmissionHash,completed).Read();
    }
    // Definition is an Off-only operation and has no GUID or RAM claim yet.
    // Require the actual completed cut and INITIAL pool, never a fabricated VM
    // permit or missing-health fallback. Start separately consumes the full claim.
    internal static void VerifyDefinition(ProtectedAttempt plan,string hash,ProtectedAttempt reader,ref LegacyHandoff.Completion completed){
        if(plan==null||reader==null||reader.LeaseProfile!="definition"||reader.Operation!="define")throw new ArgumentException("Protected definition context required");
        plan.CheckDeadline();reader.CheckDeadline();
        var reviewed=Obj(new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32}.DeserializeObject(new UTF8Encoding(false,true).GetString(plan.ReadAdmission(hash))));
        object binding;if(!reviewed.TryGetValue("legacyCutSeed",out binding))throw new InvalidOperationException("Completed cut required before definition");
        if(completed==null)completed=new LegacyHandoff.Completion(Obj(binding),Obj(reviewed["sharedPhysicalPool"]),reader);
        else completed.Verify();
        new WindowsStartAdmission(plan,hash,completed).Read();
    }
    internal static HostPhysicalPool AcquireShared(ProtectedAttempt vm,StartIdentity id,long workerDeadline,out PhysicalClaim claim) {
        vm.CheckDeadline();vm.VmPermit.Bind(id,vm.ContractHash);
        var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
        var reviewed=Obj(json.DeserializeObject(new UTF8Encoding(false,true).GetString(vm.ReadAdmission(vm.VmPermit.AdmissionHash))));
        var binding=Obj(reviewed["sharedPhysicalPool"]);
        if(binding.Count!=4||Str(binding["schema"])!="host-physical-pool-binding/1")throw new InvalidOperationException("Reviewed shared pool binding required");
        string path=Str(binding["configPath"]),hash=Str(binding["configHash"]);long capacity=Num(binding["capacityBytes"]);
        claim=new PhysicalClaim(hash,id.Boot,"rpc",ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(id.ContractHash+"\n"+id.VmGuid)),vm.VmPermit.TotalBytes);
        var pool=new HostPhysicalPool(path,hash,Math.Min(workerDeadline,vm.Deadline));
        try {
            if(pool.CapacityBytes!=capacity||pool.Boot!=id.Boot)throw new InvalidOperationException("Reviewed shared pool differs");
            pool.Acquire(claim);vm.CheckDeadline();return pool;
        }catch{pool.Dispose();throw;}
    }
}
}
