// Admission data collected inside the already supervised diagnostic controller.
// No child process, provider mutation, new clock, or production authorization.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 internal interface IDiagnosticObservationSource {
  Dictionary<string,object> Physical();
  IList Bindings();
  Dictionary<string,object> Get(int port,string path);
  IList NativeManagers(IList bindings);
  string Boot {get;}
 }
 internal static class DiagnosticObservationCollector {
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  internal static Dictionary<string,object> Object(object value){var d=value as Dictionary<string,object>;if(d==null)throw new InvalidOperationException("Observation object required");return d;}
  internal static IList Rows(object value){var r=value as IList;if(r==null||r.Count>128)throw new InvalidOperationException("Observation row bound");return r;}
  static Dictionary<string,object> Pick(Dictionary<string,object> value,params string[] keys){var d=new Dictionary<string,object>();foreach(string key in keys){object v;if(value.TryGetValue(key,out v))d.Add(key,v);}return d;}
  static string BindingReceipt(IList rows,bool native){
   var sorted=new SortedDictionary<string,string>(StringComparer.Ordinal);var json=new JavaScriptSerializer();
   foreach(object item in Rows(rows)){var r=Object(item);long key=Convert.ToInt64(r[native?"pid":"port"]);
    if(key<=0)throw new InvalidOperationException("Manager binding key");
    object[] fields=native?new object[]{r["creationFileTime"],r["image"],r["alive"]}:new object[]{r["pid"],r["created"],r["exe"]};
    sorted.Add(key.ToString(CultureInfo.InvariantCulture),json.Serialize(fields));
   }if(sorted.Count!=4)throw new InvalidOperationException("Four distinct manager bindings required");return json.Serialize(sorted);
  }
  static object ProjectNode(Dictionary<string,object> node){
   var rows=new List<object>();foreach(object item in Rows(node["deployments"])){
    var r=Object(item);var v=Pick(r,"id","status","memMb","cpuShare","needCpuShare","isolationRequired");object x;
    v["hasIsolation"]=r.TryGetValue("isolation",out x)&&x!=null;
    foreach(string key in new[]{"isolationHeld","isolationRetireFailed"})v[key]=r.TryGetValue(key,out x)&&x is bool&&(bool)x;
    rows.Add(v);
   }return new Dictionary<string,object>{{"deployments",rows}};
  }
  static object ProjectHealth(Dictionary<string,object> h){
   var d=Pick(h,"managerEpoch","backend","canStart");object x;
   if(h.TryGetValue("memory",out x)&&x!=null){var m=Object(x);var p=Pick(m,"rule","poolMiB","reservedMiB","known","freeMiB","vmMiB","vmOverheadMiB");
    p["unknownCount"]=m.TryGetValue("unknown",out x)&&x is IList?(object)Rows(x).Count:null;
    p["reservationsPresent"]=m.ContainsKey("reservations");var rs=new List<object>();
    if(m.TryGetValue("reservations",out x)&&x!=null){foreach(object r in Rows(x))rs.Add(Pick(Object(r),"id","name","status","appMiB","vmMiB"));p["reservations"]=rs;}else p["reservations"]=null;
    d["memory"]=p;
   }else d["memory"]=null;
   return d;
  }
  static object ProjectVms(Dictionary<string,object> data){var rows=new List<object>();foreach(object item in Rows(data["vms"])){var r=Object(item);var v=Pick(r,"id","name","status","recovered","unattributed");object m;if(r.TryGetValue("memory",out m)&&m!=null)v["memory"]=Pick(Object(m),"appMiB","vmMiB");rows.Add(v);}return new Dictionary<string,object>{{"vms",rows}};}
  // Dependencies are injectable only at this internal collection boundary for
  // finite fixture tests. Production always constructs NativeDiagnosticSource.
  internal static byte[] Collect(byte[] initial,string expectedHash,string boot,IDiagnosticObservationSource source,Action check){
   if(source==null||check==null||initial==null||initial.Length==0||initial.Length>262144||ProtectedAttempt.Hash(initial)!=expectedHash)throw new InvalidOperationException("Initial observation differs");
   var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};var prior=Object(json.DeserializeObject(Utf8.GetString(initial)));
   var cut=Object(prior["legacyCutSeed"]);var pool=Object(prior["sharedPhysicalPool"]);var original=Object(prior["observation"]);
   check();if(source.Boot!=boot)throw new InvalidOperationException("Collector boot differs");
   var first=source.Physical();check();IList before=source.Bindings();check();
   if(BindingReceipt(before,false)!=BindingReceipt(Rows(Object(original["after"])["value"]),false))throw new InvalidOperationException("Original managers changed before collection");
   var observations=new List<object>();
   Action<string,int,string,Func<Dictionary<string,object>,object>> read=(label,port,path,project)=>{
    check();var data=source.Get(port,path);check();observations.Add(new Dictionary<string,object>{{"label",label},{"port",port},{"path",path},{"data",project(data)}});
   };
   read("node-before",9600,"/v1/host/state",ProjectNode);
   foreach(int port in new[]{8091,8095,8097}){read("manager-before",port,"/health",ProjectHealth);read("manager-vms",port,"/vms",ProjectVms);read("manager-after",port,"/health",ProjectHealth);}
   IList after=source.Bindings();check();if(BindingReceipt(before,false)!=BindingReceipt(after,false))throw new InvalidOperationException("Manager bindings changed while collecting");
   IList native=source.NativeManagers(after);check();if(BindingReceipt(native,true)!=BindingReceipt(Rows(original["nativeManagers"]),true))throw new InvalidOperationException("Original native managers changed");
   var last=source.Physical();check();if(source.Boot!=boot)throw new InvalidOperationException("Collector boot changed");
   // Last network read minimizes the time between node status capture and the
   // child's unchanged exact live comparison. Collection is never admission.
   read("node-after",9600,"/v1/host/state",ProjectNode);
   var obs=new Dictionary<string,object>{{"bootNative",boot},{"physicalBefore",first},{"physicalAfter",last},{"before",new Dictionary<string,object>{{"value",before}}},{"after",new Dictionary<string,object>{{"value",after}}},{"nativeManagers",native},{"nodeExit",0},{"manager",new Dictionary<string,object>{{"completeTransport",true},{"errors",new object[0]},{"observations",observations}}}};
   var result=new Dictionary<string,object>{{"schema","owned-rpc-gate-observation/1"},{"rc",0},{"failure",null},{"readOnly",true},{"legacyCutSeed",cut},{"sharedPhysicalPool",pool},{"observation",obs}};
   byte[] bytes=Utf8.GetBytes(json.Serialize(result));if(bytes.Length>262144)throw new InvalidOperationException("Observation output bound");check();return bytes;
  }
 }
 // Controller self-job and independently armed original-deadline watchdog bound
 // stuck WMI/HTTP reads. Elapsed checks alone are not claimed to interrupt them.
 internal sealed class NativeDiagnosticSource:IDiagnosticObservationSource,IDisposable {
  readonly Action check;readonly List<WindowsStartAdmission.HeldManager> held=new List<WindowsStartAdmission.HeldManager>();
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
  internal NativeDiagnosticSource(Action check){this.check=check;}
  public string Boot {get{Check();return ProtectedAttempt.CurrentBoot();}}
  void Check(){check();foreach(var h in held)h.Check();}
  List<Dictionary<string,object>> Query(string scope,string query,string[] properties,int maximum){
   Check();var rows=new List<Dictionary<string,object>>();
   using(var search=new ManagementObjectSearcher(scope,query,new EnumerationOptions{Timeout=TimeSpan.FromSeconds(1),ReturnImmediately=false,Rewindable=false}))using(var results=search.Get())
    foreach(ManagementObject row in results)using(row){if(rows.Count>=maximum)throw new InvalidOperationException("Collector query row bound");var v=new Dictionary<string,object>();foreach(string property in properties)v[property]=row[property];rows.Add(v);Check();}
   return rows;
  }
  public Dictionary<string,object> Physical(){
   Check();long tick=BoundedWorker.MonotonicMilliseconds();var memory=WindowsStartAdmission.Physical();
   var os=Query("root\\cimv2","SELECT LastBootUpTime FROM Win32_OperatingSystem",new[]{"LastBootUpTime"},2);if(os.Count!=1)throw new InvalidOperationException("OS singleton required");
   return new Dictionary<string,object>{{"monotonicMilliseconds",tick},{"atUtc",DateTime.UtcNow.ToString("o")},{"boot",ManagementDateTimeConverter.ToDateTime((string)os[0]["LastBootUpTime"]).ToUniversalTime().ToString("o")},{"physicalBytes",(long)memory.Total},{"freeBytes",(long)memory.Available},{"diskFreeBytes",WindowsStartAdmission.DiskAvailable()}};
  }
  public IList Bindings(){
   var ls=Query("root\\StandardCimv2","SELECT LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE (LocalPort=8091 OR LocalPort=8095 OR LocalPort=8097 OR LocalPort=9600) AND State=2",new[]{"LocalPort","OwningProcess"},16);
   if(ls.Count!=4)throw new InvalidOperationException("Four exact listeners required");var rows=new SortedDictionary<int,object>();
   foreach(var l in ls){int port=Convert.ToInt32(l["LocalPort"]),pid=Convert.ToInt32(l["OwningProcess"]);
    using(var p=Process.GetProcessById(pid)){IntPtr handle=p.Handle;if(p.HasExited)throw new InvalidOperationException("Manager exited");
     string image=p.MainModule.FileName;long creation=p.StartTime.ToUniversalTime().ToFileTimeUtc();
     // Match CIM microsecond precision used by the initial controller receipt.
     string created=DateTime.FromFileTimeUtc(creation-creation%10).ToString("o");
     held.Add(new WindowsStartAdmission.HeldManager((uint)pid,creation,image));
     rows.Add(port,new Dictionary<string,object>{{"port",port},{"pid",pid},{"created",created},{"exe",image}});
    }Check();
   }return new List<object>(rows.Values);
  }
  public IList NativeManagers(IList bindings){
   var rows=new List<object>();foreach(object item in bindings){var r=DiagnosticObservationCollector.Object(item);int pid=Convert.ToInt32(r["pid"]);
    using(var p=Process.GetProcessById(pid)){IntPtr h=p.Handle;Check();if(p.HasExited)throw new InvalidOperationException("Manager exited");rows.Add(new Dictionary<string,object>{{"pid",pid},{"creationFileTime",p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture)},{"image",p.MainModule.FileName},{"alive",true}});}
   }Check();return rows;
  }
  public Dictionary<string,object> Get(int port,string path){
   Check();if(!((port==9600&&path=="/v1/host/state")||((port==8091||port==8095||port==8097)&&(path=="/health"||path=="/vms"))))throw new InvalidOperationException("Fixed local observation endpoint required");
   var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+path);request.Proxy=null;request.AllowAutoRedirect=false;request.KeepAlive=false;request.Timeout=1000;request.ReadWriteTimeout=1000;
   try{using(var response=(HttpWebResponse)request.GetResponse()){if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidOperationException("Observation endpoint refused");
    using(var input=response.GetResponseStream())using(var output=new MemoryStream()){var block=new byte[4096];int n;while((n=input.Read(block,0,block.Length))!=0){Check();if(output.Length+n>262144)throw new InvalidOperationException("Observation response bound");output.Write(block,0,n);}Check();return DiagnosticObservationCollector.Object(json.DeserializeObject(new UTF8Encoding(false,true).GetString(output.ToArray())));}
   }}finally{request.Abort();}
  }
  public void Dispose(){foreach(var h in held)h.Dispose();}
 }
}
