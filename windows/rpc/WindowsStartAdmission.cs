// Actual local host admission for a start worker. No hosted-mode bypass.
// All native reads run inside the separately supervised provider worker.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Management;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
internal sealed class WindowsStartAdmission {
    const long MiB=1048576,GiB=1073741824;
    // Whole stack + prospective apps + real host floor + variation + extra
    // transient startup overhead. Existing VM allocations are already in free.
    internal const long Required=20*GiB+39388*MiB+18*GiB+GiB+512*MiB;
    readonly ProtectedAttempt vm;readonly long began;
    readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
    WindowsStartAdmission(ProtectedAttempt vm){this.vm=vm;began=BoundedWorker.MonotonicMilliseconds();}
    void CheckTime(){vm.CheckDeadline();long now=BoundedWorker.MonotonicMilliseconds();if(now<began||now-began>2000)throw new TimeoutException("Aggregate start observation exceeds two seconds");}
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
    Dictionary<string,object> One(string query,string[] properties){var rows=Query("root\\cimv2",query,properties,2);if(rows.Count!=1)throw new InvalidOperationException("Expected singleton");return rows[0];}
    static string TimeText(object value){return ManagementDateTimeConverter.ToDateTime(Str(value)).ToUniversalTime().ToString("o");}
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
    string Deployments(Dictionary<string,object> data,bool raw) {
        var values=new SortedDictionary<string,object>(StringComparer.Ordinal);
        foreach(object row in Rows(data["deployments"])) {
            var r=Obj(row);string id=Str(r["id"]),status=Str(r["status"]);long memory=Num(r["memMb"]);
            if(id.Length==0||memory<0||values.ContainsKey(id))throw new InvalidOperationException("Node commitment identity incomplete");
            object isolation;bool has=raw?r.TryGetValue("isolation",out isolation)&&isolation!=null:Yes(r["hasIsolation"]);
            object held,retire;r.TryGetValue("isolationHeld",out held);r.TryGetValue("isolationRetireFailed",out retire);
            values.Add(id,new object[]{status,memory,has,Yes(held),Yes(retire)});
        }
        return Json.Serialize(values);
    }
    void Read() {
        var os=One("SELECT LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"LastBootUpTime","TotalVisibleMemorySize","FreePhysicalMemory"});
        long free=checked(Convert.ToInt64(os["FreePhysicalMemory"])*1024);
        byte[] raw=vm.ReadAdmission(vm.VmPermit.AdmissionHash);
        var result=Obj(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(raw)));
        var obs=Obj(result["observation"]);var manager=Obj(obs["manager"]);
        if(Num(result["rc"])!=0||result["failure"]!=null||!Yes(result["readOnly"])||Num(obs["nodeExit"])!=0||!Yes(manager["completeTransport"])||Rows(manager["errors"]).Count!=0)
            throw new InvalidOperationException("Incomplete observation");
        Dictionary<string,object> node=null;
        foreach(object row in Rows(manager["observations"])) {var r=Obj(row);if(Str(r["label"])=="node-after"){if(node!=null||Num(r["port"])!=9600||Str(r["path"])!="/v1/host/state")throw new InvalidOperationException("Node observation binding");node=Obj(r["data"]);}}
        if(node==null)throw new InvalidOperationException("Reviewed node commitments missing");
        string nodeExpected=Deployments(node,false);
        if(Deployments(GetLocal(9600,"/v1/host/state"),true)!=nodeExpected)throw new InvalidOperationException("Node commitments changed since review");
        string pending=LivePending();
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
        if(free<Required||Math.Min(Num(before["freeBytes"]),Num(after["freeBytes"]))<Required||Convert.ToInt64(disk["FreeSpace"])<16*GiB+256*MiB)
            throw new InvalidOperationException("Target qualification headroom refused");
        var end=One("SELECT LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem",new[]{"LastBootUpTime","TotalVisibleMemorySize","FreePhysicalMemory"});
        if(TimeText(end["LastBootUpTime"])!=TimeText(os["LastBootUpTime"])||Convert.ToInt64(end["TotalVisibleMemorySize"])!=Convert.ToInt64(os["TotalVisibleMemorySize"])||
            checked(Convert.ToInt64(end["FreePhysicalMemory"])*1024)<Required)throw new InvalidOperationException("End-of-admission host state differs");
        if(LivePending()!=pending||Deployments(GetLocal(9600,"/v1/host/state"),true)!=nodeExpected)throw new InvalidOperationException("Pending commitments changed during admission");
        CheckTime();
    }
    public static void Verify(ProtectedAttempt vm){if(vm==null||vm.VmPermit==null)throw new ArgumentException("Held VM permit required");new WindowsStartAdmission(vm).Read();}
}
}
