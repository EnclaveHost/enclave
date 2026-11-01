// Separate SYSTEM lifecycle entrypoint. Caller prepares/pins contract, entry.exe
// and worker.exe before scheduling this one-shot process. No implicit activation.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  internal string PinNativeStartMessage(string path,string name){if(LeaseProfile!="native-lifecycle-journal"||name!="child.binding")throw new InvalidOperationException("Fixed held start binding required");return Utf8.GetString(Bytes(HoldRead(Path.Combine(Path.GetDirectoryName(path),name),4096),4096));}
 }
 internal sealed class NativeLifecycleGroup:IDisposable {
  internal readonly NativeLifecyclePeer[] Peers;internal readonly string Record;
  internal NativeLifecycleGroup(ProtectedAttempt pin,string registration){
   var d=StartRecords.Parse(registration,new[]{"plan","contractPath","contractHash"});var p=pin.NativeDefinitionPlan;
   string path=StartRecords.Text(d["contractPath"]),hash=StartRecords.Text(d["contractHash"]);if(StartRecords.Text(d["plan"])!=p.Digest)throw new InvalidOperationException("Foreign start registration");
   string token=pin.PinNativeStartGroup(path,hash),image=Path.Combine(Path.GetDirectoryName(path),"entry.exe");var peers=new List<NativeLifecyclePeer>();
   try{foreach(string role in new[]{"owner","observer"})peers.Add(new NativeLifecyclePeer(pin.PinNativeStartPeer(path,role),token,role,image,1));
    var f=pin.PinNativeStartMessage(path,"child.binding").Split(',');if(f.Length!=5||f[3]!=token||Int64.Parse(f[4],NumberStyles.None,CultureInfo.InvariantCulture)>p.Deadline)throw new InvalidOperationException("Original suspended child binding differs");
    string child=f[1]+","+f[2]+","+token+",child";peers.Add(new NativeLifecyclePeer(child,token,"child",image,1));
    var ids=new HashSet<string>();foreach(var peer in peers)if(!ids.Add(peer.Identity.Split(',')[0]))throw new InvalidOperationException("Distinct original peers required");
    var j=new NativeRpcCleanupJournal(pin);string guid,authority,intent=NativeRpcStart.Prepared(p,j,out guid,out authority);
    Record=StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-start-workers/1"},{"plan",p.Digest},{"intent",intent},{"contractPath",path},{"contractHash",hash},{"owner",peers[0].Identity},{"observer",peers[1].Identity},{"child",child}});Peers=peers.ToArray();
   }catch{foreach(var peer in peers)peer.Dispose();throw;}
  }
  internal bool Failed(){// A successful short owner may exit while the VM runs until original D.
   if(!Peers[0].Alive)return Peers[0].ExitCode!=0;
   return !Peers[1].Alive; // observer loss while owner is active closes work
  }
  internal void StopAndObserve(long deadline){foreach(var p in Peers)p.Stop();foreach(var p in Peers)while(p.Alive){if(BoundedWorker.MonotonicMilliseconds()>=deadline)throw new InvalidOperationException("Exact original peer death unconfirmed");Thread.Sleep(5);}}
  public void Dispose(){foreach(var p in Peers)p.Dispose();}
 }
 internal static class NativeLifecycleDispatch {
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  static string Quote(string s){if(s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Native lifecycle argument");return "\""+s+"\"";}
  internal static string Cleanup(ProtectedAttempt lifecycle,ProtectedAttempt pin,NativeLifecycleGroup group,byte[] worker,string reason){
   var p=pin.NativeDefinitionPlan;long now=BoundedWorker.MonotonicMilliseconds(),end=Math.Min(p.Deadline+29000,now+20000);
   Action check=delegate{lifecycle.CheckDeadline();if(BoundedWorker.MonotonicMilliseconds()>=end)throw new InvalidOperationException("Original cleanup dispatch expired");};check();
   if(group==null){pin.WriteOnce("native-lifecycle.result","no-bound-start-group;held;reservation-release=false");return null;}
   string nonce=Guid.NewGuid().ToString("N"),root=Path.Combine(lifecycle.Root,nonce),image=Path.Combine(root,"entry.exe"),contract=Path.Combine(root,"contract.txt");
   string claim=StartRecords.Encode(new Dictionary<string,object>{{"plan",p.Digest},{"root",root},{"origin",now},{"deadline",end},{"reason",reason},{"workers",NativeRpcDefinitionPlan.Hash(group.Record)}});
   // Each keeper has one local dispatch intent. Neither can consume the
   // common provider claim before independent cleanup children are running.
   pin.WriteOnce(lifecycle.Operation=="watch-backup"?"native-lifecycle.backup-dispatch":"native-lifecycle.dispatch",claim);
   // Both may stop the same preheld exact group. No new cleanup processes are
   // created until those originals are observed dead; admission budgets two
   // concurrent cleanup groups. Child-side exclusive claim chooses one submitter.
   group.StopAndObserve(Math.Min(end,now+3000));check();
   using(var files=new NativeControllerFiles(check)){
    files.NewDirectory(root);files.Publish(image,worker);string raw=String.Join("\n",new[]{"owned-native-rpc-cleanup-worker-v1",nonce,p.Boot,now.ToString(CultureInfo.InvariantCulture),end.ToString(CultureInfo.InvariantCulture),p.WorkerImageHash,"stop",Path.Combine(p.Root,"native-definition-plan.txt"),p.Digest,""});string hash=NativeRpcDefinitionPlan.Hash(raw);files.Publish(contract,Encoding.UTF8.GetBytes(raw));
    using(var lease=ProtectedAttempt.OpenNativeCleanupWorker(contract,hash)){
     dynamic service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));service.Connect();dynamic folder=service.GetFolder("\\");var tasks=new Dictionary<string,string>();var peers=new List<NativeLifecyclePeer>();
     try{
      foreach(string role in new[]{"owner","observer"}){check();if(BoundedWorker.MonotonicMilliseconds()-now>=5000)throw new InvalidOperationException("Original cleanup bootstrap cutoff");string name="EnclaveNativeRpcCleanup-"+nonce+"-"+role,args="cleanup-"+role+" "+Quote(contract)+" "+hash+" "+now+" "+end;tasks.Add(name,args);
       dynamic task=service.NewTask(0);task.RegistrationInfo.Description="One-shot original native VM cleanup; no start or release";task.Principal.UserId="SYSTEM";task.Principal.LogonType=5;task.Principal.RunLevel=1;task.Settings.Enabled=true;task.Settings.AllowDemandStart=true;task.Settings.StartWhenAvailable=false;task.Settings.ExecutionTimeLimit="PT30S";task.Settings.MultipleInstances=2;task.Settings.DisallowStartIfOnBatteries=false;task.Settings.StopIfGoingOnBatteries=false;
       dynamic action=task.Actions.Create(0);action.Path=image;action.WorkingDirectory=root;action.Arguments=args;dynamic registered=folder.RegisterTaskDefinition(name,task,2,"SYSTEM",null,5,null);registered.Run(null);
      }
      foreach(string role in new[]{"owner","observer"}){while(!File.Exists(Path.Combine(root,role+".consumed"))){check();Thread.Sleep(5);}peers.Add(new NativeLifecyclePeer(lease.ReadOnce(role+".consumed"),lease.Token,role,image,role=="owner"?0x40U:0U));}
      var handles=new List<string>{lease.Token};foreach(var original in group.Peers){IntPtr remote;if(!DuplicateHandle(GetCurrentProcess(),original.Handle.DangerousGetHandle(),peers[0].Handle.DangerousGetHandle(),out remote,0x1000|0x100000,false,0))throw new Win32Exception(Marshal.GetLastWin32Error());handles.Add(remote.ToInt64().ToString(CultureInfo.InvariantCulture));}
      lease.WriteOnce("cleanup.handles",String.Join(",",handles));check();lease.WriteOnce("admit",lease.Token);
      foreach(var peer in peers){while(peer.Alive){check();Thread.Sleep(5);}if(peer.ExitCode!=0)throw new InvalidOperationException("Original cleanup worker failed");}
      if(lease.ReadOnce("owner.result")!="native-cleanup-observed;provider-fenced=false;reservation-release=false"||lease.ReadOnce("observer.result")!="exact-owner-death;job-empty;provider-fenced=false;reservation-release=false")throw new InvalidOperationException("Original cleanup role receipts absent");
      var result=StartRecords.Parse(lease.ReadOnce("child.result"),new[]{"schema","plan","state","receipt","providerOperationFenced","reservationMayRelease"});
      if(StartRecords.Text(result["schema"])!="native-rpc-cleanup-worker-result/1"||StartRecords.Text(result["plan"])!=p.Digest||StartRecords.Text(result["state"])!="original-off-zero-observed"||!(result["providerOperationFenced"] is bool)||(bool)result["providerOperationFenced"]||!(result["reservationMayRelease"] is bool)||(bool)result["reservationMayRelease"])throw new InvalidOperationException("Original cleanup result remains held");
      string receipt=StartRecords.Text(result["receipt"]);StartIdentity.Hex(receipt,64);pin.WriteOnce("native-lifecycle.result",lease.ReadOnce("child.result"));
      foreach(var pair in tasks){dynamic task=folder.GetTask(pair.Key),d=task.Definition,a=d.Actions.Item(1);string user=d.Principal.UserId;if(d.Actions.Count!=1||(user!="SYSTEM"&&user!="S-1-5-18")||d.Principal.LogonType!=5||a.Path!=image||a.WorkingDirectory!=root||a.Arguments!=pair.Value)throw new InvalidOperationException("Exact cleanup task association differs");task.Enabled=false;folder.DeleteTask(pair.Key,0);}return receipt;
     }finally{foreach(var peer in peers)peer.Dispose();}// uncertain tasks retain one-shot contract/native deadline, never resubmitted
    }
   }
  }
 }
 public static class NativeRpcLifecycleEntry {
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
  static NativeLifecycleGroup group;static NativeLifecyclePeer other;static readonly object gate=new object();static string receipt;
  public static int Main(string[] args){try{
   if(args.Length!=4)return 64;long origin=Int64.Parse(args[2],NumberStyles.None,CultureInfo.InvariantCulture),end=Int64.Parse(args[3],NumberStyles.None,CultureInfo.InvariantCulture),now=BoundedWorker.MonotonicMilliseconds();
   if(origin<0||origin>Int64.MaxValue-930000||origin>now||now-origin>=5000||end<=now||end-origin>930000)throw new InvalidOperationException("Original lifecycle CLI time invalid");
   var deadline=new Timer(delegate{TerminateProcess(GetCurrentProcess(),127);},null,(int)(end-now),Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireSystem();
   using(var lease=ProtectedAttempt.OpenNativeLifecycle(args[0],args[1]))using(var pin=ProtectedAttempt.OpenNativeLifecycleJournal(lease.PermitPath,lease.PermitHash,lease))using(var watchPin=ProtectedAttempt.OpenNativeLifecycleJournal(lease.PermitPath,lease.PermitHash,lease)){
    if(lease.Origin!=origin||lease.Deadline!=end)throw new InvalidOperationException("Original lifecycle CLI differs");var p=pin.NativeDefinitionPlan;
    using(var self=Process.GetCurrentProcess())if(!String.Equals(self.MainModule.FileName,lease.Executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Original lifecycle image path differs");
    byte[] worker;using(var files=new NativeControllerFiles(lease.CheckDeadline))worker=files.Read(Path.Combine(lease.Root,"worker.exe"),262144,p.WorkerImageHash);
    bool backup=lease.Operation=="watch-backup";
    var watch=new NativeLifecycleWatch(p.Origin,p.Deadline,BoundedWorker.MonotonicMilliseconds,delegate{lock(gate){return (other!=null&&!other.Alive)||(group!=null&&group.Failed());}},delegate(string reason){NativeLifecycleGroup held;lock(gate){held=group;}receipt=NativeLifecycleDispatch.Cleanup(lease,watchPin,held,worker,reason);});
    Exception bindingFailure=null;try{
    string identity;using(var self=Process.GetCurrentProcess())identity=self.Id+","+self.StartTime.ToUniversalTime().ToFileTimeUtc()+","+lease.Token+(backup?",lifecycle-backup":",lifecycle");
    pin.WriteOnce(NativeLifecycleBinding.Key(backup,false),StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-lifecycle-armed/1"},{"plan",p.Digest},{"contract",args[0]},{"hash",args[1]},{"identity",identity}}));
    var journal=new NativeRpcCleanupJournal(pin);string registration=null;
    while(journal.Read(NativeLifecycleBinding.Key(!backup,false))==null){if(watch.Done.WaitOne(5))throw new InvalidOperationException("Peer keeper not armed before original deadline");lease.CheckDeadline();}
    string peerRecord;var peer=NativeLifecycleBinding.Peer(pin,!backup,out peerRecord);if(peer.Identity.Split(',')[0]==identity.Split(',')[0]){peer.Dispose();throw new InvalidOperationException("Distinct keeper process required");}lock(gate){other=peer;}
    while(!watch.Done.WaitOne(5)&&BoundedWorker.MonotonicMilliseconds()<p.Deadline){registration=journal.Read("native-start.registration");if(registration!=null)break;}
    if(registration!=null){var held=new NativeLifecycleGroup(pin,registration);
     // Both keepers acquire their own exact handles while child is suspended.
     lock(gate){if(watch.Done.WaitOne(0)||BoundedWorker.MonotonicMilliseconds()>=p.Deadline){held.Dispose();throw new InvalidOperationException("Original lifecycle binding late");}group=held;}
     if(!backup)pin.WriteOnce("native-start.workers",held.Record);
     else{string saved;while((saved=journal.Read("native-start.workers"))==null){if(watch.Done.WaitOne(5))throw new InvalidOperationException("Original group not published");lease.CheckDeadline();}if(saved!=held.Record)throw new InvalidOperationException("Keeper original group differs");}
     pin.WriteOnce(NativeLifecycleBinding.Key(backup,true),NativeRpcDefinitionPlan.Hash(held.Record));
    }
    }catch(Exception e){bindingFailure=e;watch.Abort();}
    while(!watch.Done.WaitOne(10))lease.CheckDeadline();if(bindingFailure!=null)throw new InvalidOperationException("Original lifecycle binding failed after cleanup dispatch",bindingFailure);if(watch.Failure!=null)throw new InvalidOperationException("Independent cleanup held",watch.Failure);GC.KeepAlive(deadline);return receipt==null?2:0;
   }
  }catch(Exception e){Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1;}}
 }
}
