// Hosted-only whole native bridge fixture. No target mode or VM/TPM interaction.
using System;
using System.Collections.Generic;
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
public static class HostBootstrapQualification {
 static readonly List<IDisposable> held=new List<IDisposable>();
 static readonly List<Process> processes=new List<Process>();
 static readonly Dictionary<string,string> tasks=new Dictionary<string,string>();
 static readonly SecurityIdentifier admin=new SecurityIdentifier("S-1-5-32-544"),system=new SecurityIdentifier("S-1-5-18");
 static readonly List<string> failures=new List<string>();
 static dynamic folder;static string root,entry,token;static long origin,deadline,phaseDeadline;static bool passed;
 static BoundedWorker.OwnerObserver watchdog;static ProtectedAttempt pin;
 static void Current(){if(BoundedWorker.MonotonicMilliseconds()>=deadline)throw new TimeoutException("Fixture original controller deadline");}
 static string Q(string s){if(s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Fixture path");return "\""+s+"\"";}
 static byte[] Read(string path,int max){
  Current();var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);held.Add(f);if(f.Length<1||f.Length>max)throw new IOException("Fixture read bound");
  byte[] b=new byte[(int)f.Length];int at=0;while(at<b.Length){int n=f.Read(b,at,b.Length-at);if(n<=0)throw new IOException("Fixture short read");at+=n;}return b;
 }
 static void DirectoryNew(string path){
  if(Directory.Exists(path)||File.Exists(path))throw new IOException("Fixture namespace consumed");
  var acl=new DirectorySecurity();acl.SetOwner(admin);acl.SetAccessRuleProtection(true,false);
  foreach(var sid in new[]{admin,system})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
  Directory.CreateDirectory(path,acl);
 }
 static void Publish(string path,byte[] data){
  var acl=new FileSecurity();acl.SetOwner(admin);acl.SetAccessRuleProtection(true,false);
  foreach(var sid in new[]{admin,system})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
  using(var f=new FileStream(path+".pending",FileMode.CreateNew,FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,acl)){f.Write(data,0,data.Length);f.Flush(true);}File.Move(path+".pending",path);
 }
 static void Text(string name,string text){Publish(Path.Combine(root,name),Encoding.UTF8.GetBytes(text));}
 static string Wait(string name){string p=Path.Combine(root,name);while(!File.Exists(p)){Current();Thread.Sleep(5);}return Encoding.UTF8.GetString(Read(p,131072));}
 static Process Exact(int pid,long creation,string image){
  var p=Process.GetProcessById(pid);processes.Add(p);IntPtr h=p.Handle;
  if(p.HasExited||p.StartTime.ToUniversalTime().ToFileTimeUtc()!=creation||!String.Equals(p.MainModule.FileName,image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Fixture exact process identity differs");return p;
 }
 static Process Role(string role){string[] f=Wait(role+".consumed").Split(',');if(f.Length!=4||f[2]!=token||f[3]!=role)throw new InvalidOperationException("Role token differs");return Exact(Int32.Parse(f[0]),Int64.Parse(f[1]),entry);}
 static void Schedule(string role,string arguments){
  Current();if(BoundedWorker.MonotonicMilliseconds()-origin>=5000)throw new TimeoutException("Fixture bootstrap cutoff");
  string name="EnclaveRpcBootstrapCI-"+Path.GetFileName(root)+"-"+role;tasks.Add(name,arguments);
  dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();folder=service.GetFolder("\\");dynamic task=service.NewTask(0);
  task.RegistrationInfo.Description="Finite hosted RPC bootstrap fixture; no VM or TPM";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;
  task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;
  task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
  dynamic action=task.Actions.Create(0);action.Path=entry;action.WorkingDirectory=root;action.Arguments=arguments;
  dynamic registered=folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
 }
 static void Dead(Process p,long by){if(!p.WaitForExit((int)Math.Max(0,by-BoundedWorker.MonotonicMilliseconds())))throw new InvalidOperationException("Exact fixture process death unconfirmed");}
 static void Cleanup(){
  foreach(var pair in tasks)try{
   dynamic task=folder.GetTask(pair.Key),d=task.Definition,a=d.Actions.Item(1);string user=d.Principal.UserId;
   if(d.Actions.Count!=1||(user!="SYSTEM"&&user!="S-1-5-18")||d.Principal.LogonType!=5||a.Path!=entry||a.WorkingDirectory!=root||a.Arguments!=pair.Value)throw new InvalidOperationException("Task association changed");
   task.Enabled=false;task.Stop(0);folder.DeleteTask(pair.Key,0);
  }catch{failures.Add("Exact fixture task cleanup unconfirmed");}
  foreach(var p in processes){try{if(!p.HasExited)failures.Add("Preheld fixture process still alive");}catch{failures.Add("Exact death observation failed");}p.Dispose();}
  if(pin!=null)pin.Dispose();foreach(var h in held)h.Dispose();
 }
 public static int Main(string[] args){
  string mode="";long killedAt=0,allDeadAt=0;int preheld=0;bool nativeExecuted=false;
  try{
   if(args.Length!=9||Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new ArgumentException("Disposable hosted fixture only");
   mode=args[0];if(Array.IndexOf(new[]{"normal","wrong-source","wrong-key","malformed","observer-loss","blocked-tpm","blocked-monitor"},mode)<0)throw new ArgumentException("Fixed case required");
   origin=Int64.Parse(args[7],NumberStyles.None,CultureInfo.InvariantCulture);deadline=Int64.Parse(args[8],NumberStyles.None,CultureInfo.InvariantCulture);
   phaseDeadline=origin+((mode=="blocked-tpm"||mode=="blocked-monitor")?3500:6000);
   if(deadline-origin!=8000)throw new ArgumentException("Original fixture8s window required");
   BoundedWorker.EnterSupervisorEnvelope(128UL*1048576);watchdog=BoundedWorker.ArmOwnerObserver(origin,deadline,args[6]+args[6]+args[6]+args[6]);
   using(var who=WindowsIdentity.GetCurrent())if(who.ImpersonationLevel!=TokenImpersonationLevel.None||!new WindowsPrincipal(who).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("Primary administrator required");
   using(var search=new ManagementObjectSearcher("SELECT FreePhysicalMemory FROM Win32_OperatingSystem"))using(var rows=search.Get()){
    int count=0;foreach(ManagementObject row in rows)using(row){if(++count!=1||Convert.ToInt64(row["FreePhysicalMemory"])*1024<3L*1073741824)throw new InvalidOperationException("Hosted physical headroom");}if(count!=1)throw new InvalidOperationException("Hosted singleton");
   }
   byte[] code=Read(args[1],262144),actor=Read(args[3],262144);
   if(ProtectedAttempt.Hash(code)!=args[2]||ProtectedAttempt.Hash(actor)!=args[4]||args[6].Length!=32)throw new InvalidOperationException("Reviewed fixture binaries differ");
   string parent=Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)),"EnclaveRpcBootstrapCI-"+args[6]);DirectoryNew(parent);root=Path.Combine(parent,args[6]);DirectoryNew(root);
   entry=Path.Combine(root,"entry.exe");Publish(entry,code);Publish(Path.Combine(root,"node.exe"),actor);Publish(Path.Combine(root,"tpm.exe"),actor);
   Text("fixture.mode",mode);byte[] key=Encoding.ASCII.GetBytes("CI_ONLY_NOT_A_PRIVATE_KEY");Publish(Path.Combine(root,"key.txt"),key);
   string src=Path.Combine(root,"source");DirectoryNew(src);var dirs=new HashSet<string>(StringComparer.OrdinalIgnoreCase);dirs.Add(src);var manifest=new StringBuilder();
   foreach(string name in HostBootstrapChannels.SourceNames){
    string destination=Path.Combine(src,name.Replace('/','\\')),dir=Path.GetDirectoryName(destination),current=src;
    foreach(string part in dir.Substring(src.Length+1).Split('\\')){current=Path.Combine(current,part);if(dirs.Add(current))DirectoryNew(current);}
    byte[] bytes=Read(Path.Combine(args[5],name.Replace('/','\\')),262144);Publish(destination,bytes);
    manifest.Append(name+"|"+(mode=="wrong-source"&&name=="rpc/host/bootstrap.mjs"?new string('0',64):ProtectedAttempt.Hash(bytes))+"\n");
   }
   byte[] sourcePins=Encoding.UTF8.GetBytes(manifest.ToString());Publish(Path.Combine(src,"bootstrap-source.txt"),sourcePins);
   string boot=ProtectedAttempt.CurrentBoot();
   string plan="owned-rpc-host-plan-v1\n"+Guid.NewGuid().ToString("D")+"\n"+origin+"\n"+(origin+900000)+"\n"+Path.Combine(root,"node.exe")+"\n"+args[4]+"\n"+Path.Combine(root,"tpm.exe")+"\n"+args[4]+"\n"+Path.Combine(root,"key.txt")+"\n"+(mode=="wrong-key"?new string('0',64):ProtectedAttempt.Hash(key))+"\n"+src+"\n"+ProtectedAttempt.Hash(sourcePins)+"\ne30=\nW10=\n"+new string('1',64)+"\n";
   Text("bootstrap-plan.txt",plan);string contract="owned-rpc-host-bootstrap-v1\n"+args[6]+"\n"+boot+"\n"+origin+"\n"+phaseDeadline+"\n"+args[2]+"\nhost-bootstrap-v1\n"+ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(plan))+"\n";
   Text("contract.txt",contract);string hash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(contract));token=args[6]+boot+hash;
   pin=ProtectedAttempt.PinHostBootstrapController(Path.Combine(root,"contract.txt"),hash);
   string command=Q(Path.Combine(root,"contract.txt"))+" "+hash+" "+origin+" "+phaseDeadline;
   Schedule("owner","owner "+command);Schedule("observer","observer "+command);
   Process owner=Role("owner"),observer=Role("observer");Text("admit",token);
   if(mode=="wrong-source"||mode=="wrong-key"){
    Dead(owner,phaseDeadline+500);Dead(observer,phaseDeadline+500);
    if(owner.ExitCode!=1||observer.ExitCode!=0||File.Exists(Path.Combine(root,"bootstrap.native-intent"))||File.Exists(Path.Combine(root,"bootstrap.children")))throw new InvalidOperationException("Pin failure did not precede channels/children");
    if(Wait("owner.result")!="bootstrap-failed;reservation-release=false"||Wait("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Pin refusal receipts differ");
    preheld=2;allDeadAt=BoundedWorker.MonotonicMilliseconds();passed=true;
   }else{
    Process worker=Role("child");string[] child=Wait("bootstrap.children").Split(',');if(child.Length!=5||child[4]!=token)throw new InvalidOperationException("Bootstrap children binding differs");
    Process tpm=Exact(Int32.Parse(child[0]),Int64.Parse(child[1]),Path.Combine(root,"tpm.exe")),node=Exact(Int32.Parse(child[2]),Int64.Parse(child[3]),Path.Combine(root,"node.exe"));
    preheld=5;nativeExecuted=true;Text("fixture.release",token);
    if(mode=="normal"){
     var enrollment=(Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(Wait("enrollment.json"));
     if((string)enrollment["token"]!=token)throw new InvalidOperationException("Enrollment binding differs");Text("owner-offer.json","{\"fixture\":true}");
    }else if(mode=="observer-loss"){
     Wait("fixture.blocked");killedAt=BoundedWorker.MonotonicMilliseconds();if(phaseDeadline-killedAt<1500)throw new InvalidOperationException("Observer-loss distinction too late");observer.Kill();
    }else if(mode=="blocked-tpm"||mode=="blocked-monitor")Wait("fixture.blocked");
    long by=mode=="observer-loss"?Math.Min(phaseDeadline-500,killedAt+1000):phaseDeadline+750;
    foreach(var p in new[]{owner,observer,worker,node,tpm})Dead(p,by);allDeadAt=BoundedWorker.MonotonicMilliseconds();
    if(mode=="normal"){
     if(owner.ExitCode!=0||observer.ExitCode!=0||Wait("owner.result")!="bootstrap-acquisition-requested;rpc-ready=false;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Native normal sequence refused");
     var result=(Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(Wait("native-result.json"));
     if((string)result["token"]!=token||!(bool)result["acquisitionRequested"]||(bool)result["rpcReady"]||(bool)result["providerOperationFenced"]||(bool)result["reservationMayRelease"])throw new InvalidOperationException("Native result changed meaning");
    }else{
     if(File.Exists(Path.Combine(root,"native-result.json")))throw new InvalidOperationException("Failed case claimed acquisition");
     if(mode=="malformed"&&(owner.ExitCode!=1||observer.ExitCode!=0))throw new InvalidOperationException("Malformed frame did not fail closed");
     if((mode=="blocked-tpm"||mode=="blocked-monitor")&&allDeadAt<phaseDeadline-100)throw new InvalidOperationException("Blocked case failed before original deadline");
    }
    passed=true;
   }
  }catch(Exception error){failures.Add(error.GetType().Name+": "+error.Message);}finally{Cleanup();}
  Console.WriteLine(new JavaScriptSerializer().Serialize(new{mode=mode,passed=passed&&failures.Count==0,origin=origin,deadline=deadline,phaseDeadline=phaseDeadline,elapsedMs=BoundedWorker.MonotonicMilliseconds()-origin,preheldProcesses=preheld,killedAt=killedAt,allDeadAt=allDeadAt,nativeBridgeExecuted=nativeExecuted,hardwareSynthetic=true,nodeActorSynthetic=true,root=root,failures=failures,rpcReady=false,providerOperationFenced=false,reservationMayRelease=false}));
  return passed&&failures.Count==0?0:1;
 }
}
