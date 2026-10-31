// Transaction/recipe fixtures only. No native Hyper-V mutation is performed.
using System;
using System.Collections.Generic;
using System.IO;
using Enclave.OwnedRpc;
public static class OwnedVmBootHarness {
 static int count;
 static void Check(bool b){if(!b)throw new Exception("Boot assertion failed");}
 static void Refuse(Action a){bool refused=false;try{a();}catch{refused=true;}Check(refused);}
 static void Test(string n,Action a){a();count++;Console.WriteLine("PASS boot-"+n);}
 static OwnedVmBootPlan Plan(){string n=new string('a',32);return new OwnedVmBootPlan(new OwnedVmDefinitionPlan(n,new string('b',32),new string('c',64),new string('d',64),@"C:\owned\"+n,1000,901000,new string('e',64),new string('f',64)),"12345678-1234-1234-1234-123456789012","87654321-4321-4321-4321-210987654321","021122334455");}
 sealed class Store:IStartJournal {
  internal readonly Dictionary<string,string> Data=new Dictionary<string,string>();internal string Fail;
  readonly HashSet<string> pending=new HashSet<string>();
  public void WriteOnce(string n,string v){if(Data.ContainsKey(n)||!pending.Add(n))throw new IOException("Consumed");if(Fail==n)throw new IOException("Partial write");Data.Add(n,v);pending.Remove(n);}
  public string Read(string n){if(pending.Contains(n))throw new IOException("Partial record");string s;return Data.TryGetValue(n,out s)?s:null;}
 }
 sealed class Runtime:IBootRuntime {internal long Clock=2000;internal bool Denied;public long Now{get{return Clock;}}public void Verify(OwnedVmBootPlan p,bool mutation){if(Denied)throw new InvalidOperationException("Authority lost");}}
 sealed class Provider:IBootProvider {
  internal readonly Store J;internal int Calls,Reads,Verifies,Final;internal string Lose,Async,NoResource,WrongResource,RefuseStep,VerifyFail;
  internal ushort JobState=4,Error;internal uint Runs=1;internal string Submitted="20261031000000.000000+000";
  internal Provider(Store j){J=j;}
  internal static string Resource(string step){return HyperVOwnedBoot.ClassFor(step)+".InstanceID=\"fixture-"+step+"\"";}
  public BootResponse Configure(OwnedVmBootPlan p,string step,IDictionary<string,string> prior){
   Calls++;Check(J.Read("boot."+step+".submit")==OwnedVmBoot.Hash(J.Read("boot."+step+".intent")));
   if(Lose==step)throw new IOException("Lost response");
   if(RefuseStep==step)return new BootResponse(4,null,null);
   return new BootResponse(Async==step?4096U:0U,Async==step?HyperVStartProvider.ReferenceForId("boot-fixture"):null,NoResource==step?null:WrongResource==step?"Msvm_ComputerSystem.Name=\"foreign\"":Resource(step));
  }
  public StartJob ReadJob(string r){Reads++;return new StartJob(r,"boot-fixture",Submitted,JobState,Error,Runs);}
  public void VerifyResource(OwnedVmBootPlan p,string step,string reference,IDictionary<string,string> prior){Verifies++;if(VerifyFail==step)throw new InvalidOperationException("Resource differs");Check(reference==Resource(step));}
  public void VerifyComplete(OwnedVmBootPlan p,IDictionary<string,string> resources){Final++;Check(resources.Count==8);}
 }
 sealed class Case {internal OwnedVmBootPlan P=Plan();internal Store J=new Store();internal Runtime R=new Runtime();internal Provider V;internal Case(){V=new Provider(J);}internal BootOutcome Run(bool readOnly=false){return OwnedVmBoot.Configure(P,J,V,R,readOnly);}}
 public static int Run(){
  Test("complete-eight-steps-no-start",()=>{var c=new Case();var r=c.Run();Check(r.Configured&&!r.StartAuthorized&&!r.ReservationMayRelease&&c.V.Calls==8&&c.V.Final==1&&c.J.Read("boot.ready")!=null);});
  Test("completed-operation-never-repeated",()=>{var c=new Case();c.Run();Check(c.Run().Configured&&c.V.Calls==8&&c.V.Final==2);});
  Test("read-only-no-mutations",()=>{var c=new Case();Check(!c.Run(true).Configured&&c.V.Calls==0&&c.J.Data.Count==0);});
  Test("lost-response-stays-held",()=>{var c=new Case();c.V.Lose="diskmedia";Refuse(()=>c.Run());Check(c.Run().State=="response-lost-held"&&c.V.Calls==3&&c.J.Read("boot.bootorder.submit")==null);});
  Test("partial-response-never-resubmitted",()=>{var c=new Case();c.J.Fail="boot.diskdrive.receipt";Refuse(()=>c.Run());Refuse(()=>c.Run());Check(c.V.Calls==2);});
  Test("pending-job-blocks-dependent-stage",()=>{var c=new Case();c.V.Async="scsi";Check(c.Run().State=="job-pending-held"&&c.V.Calls==1&&c.V.Verifies==0);});
  Test("pending-settles-then-advances-once",()=>{var c=new Case();c.V.Async="scsi";c.Run();c.V.JobState=7;Check(c.Run().Configured&&c.V.Calls==8);});
  Test("read-only-settlement-cannot-add-next-resource",()=>{var c=new Case();c.V.Async="scsi";c.Run();c.V.JobState=7;Check(c.Run(true).State=="not-submitted-held"&&c.V.Calls==1);});
  Test("job-incarnation-change-refused",()=>{var c=new Case();c.V.Async="scsi";c.Run();c.V.Submitted="20261031000100.000000+000";c.V.JobState=7;Refuse(()=>c.Run());Check(c.V.Calls==1);});
  Test("failed-job-holds-dependencies",()=>{var c=new Case();c.V.Async="scsi";c.V.JobState=7;c.V.Error=32768;Check(c.Run().State=="operation-failed-held"&&c.V.Calls==1);});
  Test("recurring-job-not-settlement",()=>{var c=new Case();c.V.Async="scsi";c.V.JobState=7;c.V.Runs=2;Check(c.Run().State=="job-pending-held"&&c.V.Calls==1);});
  Test("missing-returned-resource-not-guessed",()=>{var c=new Case();c.V.NoResource="scsi";Check(c.Run().State=="result-resource-missing-held"&&c.V.Calls==1&&c.V.Verifies==0);});
  Test("wrong-returned-resource-class-refused",()=>{var c=new Case();c.V.WrongResource="scsi";Refuse(()=>c.Run());Check(c.V.Calls==1);});
  Test("provider-refusal-does-not-retry",()=>{var c=new Case();c.V.RefuseStep="diskdrive";Check(c.Run().State=="provider-refused-held"&&c.Run().State=="provider-refused-held"&&c.V.Calls==2);});
  Test("resource-readback-failure-blocks-next",()=>{var c=new Case();c.V.VerifyFail="diskmedia";Refuse(()=>c.Run());Check(c.V.Calls==3&&c.J.Read("boot.bootorder.submit")==null);});
  Test("deadline-before-mutation",()=>{var c=new Case();c.R.Clock=c.P.Definition.Deadline;Refuse(()=>c.Run());Check(c.V.Calls==0);});
  Test("authority-loss-before-mutation",()=>{var c=new Case();c.R.Denied=true;Refuse(()=>c.Run());Check(c.V.Calls==0);});
  Test("changed-network-invalidates-consumed-intent",()=>{var c=new Case();c.Run();c.P=new OwnedVmBootPlan(c.P.Definition,c.P.VmGuid,c.P.SwitchGuid,"021122334456");Refuse(()=>c.Run());Check(c.V.Calls==8);});
  Test("dependency-tampering-refused",()=>{var c=new Case();c.Run();c.J.Data["boot.diskdrive.intent"]+="x";Refuse(()=>c.Run());Check(c.V.Calls==8);});
  Test("complete-read-only-rechecks-resources",()=>{var c=new Case();c.Run();c.V.VerifyFail="port";Refuse(()=>c.Run(true));Check(c.V.Calls==8);});
  Test("unknown-step-refused",()=>Refuse(()=>HyperVOwnedBoot.ClassFor("start")));
  Test("remote-resource-refused",()=>Refuse(()=>HyperVOwnedBoot.CanonicalResource("scsi",@"\\foreign\root\virtualization\v2:"+Provider.Resource("scsi"))));
  Test("other-namespace-refused",()=>Refuse(()=>HyperVOwnedBoot.CanonicalResource("scsi",@"root\cimv2:"+Provider.Resource("scsi"))));
  Test("extra-resource-key-refused",()=>Refuse(()=>HyperVOwnedBoot.CanonicalResource("scsi",Provider.Resource("scsi")+",Other=\"x\"")));
  Test("escaped-provider-reference-roundtrip",()=>{string r="Msvm_ResourceAllocationSettingData.InstanceID=\"Microsoft:abc\\\\def\"";Check(HyperVOwnedBoot.CanonicalResource("scsi",r)==r);});
  Test("mac-multicast-or-global-refused",()=>{var p=Plan();Refuse(()=>new OwnedVmBootPlan(p.Definition,p.VmGuid,p.SwitchGuid,"011122334455"));Refuse(()=>new OwnedVmBootPlan(p.Definition,p.VmGuid,p.SwitchGuid,"001122334455"));});
  Test("fixed-disk-seed-parent-locations",()=>{var p=Plan();var refs=new Dictionary<string,string>{{"scsi",Provider.Resource("scsi")},{"diskdrive",Provider.Resource("diskdrive")},{"seeddrive",Provider.Resource("seeddrive")}};var disk=HyperVOwnedBoot.Values(p,"diskdrive",refs,null);var seed=HyperVOwnedBoot.Values(p,"seeddrive",refs,null);Check((string)disk["AddressOnParent"]=="0"&&(string)seed["AddressOnParent"]=="1"&&(string)disk["Parent"]==refs["scsi"]);Check(((string[])HyperVOwnedBoot.Values(p,"diskmedia",refs,null)["HostResource"])[0]==p.Definition.Disk);});
  Test("fixed-nic-switch-parent",()=>{var p=Plan();var refs=new Dictionary<string,string>{{"nic",Provider.Resource("nic")}};var nic=HyperVOwnedBoot.Values(p,"nic",refs,null);var port=HyperVOwnedBoot.Values(p,"port",refs,"exact-switch-reference");Check((string)nic["Address"]==p.Mac&&(bool)nic["StaticMacAddress"]&&(string)port["Parent"]==refs["nic"]&&((string[])port["HostResource"])[0]=="exact-switch-reference");});
  Test("journal-cannot-grant-start-or-definition",()=>{Check(!OwnedVmBoot.RecordAllowed("start.submit",false)&&!OwnedVmBoot.RecordAllowed("definition.submit",false)&&!OwnedVmBoot.RecordAllowed("boot.scsi.submit",true)&&OwnedVmBoot.RecordAllowed("boot.scsi.terminal",true));});
  Test("boot-order-precedes-seed-and-network",()=>{Check(String.Join(",",OwnedVmBoot.Steps)=="scsi,diskdrive,diskmedia,bootorder,seeddrive,seedmedia,nic,port");});
  Test("start-binding-matches-original-definition",()=>{var p=Plan();Check(BootStartBinding.ValidateDefinition(p.Definition.Encode(),p.Definition.Permit(p.VmGuid))==OwnedVmBoot.Hash(p.Definition.Encode()));});
  Test("start-binding-rejects-other-definition",()=>{var p=Plan();Refuse(()=>BootStartBinding.ValidateDefinition(p.Definition.Encode().Replace(p.Definition.AdmissionHash,new string('9',64)),p.Definition.Permit(p.VmGuid)));});
  Test("start-binding-rejects-reset-deadline",()=>{var p=Plan();Refuse(()=>BootStartBinding.ValidateDefinition(p.Definition.Encode().Replace("901000","902000"),p.Definition.Permit(p.VmGuid)));});
  Test("start-binding-accepts-complete-original-graph",()=>{var c=new Case();c.Run();Check(BootStartBinding.ValidateReady(c.J.Read("boot.ready"),OwnedVmBoot.Hash(c.P.Encode())).Count==8);});
  Test("start-binding-rejects-missing-or-partial-boot",()=>{var c=new Case();Refuse(()=>BootStartBinding.ValidateReady(null,OwnedVmBoot.Hash(c.P.Encode())));c.Run();var d=StartRecords.Parse(c.J.Read("boot.ready"),new[]{"plan","resources","state"});((Dictionary<string,object>)d["resources"]).Remove("diskmedia");Refuse(()=>BootStartBinding.ValidateReady(StartRecords.Encode(d),OwnedVmBoot.Hash(c.P.Encode())));});
  Test("start-binding-rejects-changed-network-plan",()=>{var c=new Case();c.Run();var other=new OwnedVmBootPlan(c.P.Definition,c.P.VmGuid,c.P.SwitchGuid,"021122334456");Refuse(()=>BootStartBinding.ValidateReady(c.J.Read("boot.ready"),OwnedVmBoot.Hash(other.Encode())));});
  Test("start-binding-rejects-duplicate-resource",()=>{var c=new Case();c.Run();var d=StartRecords.Parse(c.J.Read("boot.ready"),new[]{"plan","resources","state"});var r=(Dictionary<string,object>)d["resources"];r["seeddrive"]=r["diskdrive"];Refuse(()=>BootStartBinding.ValidateReady(StartRecords.Encode(d),OwnedVmBoot.Hash(c.P.Encode())));});
  Test("start-binding-rejects-remote-resource",()=>{Refuse(()=>BootStartBinding.Reference("diskmedia",@"\\foreign\root\virtualization\v2:"+Provider.Resource("diskmedia")));Check(BootStartBinding.Reference("diskmedia",Provider.Resource("diskmedia"))==Provider.Resource("diskmedia"));});
  return count;
 }
}
