// Native start transaction, compiled into the worker only. The installed
// definition-only lease does NOT implement INativeRpcStartRuntime and its
// protected journal rejects every native-start record. No entrypoint opts in.
using System;
using System.Collections.Generic;
using System.Management;
namespace Enclave.OwnedRpc {
 public interface INativeRpcStartRuntime:INativeRpcDefinitionRuntime {
  // Trusted OS-bound implementation must hold original controller/worker peers,
  // an independently owned original deadline and a closed one-shot work gate,
  // with VM cleanup armed for this exact original VM BEFORE authorizing start.
  // Return the digest of that immutable lifecycle binding, never a caller bool.
  // Must also revalidate physical admission and protected namespace/asset pins.
  // No production implementation exists yet; definition admission is insufficient.
  string CheckStart(NativeRpcDefinitionPlan plan,string originalVmGuid);
 }
 public interface INativeRpcStartProvider:INativeRpcDeviceProvider {
  StartResponse StartNative(NativeRpcDefinitionPlan plan,string originalVmGuid,string intentHash);
  StartJob ReadJob(string exactReference);
  void RequireRunning(NativeRpcDefinitionPlan plan,string originalVmGuid);
 }
 public static class NativeRpcStart {
  static string H(string x){return NativeRpcDefinitionPlan.Hash(x);}
  static void Current(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,bool mutation){r.Check(p,mutation);if(r.Now<p.Origin||r.Now>=p.Deadline)throw new InvalidOperationException("Native start original deadline");}
  internal static string Authority(NativeRpcDefinitionPlan p,INativeRpcDefinitionRuntime r,string guid){
   Current(p,r,true);var a=r as INativeRpcStartRuntime;if(a==null)throw new InvalidOperationException("Independent native VM lifecycle authority unavailable");
   string digest=a.CheckStart(p,guid);StartIdentity.Hex(digest,64);if(digest==new string('0',64))throw new InvalidOperationException("Empty native lifecycle authority");Current(p,r,true);return digest;
  }
  static string Intent(NativeRpcDefinitionPlan p,IStartJournal j,string authority,out string guid){
   string owned=NativeRpcSecurity.Ownership(p,j,out guid);return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-start-intent/1"},{"plan",p.Digest},{"vmGuid",guid},{"owned",owned},{"security",NativeRpcSecurity.VerifyCompleted(p,j)},{"readGrant",NativeRpcReadGrant.VerifyCompleted(p,j)},{"optical",NativeRpcOptical.VerifyCompleted(p,j)},{"devices",NativeRpcDevicePolicy.VerifyCompleted(p,j)},{"authority",authority},{"requestedState",2}});
  }
  internal static string Prepared(NativeRpcDefinitionPlan p,IStartJournal j,out string guid,out string authority){
   string raw=j.Read("native-start.intent");var d=StartRecords.Parse(raw,new[]{"schema","plan","vmGuid","owned","security","readGrant","optical","devices","authority","requestedState"});
   authority=StartRecords.Text(d["authority"]);StartIdentity.Hex(authority,64);if(authority==new string('0',64)||raw!=Intent(p,j,authority,out guid))throw new InvalidOperationException("Original consumed native start differs");
   return H(raw);
  }
  internal static string Consumed(NativeRpcDefinitionPlan p,IStartJournal j,out string guid,out string authority){
   string hash=Prepared(p,j,out guid,out authority);if(j.Read("native-start.submit")!=hash)throw new InvalidOperationException("Native start submission not consumed");return hash;
  }
  // The independent owner consumes this BEFORE releasing the suspended worker.
  // Submit never prepares missing authority and never resets the original time.
  public static string Prepare(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcStartProvider provider,INativeRpcDefinitionRuntime r){
   string guid;NativeRpcSecurity.Ownership(p,j,out guid);string authority=Authority(p,r,guid);
   long before=r.Now;NativeRpcDevicePolicy.Observe(p,j,provider,r);string intent=Intent(p,j,authority,out guid);
   if(Authority(p,r,guid)!=authority)throw new InvalidOperationException("Lifecycle binding changed");Fresh(r,before);
   j.WriteOnce("native-start.intent",intent);Current(p,r,true);Fresh(r,before);return H(intent);
  }
  public static string Submit(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcStartProvider provider,INativeRpcDefinitionRuntime r){
   string guid,authority,hash=Prepared(p,j,out guid,out authority),intent=j.Read("native-start.intent");
   if(Authority(p,r,guid)!=authority)throw new InvalidOperationException("Prepared lifecycle binding changed");
   long before=r.Now;NativeRpcDevicePolicy.Observe(p,j,provider,r);
   j.WriteOnce("native-start.submit",hash);
   if(Authority(p,r,guid)!=authority)throw new InvalidOperationException("Lifecycle binding changed");Fresh(r,before);
   var response=provider.StartNative(p,guid,H(intent));if(response==null)throw new InvalidOperationException("Native start response lost");
   string reference="";if(response.ReturnCode==4096)reference=HyperVStartProvider.CanonicalJobReference(response.JobReference);else if(!String.IsNullOrEmpty(response.JobReference))throw new InvalidOperationException("Unexpected native start job");
   if(j.Read("native-start.invoke")!=H(intent))throw new InvalidOperationException("Native invocation marker absent");
   // Exact response durable BEFORE any job read, VM readback or acknowledgement.
   j.WriteOnce("native-start.receipt",StartRecords.Encode(new Dictionary<string,object>{{"intent",H(intent)},{"code",response.ReturnCode},{"job",reference}}));
   return Reconcile(p,j,provider,r);
  }
  internal static void Fresh(INativeRpcDefinitionRuntime r,long before){long after=r.Now;if(after<before||after-before>4000)throw new InvalidOperationException("Native start observation stale");}
  static bool Settled(IStartJournal j,string raw,string intent,out string reference){
   var d=StartRecords.Parse(raw,new[]{"intent","code","job"});long code=StartRecords.Number(d["code"]);reference=StartRecords.Text(d["job"]);
   if(StartRecords.Text(d["intent"])!=intent||code<0||code>UInt32.MaxValue||(code!=4096&&reference!=""))throw new InvalidOperationException("Native start response differs");
   if(code==0)return true;if(code!=4096)return false;
   if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Exact returned native start job required");
   string bound=j.Read("native-start.job"),terminal=j.Read("native-start.terminal");if(terminal==null)return false;
   var b=StartRecords.Parse(bound,new[]{"receipt","job","submitted"});string time=StartRecords.Text(b["submitted"]);
   if(StartRecords.Text(b["receipt"])!=H(raw)||StartRecords.Text(b["job"])!=reference||String.IsNullOrEmpty(time)||time.Length>32)throw new InvalidOperationException("Native start job binding differs");
   var t=StartRecords.Parse(terminal,new[]{"receipt","identity","state","runs","error"});long error=StartRecords.Number(t["error"]);
   if(StartRecords.Text(t["receipt"])!=H(raw)||StartRecords.Text(t["identity"])!=H(bound)||StartRecords.Number(t["state"])!=7||StartRecords.Number(t["runs"])!=1||error<0||error>65535)throw new InvalidOperationException("Native start terminal differs");return error==0;
  }
  static string Proof(NativeRpcDefinitionPlan p,IStartJournal j,string guid,string intent,string raw){return StartRecords.Encode(new Dictionary<string,object>{{"schema","native-rpc-start-observed/1"},{"plan",p.Digest},{"vmGuid",guid},{"intent",intent},{"receipt",H(raw)},{"terminal",j.Read("native-start.terminal")==null?"":H(j.Read("native-start.terminal"))},{"enabledState",2},{"memoryMiB",19456},{"rpcReady",false},{"providerOperationFenced",false},{"reservationMayRelease",false}});}
  // Null is held. No prepare, submission, cancellation, broad lookup or retry.
  // This observes under an independently supervised read lease; it does not need
  // permission to submit a new start. Fresh VM state is distinct from job success.
  public static string Reconcile(NativeRpcDefinitionPlan p,IStartJournal j,INativeRpcStartProvider provider,INativeRpcDefinitionRuntime r){
   Current(p,r,false);string guid,authority,intent=Consumed(p,j,out guid,out authority);
   if(j.Read("native-start.invoke")!=intent)throw new InvalidOperationException("Native invocation unproven");
   string raw=j.Read("native-start.receipt");if(raw==null)return null;
   string reference;bool settled=Settled(j,raw,intent,out reference);
   while(!settled&&reference!=""&&j.Read("native-start.terminal")==null){
    Current(p,r,false);var job=provider.ReadJob(reference);Current(p,r,false);
    if(job==null||job.Reference!=reference||HyperVStartProvider.ReferenceForId(job.InstanceId)!=reference||String.IsNullOrEmpty(job.TimeSubmitted)||job.TimeSubmitted.Length>32)throw new InvalidOperationException("Exact start job unavailable");
    string bound=StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"job",reference},{"submitted",job.TimeSubmitted}}),prior=j.Read("native-start.job");
    if(prior==null)j.WriteOnce("native-start.job",bound);else if(prior!=bound)throw new InvalidOperationException("Native start job incarnation changed");
    if(job.State!=7||job.RunTimes!=1){if(NativeRpcJobProgress.Wait(p,r,job))continue;return null;}
    j.WriteOnce("native-start.terminal",StartRecords.Encode(new Dictionary<string,object>{{"receipt",H(raw)},{"identity",H(bound)},{"state",7},{"runs",1},{"error",job.ErrorCode}}));settled=Settled(j,raw,intent,out reference);
   }
   if(!settled)return null;
   Current(p,r,false);long before=r.Now;provider.RequireRunning(p,guid);Current(p,r,false);Fresh(r,before);
   string proof=Proof(p,j,guid,intent,raw),saved=j.Read("native-start.observed");if(saved==null)j.WriteOnce("native-start.observed",proof);else if(saved!=proof)throw new InvalidOperationException("Native start proof changed");Current(p,r,false);Fresh(r,before);return H(proof);
  }
  // Historical receipt authentication only, never RPC readiness or a fresh VM
  // observation. A running VM may stop immediately after a successful readback.
  internal static string VerifyCompleted(NativeRpcDefinitionPlan p,IStartJournal j){
   string guid,authority,intent=Consumed(p,j,out guid,out authority),reference,raw=j.Read("native-start.receipt");
   if(j.Read("native-start.invoke")!=intent||raw==null||!Settled(j,raw,intent,out reference))throw new InvalidOperationException("Native start not settled");
   string proof=Proof(p,j,guid,intent,raw);if(j.Read("native-start.observed")!=proof)throw new InvalidOperationException("Native running readback absent");return H(proof);
  }
 }
}
