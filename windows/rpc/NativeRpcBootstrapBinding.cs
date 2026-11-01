// Native host bootstrap consumes original owned/start evidence, never a caller's
// receipt hash alone. This reader grants no provider or original-journal writes.
using System;using System.Collections.Generic;using System.Globalization;using System.IO;using System.Text;
namespace Enclave.OwnedRpc {
 public sealed partial class ProtectedAttempt {
  internal static ProtectedAttempt OpenNativeBootstrapJournal(ProtectedAttempt lease,string[] fields){RequireSystem();return new ProtectedAttempt(lease,fields,false);}
  internal static ProtectedAttempt PinNativeBootstrapJournalController(ProtectedAttempt lease,string[] fields){RequireAdministrator();return new ProtectedAttempt(lease,fields,true);}
  private ProtectedAttempt(ProtectedAttempt lease,string[] fields,bool controller){
   NativeBootstrapBinding.Shape(fields);if(lease==null||lease.accessLease!=null||lease.LeaseProfile!="host-bootstrap")throw new ArgumentException("Original bootstrap lease required");
   lease.CheckDeadline();byte[] bootstrap=lease.BootstrapRead(lease.PermitPath,131072,lease.PermitHash);
   if(Utf8.GetString(bootstrap)!=String.Join("\n",fields))throw new InvalidOperationException("Bootstrap plan differs from immutable lease");
   string path=LocalPath(fields[15]);Hex(fields[16],64);if(Path.GetFileName(path)!="native-definition-plan.txt")throw new ArgumentException("Original native plan required");
   Root=Path.GetDirectoryName(path);ContractHash=fields[16];recordOwner=controller?AdminSid:SystemSid;accessLease=lease;evidenceOnly=true;LeaseProfile="native-bootstrap-journal";
   try{
    string current=Path.GetPathRoot(Root);HoldDirectory(current,false);string[] parts=Root.Substring(3).Split('\\');for(int n=0;n<parts.Length;n++){current=Path.Combine(current,parts[n]);HoldDirectory(current,n==parts.Length-1);}
    byte[] raw=Bytes(HoldRead(path,4096),4096);if(Hash(raw)!=ContractHash)throw new InvalidOperationException("Original native plan changed");NativeDefinitionPlan=NativeRpcDefinitionPlan.Parse(Utf8.GetString(raw));var p=NativeDefinitionPlan;
    Nonce=p.Attempt;Boot=p.Boot;Origin=p.Origin;Deadline=p.Deadline;ExecutableHash=p.WorkerImageHash;
    if(p.Root!=Root||Root==lease.Root||Path.GetFileName(Root)!=Nonce||Boot!=lease.Boot||Boot!=CurrentBoot()||lease.Origin<Origin||lease.Deadline>Deadline||fields[2]!=Origin.ToString(CultureInfo.InvariantCulture)||fields[3]!=Deadline.ToString(CultureInfo.InvariantCulture))throw new InvalidOperationException("Bootstrap reset original native attempt or clock");
    CheckDeadline();
   }catch{Dispose();throw;}
  }
  internal void VerifyNativeBootstrapInputs(string[] fields){
   if(LeaseProfile!="native-bootstrap-journal")throw new InvalidOperationException("Read-only bootstrap evidence required");CheckDeadline();
   var p=NativeDefinitionPlan;byte[] record=Bytes(HoldRead(Path.Combine(Root,"record.json"),65536),65536),bundle=Bytes(HoldRead(Path.Combine(Root,"bundle.bin"),9*1048576),9*1048576);
   NativeBootstrapBinding.Inputs(p,fields,record,bundle);CheckDeadline();
  }
 }
 internal static class NativeBootstrapBinding {
  internal static void Shape(string[] f){
   if(f==null||f.Length!=19||f[0]!="owned-rpc-host-plan-v2"||f[18]!="")throw new InvalidOperationException("Original native bootstrap plan v2 required");
   foreach(int n in new[]{5,7,9,11,14,16,17}){StartIdentity.Hex(f[n],64);if(f[n]==new string('0',64))throw new ArgumentException("Nonzero original bootstrap digest required");}
   Guid vm;if(!Guid.TryParseExact(f[1],"D",out vm)||vm==Guid.Empty||vm.ToString("D")!=f[1])throw new ArgumentException("Original canonical VM GUID required");ProtectedAttempt.LocalPath(f[15]);
  }
  internal static void Inputs(NativeRpcDefinitionPlan p,string[] f,byte[] record,byte[] bundle){
   Shape(f);if(ProtectedAttempt.Hash(record)!=p.Record||ProtectedAttempt.Hash(bundle)!=p.App)throw new InvalidOperationException("Original bootstrap app bytes differ");
   var expected=StartRecords.Parse(new UTF8Encoding(false,true).GetString(Convert.FromBase64String(f[12])),new[]{"appId","deployment","profile","l1Volume","baseVolume","runtime","manifestSha256","ownerAttempt","ownerKeys"});
   var r=StartRecords.Parse(new UTF8Encoding(false,true).GetString(record),new[]{"derivation","catalog","cid","runtimeId","policy","http","ports","configBase64","secretDeployment","rpc"});var rpc=r["rpc"] as Dictionary<string,object>;
   if(rpc==null||rpc.Count!=4||StartRecords.Text(expected["appId"])!=p.App||StartRecords.Text(expected["deployment"])!=p.Deployment||StartRecords.Text(expected["profile"])!=p.Profile||StartRecords.Text(expected["runtime"])!=p.Runtime||StartRecords.Text(expected["l1Volume"])!=StartRecords.Text(rpc["l1VolumeId"])||StartRecords.Text(expected["baseVolume"])!=StartRecords.Text(rpc["baseVolumeId"])||StartRecords.Text(rpc["profileSha256"])!=p.Profile||StartRecords.Text(r["secretDeployment"])!=p.Deployment||StartRecords.Text(r["runtimeId"])!=p.Runtime)throw new InvalidOperationException("Original native deployment or volumes differ");
   foreach(string n in new[]{"l1Volume","baseVolume","manifestSha256"}){string h=StartRecords.Text(expected[n]);StartIdentity.Hex(h,64);if(h==new string('0',64))throw new ArgumentException("Original nonzero bootstrap identity required");}
   string attempt=StartRecords.Text(expected["ownerAttempt"]);StartIdentity.Hex(attempt,32);if(attempt==new string('0',32))throw new ArgumentException("Original owner attempt required");
   var keys=expected["ownerKeys"] as System.Collections.IList;if(keys==null||keys.Count!=2)throw new ArgumentException("Both original owner pins required");foreach(object key in keys){string h=StartRecords.Text(key);StartIdentity.Hex(h,64);if(h==new string('0',64))throw new ArgumentException("Original owner pin required");}
   byte[] magic=Encoding.ASCII.GetBytes("ENCLAVE-BUNDLE/1\n");if(bundle.Length<magic.Length+8)throw new InvalidOperationException("Original app bundle truncated");for(int i=0;i<magic.Length;i++)if(bundle[i]!=magic[i])throw new InvalidOperationException("Original bundle envelope differs");int at=magic.Length;
   uint size=(uint)(bundle[at]|bundle[at+1]<<8|bundle[at+2]<<16|bundle[at+3]<<24);if(size==0||size>65536||size>bundle.Length-at-8)throw new InvalidOperationException("Original manifest bound");byte[] manifest=new byte[(int)size];Buffer.BlockCopy(bundle,at+4,manifest,0,manifest.Length);
   if(ProtectedAttempt.Hash(manifest)!=StartRecords.Text(expected["manifestSha256"]))throw new InvalidOperationException("Original bundle manifest differs");
  }
  internal static void Proof(NativeRpcDefinitionPlan p,IStartJournal journal,string[] f){
   Shape(f);string vm;string owned=NativeRpcSecurity.Ownership(p,journal,out vm);
   if(f[1]!=vm||f[14]!=owned||f[16]!=p.Digest||f[15]!=Path.Combine(p.Root,"native-definition-plan.txt")||f[17]!=NativeRpcStart.VerifyCompleted(p,journal))throw new InvalidOperationException("Original native ownership/start receipt differs");
   string primary=journal.Read(NativeLifecycleBinding.Key(false,false)),backup=journal.Read(NativeLifecycleBinding.Key(true,false));
   string authority;string intent=NativeRpcStart.Prepared(p,journal,out vm,out authority);
   if(primary==null||backup==null||NativeRpcDefinitionPlan.Hash(primary+"\n"+backup)!=authority)throw new InvalidOperationException("Original start keeper pair differs");
   string workers=journal.Read("native-start.workers");var group=StartRecords.Parse(workers,new[]{"schema","plan","intent","contractPath","contractHash","owner","observer","child"});
   if(StartRecords.Text(group["schema"])!="native-rpc-start-workers/1"||StartRecords.Text(group["plan"])!=p.Digest||StartRecords.Text(group["intent"])!=intent||!NativeLifecycleBinding.Bound(journal,workers))throw new InvalidOperationException("Original start group not held by both keepers");
   // Once either keeper dispatches cleanup, bootstrap may not revive serving.
   foreach(string name in new[]{"native-lifecycle.dispatch","native-lifecycle.backup-dispatch","native-lifecycle.stop","native-stop.intent"})if(journal.Read(name)!=null)throw new InvalidOperationException("Original lifecycle already closing");
  }
 }
#if !NATIVE_RPC_BOOTSTRAP_CONTROLLER
 internal sealed class NativeBootstrapContext:IDisposable {
  readonly ProtectedAttempt pin;readonly NativeLifecyclePeer primary,backup;readonly string[] fields;readonly Action outer;readonly object gate=new object();
  internal NativeBootstrapContext(ProtectedAttempt lease,string[] fields,Action outer){
   ProtectedAttempt.RequireSystem();if(outer==null)throw new ArgumentNullException("outer");this.outer=outer;this.fields=(string[])fields.Clone();outer();pin=ProtectedAttempt.OpenNativeBootstrapJournal(lease,fields);
   try{pin.VerifyNativeBootstrapInputs(fields);NativeBootstrapBinding.Proof(pin.NativeDefinitionPlan,new NativeRpcCleanupJournal(pin),fields);string first,second;primary=NativeLifecycleBinding.Peer(pin,false,out first);backup=NativeLifecycleBinding.Peer(pin,true,out second);if(primary.Identity.Split(',')[0]==backup.Identity.Split(',')[0])throw new InvalidOperationException("Distinct original keepers required");Check();}catch{Dispose();throw;}
  }
  internal void Check(){lock(gate){outer();pin.CheckDeadline();if(!primary.Alive||!backup.Alive)throw new InvalidOperationException("Original bootstrap lifecycle owner lost");
   // Immutable proof records are already held read-only. Only absence of new
   // cleanup intent must be reobserved; serialize access across native pumps.
   var journal=new NativeRpcCleanupJournal(pin);foreach(string n in new[]{"native-lifecycle.dispatch","native-lifecycle.backup-dispatch","native-lifecycle.stop","native-stop.intent"})if(journal.Read(n)!=null)throw new InvalidOperationException("Original lifecycle closing");outer();}}
  public void Dispose(){if(backup!=null)backup.Dispose();if(primary!=null)primary.Dispose();if(pin!=null)pin.Dispose();}
 }
#endif
}
