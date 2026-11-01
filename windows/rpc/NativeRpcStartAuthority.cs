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
 internal sealed class NativeRpcStartRuntime:INativeRpcStartRuntime,INativeRpcObservationWait,IDisposable {
  readonly ProtectedAttempt lease,pin;readonly Action guard;readonly NativeLifecyclePeer keeper,backup;readonly string binding;LegacyHandoff.Completion completion;bool pinned;
  internal NativeRpcStartRuntime(ProtectedAttempt lease,ProtectedAttempt pin,Action guard){
   if(lease==null||pin==null||guard==null||lease.LeaseProfile!="native-start"||pin.LeaseProfile!="native-start-journal")throw new ArgumentException("Explicit native start custody required");this.lease=lease;this.pin=pin;this.guard=guard;
   string first,second;keeper=NativeLifecycleBinding.Peer(pin,false,out first);
   try{backup=NativeLifecycleBinding.Peer(pin,true,out second);if(keeper.Identity.Split(',')[0]==backup.Identity.Split(',')[0])throw new InvalidOperationException("Distinct lifecycle processes required");binding=NativeRpcDefinitionPlan.Hash(first+"\n"+second);}catch{keeper.Dispose();if(backup!=null)backup.Dispose();throw;}
  }
  public long Now{get{return BoundedWorker.MonotonicMilliseconds();}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){
   ProtectedAttempt.RequireSystem();guard();lease.CheckDeadline();pin.CheckDeadline();if(p==null||p.Encode()!=pin.NativeDefinitionPlan.Encode()||lease.PermitHash!=p.Digest||p.Boot!=ProtectedAttempt.CurrentBoot()||!keeper.Alive||!backup.Alive||Now<p.Origin||Now>=p.Deadline)throw new InvalidOperationException("Original native lifecycle authority expired");
   if(mutation){if(!pinned){pin.PinNativeAsset("runtime.igvm",p.FirmwareHash,Int32.MaxValue,false);pin.PinNativeAsset("guest-state.vmgs",p.StateHash,64*1024*1024,true);pin.PinNativeAsset("bundle.bin",p.App,9*1024*1024,false);pin.PinNativeAsset("record.json",p.Record,65536,false);pin.PinNativeAsset("profile.json",p.Profile,65536,false);pin.PinNativeMedia();pinned=true;}WindowsStartAdmission.VerifyNativeDefinition(pin,lease,ref completion);}
   if(pinned)pin.ObserveNativeState();
   guard();lease.CheckDeadline();if(!keeper.Alive||!backup.Alive)throw new InvalidOperationException("Independent lifecycle owner lost");
  }
  public string CheckStart(NativeRpcDefinitionPlan p,string guid){Check(p,true);var j=new NativeRpcCleanupJournal(pin);string original;NativeRpcSecurity.Ownership(p,j,out original);if(original!=guid)throw new InvalidOperationException("Original lifecycle VM differs");
   if(j.Read("native-start.submit")!=null){string raw=j.Read("native-start.workers");var d=StartRecords.Parse(raw,new[]{"schema","plan","intent","contractPath","contractHash","owner","observer","child"});string authority;string intent=NativeRpcStart.Prepared(p,j,out original,out authority);
    if(StartRecords.Text(d["schema"])!="native-rpc-start-workers/1"||StartRecords.Text(d["plan"])!=p.Digest||StartRecords.Text(d["intent"])!=intent||StartRecords.Text(d["contractPath"])!=Path.Combine(lease.Root,"contract.txt")||StartRecords.Text(d["contractHash"])!=lease.ContractHash||!NativeLifecycleBinding.Bound(j,raw))throw new InvalidOperationException("Original child not held by independent lifecycle owner");}
   return binding;
  }
  public bool WaitForNextObservation(NativeRpcDefinitionPlan p){Check(p,false);if(Math.Min(p.Deadline,lease.Deadline)-Now<=25)return false;Thread.Sleep(25);Check(p,false);return true;}
  public void Dispose(){keeper.Dispose();backup.Dispose();if(completion!=null)completion.Dispose();}
 }
}
