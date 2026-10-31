// Disposable protected contracts and native-typed memory rows; no Hyper-V calls.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Enclave.OwnedRpc;
public static class LegacyHandoffHarness {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
 static int count;
 static void Check(bool ok){if(!ok)throw new Exception("Unexpected handoff qualification result");}
 static void Test(string name,Action a){a();Console.WriteLine("PASS "+name);count++;}
 static void Refuse(Action a){bool refused=false;try{a();}catch{refused=true;}Check(refused);}
 static void DirectoryNew(string path){var d=new DirectorySecurity();d.SetOwner(new SecurityIdentifier("S-1-5-32-544"));d.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})d.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,d);}
 static void Put(string path,byte[] bytes){var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,acl)){f.Write(bytes,0,bytes.Length);f.Flush(true);}}
 sealed class Contract {
  public string PathName,Hash;public readonly byte[] Manifest;
  public Contract(string op,bool wrongDigest,byte[] manifest=null){
   Manifest=manifest??Encoding.UTF8.GetBytes("{\"schema\":\"refusal-fixture\"}");
   string nonce=Guid.NewGuid().ToString("N"),parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-handoff-ci-"+nonce),root=Path.Combine(parent,nonce);DirectoryNew(parent);DirectoryNew(root);
   byte[] image=File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName);Put(Path.Combine(root,"entry.exe"),image);Put(Path.Combine(root,"handoff.json"),Manifest);
   long now=BoundedWorker.MonotonicMilliseconds();string digest=wrongDigest?new string('0',64):ProtectedAttempt.Hash(Manifest);
   byte[] contract=Encoding.UTF8.GetBytes("owned-rpc-legacy-handoff-v1\n"+nonce+"\n"+ProtectedAttempt.CurrentBoot()+"\n"+now+"\n"+(now+20000)+"\n"+ProtectedAttempt.Hash(image)+"\n"+op+"\n"+digest+"\n");
   PathName=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(contract);Put(PathName,contract);
  }
 }
 static Dictionary<string,object> Row(){return new Dictionary<string,object>{{"ResourceType",(ushort)4},{"ResourceSubType","Microsoft:Hyper-V:Memory"},{"AllocationUnits","byte * 2^20"},{"VirtualQuantityUnits","byte * 2^20"},{"VirtualQuantity",(ulong)2048},{"Reservation",(ulong)2048},{"Limit",(ulong)2048},{"DynamicMemoryEnabled",false}};}
 public static int Main(){try{
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);long deadline=BoundedWorker.MonotonicMilliseconds()+9000;
  new Thread(()=>{while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(5);TerminateProcess(GetCurrentProcess(),124);}){IsBackground=true}.Start();
  Test("static-memory-bytes",()=>Check(LegacyHandoff.MaximumMemory(Row())==2147483648));
  Test("contradictory-static-reservation-refused",()=>{var r=Row();r["Reservation"]=(ulong)8192;Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("dormant-dynamic-limit-not-static-growth",()=>{var r=Row();r["Limit"]=(ulong)1048576;Check(LegacyHandoff.MaximumMemory(r)==2147483648);});
  Test("static-quantity-over-limit-refused",()=>{var r=Row();r["Limit"]=(ulong)1024;Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("zero-static-quantity-refused",()=>{var r=Row();r["VirtualQuantity"]=(ulong)0;Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("dynamic-memory-refused",()=>{var r=Row();r["DynamicMemoryEnabled"]=true;Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("missing-memory-refused",()=>{var r=Row();r.Remove("Limit");Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("wrong-units-refused",()=>{var r=Row();r["AllocationUnits"]="bytes";Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("serialized-not-native-quantity-refused",()=>{var r=Row();r["Limit"]="2048";Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("unbounded-maximum-refused",()=>{var r=Row();r["VirtualQuantity"]=UInt64.MaxValue;Refuse(()=>LegacyHandoff.MaximumMemory(r));});
  Test("inspect-contract-binds-manifest",()=>{var c=new Contract("legacy-memory-inspect-v1",false);using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash)){Check(a.Operation=="legacy-memory-inspect-v1"&&ProtectedAttempt.Hash(a.ReadLegacyHandoff())==ProtectedAttempt.Hash(c.Manifest));}});
  Test("cut-is-separate-explicit-operation",()=>{var c=new Contract("legacy-memory-cut-v1",false);using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash))Check(a.Operation=="legacy-memory-cut-v1");});
  Test("inert-cannot-open-handoff",()=>{var c=new Contract("legacy-memory-inspect-v1",false);Refuse(()=>{using(var a=ProtectedAttempt.PinController(c.PathName,c.Hash)){};});});
  Test("provider-cannot-open-handoff",()=>{var c=new Contract("legacy-memory-inspect-v1",false);Refuse(()=>{using(var a=ProtectedAttempt.PinProviderController(c.PathName,c.Hash)){};});});
  Test("unknown-operation-refused",()=>{var c=new Contract("start",false);Refuse(()=>{using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash)){};});});
  Test("manifest-substitution-refused",()=>{var c=new Contract("legacy-memory-inspect-v1",true);using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash))Refuse(()=>a.ReadLegacyHandoff());});
  Test("wrong-manifest-schema-before-host-work",()=>{var c=new Contract("legacy-memory-inspect-v1",false);int calls=0;using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash))Refuse(()=>LegacyHandoff.Run(a,()=>{calls++;}));Check(calls==0&&!File.Exists(Path.Combine(Path.GetDirectoryName(c.PathName),"handoff.consumed")));});
  Test("input-refusal-publishes-bounded-diagnostic-before-host-work",()=>{
   string parent=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-missing-input-"+Guid.NewGuid().ToString("N"));DirectoryNew(parent);
   var json=new System.Web.Script.Serialization.JavaScriptSerializer();string secretMarker="never-publish-this-path";
   byte[] manifest=Encoding.UTF8.GetBytes(json.Serialize(new{schema="legacy-memory-handoff/1",boot=ProtectedAttempt.CurrentBoot(),topology="mandatory-copy-direct-powershell/1",master=new{path=Path.Combine(parent,"master.vmgs"),sha256=new string('0',64),bytes=1},issuers=new[]{new{port=8091}},inputs=new[]{new{path=Path.Combine(parent,secretMarker),sha256=new string('0',64),bytes=1}}}));
   var c=new Contract("legacy-memory-inspect-v1",false,manifest);using(var a=ProtectedAttempt.PinLegacyHandoffController(c.PathName,c.Hash)){
    Refuse(()=>LegacyHandoff.Run(a,()=>{}));string text=a.ReadOnce("handoff.failure");var d=LegacyHandoff.Obj(json.DeserializeObject(text));
    Check(d.Count==9&&LegacyHandoff.Str(d["manifest"])==ProtectedAttempt.Hash(manifest)&&LegacyHandoff.Str(d["phase"])=="input-file-open"&&LegacyHandoff.Num(d["inputIndex"])==0&&LegacyHandoff.Num(d["nativeError"])==2&&!text.Contains(secretMarker)&&!(bool)d["capacityAdmitted"]&&!(bool)d["reservationMayRelease"]);
    Check(!File.Exists(Path.Combine(a.Root,"handoff.consumed"))&&!File.Exists(Path.Combine(a.Root,"handoff.result")));
   }
  });
  Console.WriteLine("RESULT tests="+count+" providerCalls=false vmChanged=false targetInventoryQualified=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}}
}
