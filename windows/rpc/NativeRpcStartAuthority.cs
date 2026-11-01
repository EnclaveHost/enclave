// Independent SYSTEM lifecycle process. No VM start, adoption or resource release.
// A start owner cannot release its child until this process holds all exact peers.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  internal string PinLifecycleEvidence(string path,string hash){
   if(LeaseProfile!="native-start-journal")throw new InvalidOperationException("Original start custody required");CheckDeadline();LocalPath(path);Hex(hash,64);
   if(Path.GetFileName(path)!="contract.txt")throw new InvalidOperationException("Fixed lifecycle contract");string root=Path.GetDirectoryName(path),current=Path.GetPathRoot(root);HoldDirectory(current,false);
   foreach(string part in root.Substring(3).Split('\\')){current=Path.Combine(current,part);HoldDirectory(current,current==root);}
   byte[] raw=Bytes(HoldRead(path,2048),2048);if(Hash(raw)!=hash)throw new InvalidOperationException("Lifecycle contract changed");var f=Utf8.GetString(raw).Split('\n');var p=NativeDefinitionPlan;
   if(f.Length!=10||f[0]!="owned-native-rpc-lifecycle-v1"||f[6]!="watch"||f[7]!=Path.Combine(Root,"native-definition-plan.txt")||f[8]!=ContractHash||f[9]!="")throw new InvalidOperationException("Original lifecycle binding differs");
   Hex(f[1],32);Hex(f[2],32);Hex(f[5],64);long origin=Int64.Parse(f[3],NumberStyles.None,CultureInfo.InvariantCulture),end=Int64.Parse(f[4],NumberStyles.None,CultureInfo.InvariantCulture);
   if(Path.GetFileName(root)!=f[1]||root==Root||f[2]!=p.Boot||origin<p.Origin||origin>=p.Deadline||p.Deadline>Int64.MaxValue-30000||end!=p.Deadline+30000||origin>BoundedWorker.MonotonicMilliseconds())throw new InvalidOperationException("Lifecycle original window differs");
   if(Hash(Bytes(HoldRead(Path.Combine(root,"entry.exe"),262144),262144))!=f[5])throw new InvalidOperationException("Lifecycle image changed");CheckDeadline();return f[1]+f[2]+hash;
  }
 }
 internal sealed class NativeRpcStartRuntime:INativeRpcStartRuntime,INativeRpcObservationWait,IDisposable {
  readonly ProtectedAttempt lease,pin;readonly Action guard;readonly NativeLifecyclePeer keeper;readonly string binding;LegacyHandoff.Completion completion;bool pinned;
  internal NativeRpcStartRuntime(ProtectedAttempt lease,ProtectedAttempt pin,Action guard){
   if(lease==null||pin==null||guard==null||lease.LeaseProfile!="native-start"||pin.LeaseProfile!="native-start-journal")throw new ArgumentException("Explicit native start custody required");this.lease=lease;this.pin=pin;this.guard=guard;
   string raw=new NativeRpcCleanupJournal(pin).Read("native-lifecycle.armed");var d=StartRecords.Parse(raw,new[]{"schema","plan","contract","hash","identity"});
   if(StartRecords.Text(d["schema"])!="native-rpc-lifecycle-armed/1"||StartRecords.Text(d["plan"])!=pin.ContractHash)throw new InvalidOperationException("Original lifecycle arming absent");string path=StartRecords.Text(d["contract"]),hash=StartRecords.Text(d["hash"]),token=pin.PinLifecycleEvidence(path,hash);
   keeper=new NativeLifecyclePeer(StartRecords.Text(d["identity"]),token,"lifecycle",Path.Combine(Path.GetDirectoryName(path),"entry.exe"),0);binding=NativeRpcDefinitionPlan.Hash(raw);
  }
  public long Now{get{return BoundedWorker.MonotonicMilliseconds();}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){
   ProtectedAttempt.RequireSystem();guard();lease.CheckDeadline();pin.CheckDeadline();if(p==null||p.Encode()!=pin.NativeDefinitionPlan.Encode()||lease.PermitHash!=p.Digest||p.Boot!=ProtectedAttempt.CurrentBoot()||!keeper.Alive||Now<p.Origin||Now>=p.Deadline)throw new InvalidOperationException("Original native lifecycle authority expired");
   if(mutation){if(!pinned){pin.PinNativeAsset("runtime.igvm",p.FirmwareHash,Int32.MaxValue,false);pin.PinNativeAsset("guest-state.vmgs",p.StateHash,64*1024*1024,true);pin.PinNativeAsset("bundle.bin",p.App,9*1024*1024,false);pin.PinNativeAsset("record.json",p.Record,65536,false);pin.PinNativeAsset("profile.json",p.Profile,65536,false);pin.PinNativeMedia();pinned=true;}WindowsStartAdmission.VerifyNativeDefinition(pin,lease,ref completion);}
   if(pinned)pin.ObserveNativeState();
   guard();lease.CheckDeadline();if(!keeper.Alive)throw new InvalidOperationException("Independent lifecycle owner lost");
  }
  public string CheckStart(NativeRpcDefinitionPlan p,string guid){Check(p,true);var j=new NativeRpcCleanupJournal(pin);string original;NativeRpcSecurity.Ownership(p,j,out original);if(original!=guid)throw new InvalidOperationException("Original lifecycle VM differs");
   if(j.Read("native-start.submit")!=null){string raw=j.Read("native-start.workers");var d=StartRecords.Parse(raw,new[]{"schema","plan","intent","contractPath","contractHash","owner","observer","child"});string authority;string intent=NativeRpcStart.Prepared(p,j,out original,out authority);
    if(StartRecords.Text(d["schema"])!="native-rpc-start-workers/1"||StartRecords.Text(d["plan"])!=p.Digest||StartRecords.Text(d["intent"])!=intent||StartRecords.Text(d["contractPath"])!=Path.Combine(lease.Root,"contract.txt")||StartRecords.Text(d["contractHash"])!=lease.ContractHash||j.Read("native-lifecycle.bound")!=NativeRpcDefinitionPlan.Hash(raw))throw new InvalidOperationException("Original child not held by independent lifecycle owner");}
   return binding;
  }
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){Check(p,false);if(Math.Min(p.Deadline,lease.Deadline)-Now<=25)return false;Thread.Sleep(25);Check(p,false);return true;}
  public void Dispose(){keeper.Dispose();if(completion!=null)completion.Dispose();}
 }
}
