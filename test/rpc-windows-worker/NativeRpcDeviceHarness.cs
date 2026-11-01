using System;
using System.Collections.Generic;
using System.Collections;
using System.Web.Script.Serialization;
using System.IO;
using System.Threading;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Enclave.OwnedRpc;
public static class NativeRpcDeviceHarness {
 static int count;
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Exception("Assertion");}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused);}
 static void Test(string name,Action f){f();count++;Console.WriteLine("PASS "+name);}
 const string Id="12345678-1234-1234-1234-123456789012";
 static string SystemRef {get{return "Msvm_ComputerSystem.Name=\""+Id+"\"";}}
 static string JobRef {get{return HyperVStartProvider.ReferenceForId("definition-fixture");}}
 static NativeRpcDefinitionPlan Plan(){string n=new string('a',32);return PlanAt(n,new string('b',32),@"C:\OwnedRpcFixture\"+n,1000,new string('d',64));}
 static NativeRpcDefinitionPlan PlanAt(string n,string boot,string root,long origin,string worker){return new NativeRpcDefinitionPlan(n,boot,new string('c',32),"rpc"+new string('d',32),"0x"+new string('e',64),new string('f',64),new string('a',64),new string('b',64),new string('c',64),new string('d',64),new string('e',64),root,origin,origin+900000,new string('f',64),new string('a',64),worker);}
 sealed class Journal:IStartJournal {
  public readonly Dictionary<string,string> Data=new Dictionary<string,string>();public string Fail;
  public void WriteOnce(string n,string v){if(n==Fail)throw new IOException("Injected durable write failure");if(Data.ContainsKey(n))throw new IOException("Consumed");Data.Add(n,v);}
  public string Read(string n){string v;return Data.TryGetValue(n,out v)?v:null;}
 }
 sealed class Runtime:INativeRpcDefinitionRuntime {
  public long Clock=2000;public bool Deny,ObservationDenied;public int Before,Reads;
  public long Now{get{return Clock;}}
  public void Check(NativeRpcDefinitionPlan p,bool mutation){if(mutation){Before++;if(Deny)throw new Exception("Admission refused");}else{Reads++;if(ObservationDenied)throw new Exception("Reader expired");}}

 }
 sealed class Provider:INativeRpcDefinitionProvider {
  public readonly Journal Journal;public int Defines,Reads,Associations,Off;public bool Lose,WrongOff,RecycledAfterAssociation;
  public ushort State=7,Error;public uint Runs=1;public string Submitted="20261031070000.000000+000";
  public NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,SystemRef);
  public Provider(Journal j){Journal=j;}
  public NativeDefinitionResponse Define(NativeRpcDefinitionPlan p){Defines++;Check(Journal.Read("native-definition.intent")==p.Encode()&&Journal.Read("native-definition.native")!=null);if(Lose)throw new IOException("Lost response");return Response;}
  public StartJob ReadJob(string r){Reads++;Check(Journal.Read("native-definition.receipt")!=null&&r==JobRef);return new StartJob(r,"definition-fixture",Submitted,State,Error,Runs);}
  public string ReadResultingSystem(string r){Associations++;Check(Journal.Read("native-definition.terminal")!=null);if(RecycledAfterAssociation)Submitted="20261031070100.000000+000";return SystemRef;}
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){Off++;Check(Journal.Read("native-definition.system")!=null&&guid==Id);if(WrongOff)throw new Exception("Owned Off readback differs");}
 }
 sealed class Case {public NativeRpcDefinitionPlan P=Plan();public Journal J=new Journal();public Runtime R=new Runtime();public Provider V;public Case(){V=new Provider(J);NativeRpcDefinition.Prepare(P,J);}public NativeRpcDefinitionOutcome Run(){return NativeRpcDefinition.Submit(P,J,V,R);}public NativeRpcDefinitionOutcome Read(){return NativeRpcDefinition.Reconcile(P,J,V,R);}}
 static byte[] fixtureImage;
 static void DirectoryNew(string path){var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,a);}
 static void Put(string path,byte[] bytes){var a=new FileSecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,a)){f.Write(bytes,0,bytes.Length);f.Flush(true);}}

 sealed class ProtectedCase {
  public readonly string Contract,Hash,PlanPath,PlanHash;public readonly NativeRpcDefinitionPlan P;
  public ProtectedCase(string operation="define",bool wrongWorker=false){
   string drive=Path.GetPathRoot(Environment.SystemDirectory),n=Guid.NewGuid().ToString("N"),id=Guid.NewGuid().ToString("N"),boot=ProtectedAttempt.CurrentBoot();
   string parent=Path.Combine(drive,"rpc-native-ci-"+n),root=Path.Combine(parent,n);DirectoryNew(parent);DirectoryNew(root);Put(Path.Combine(root,"entry.exe"),fixtureImage);
   string vp=Path.Combine(drive,"rpc-native-plan-"+id),vr=Path.Combine(vp,id);DirectoryNew(vp);DirectoryNew(vr);long now=BoundedWorker.MonotonicMilliseconds();
   P=PlanAt(id,boot,vr,now,wrongWorker?new string('e',64):ProtectedAttempt.Hash(fixtureImage));
   PlanPath=Path.Combine(vr,"native-definition-plan.txt");byte[] bytes=Encoding.UTF8.GetBytes(P.Encode());PlanHash=ProtectedAttempt.Hash(bytes);Put(PlanPath,bytes);
   bytes=Encoding.UTF8.GetBytes("owned-native-rpc-definition-worker-v1\n"+n+"\n"+boot+"\n"+now+"\n"+(now+20000)+"\n"+ProtectedAttempt.Hash(fixtureImage)+"\n"+operation+"\n"+PlanPath+"\n"+PlanHash+"\n");
   Contract=Path.Combine(root,"contract.txt");Hash=ProtectedAttempt.Hash(bytes);Put(Contract,bytes);
  }
  public ProtectedAttempt Lease(){return ProtectedAttempt.PinNativeDefinitionController(Contract,Hash);}
 }
 sealed class Security:INativeRpcSecurityProvider {
  internal Journal J;internal int Calls,Reads,Off,Checks;internal bool Lose,WrongSecurity,WrongOff;internal ushort State=7,Error;internal uint Runs=1;internal string Time="20261101070000.000000+000";
  internal NativeDefinitionResponse Response=new NativeDefinitionResponse(0,null,null);
  internal Security(Journal j){J=j;}
  public NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent){Check(guid==Id&&J.Read("native-definition.owned")!=null&&J.Read("native-security.native")==intent);J.WriteOnce("native-security.invoke",intent);Calls++;if(Lose)throw new IOException("Lost provider response");return Response;}
  public StartJob ReadJob(string reference){Reads++;Check(reference==JobRef&&J.Read("native-security.receipt")!=null);return new StartJob(reference,"definition-fixture",Time,State,Error,Runs);}
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){Off++;Check(guid==Id);if(WrongOff)throw new IOException("Owned VM changed");}
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){Checks++;Check(guid==Id);if(WrongSecurity)throw new IOException("Security differs");}
 }
 sealed class SecurityCase {
  internal Case C=new Case();internal Security V;internal SecurityCase(){C.Run();V=new Security(C.J);}
  internal string Submit(){return NativeRpcSecurity.Submit(C.P,C.J,V,C.R);}
  internal string Read(){return NativeRpcSecurity.Reconcile(C.P,C.J,V,C.R);}
 }

 static string Ref(string step){return HyperVNativeRpcDefinition.OpticalClass(step)+".InstanceID=\"fixture-"+step+"\"";}
 sealed class Optical:INativeRpcOpticalProvider {
  internal readonly Journal J;internal readonly Runtime R;internal readonly Dictionary<string,string> Resources=new Dictionary<string,string>();internal string Special,WrongResource,Time="20261101172400.000000+000";internal int Calls,Reads,Verifies,Complete;internal bool Lose,Async,Missing,WrongFinal,Expire;internal uint Code;internal ushort State=7,Error;
  internal Optical(Journal j,Runtime r){J=j;R=r;}
  public NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent){
   Calls++;Check(guid==Id&&J.Read("native-optical."+step+".submit")==intent&&J.Read("native-optical."+step+".receipt")==null&&prior.Count==Resources.Count);
   if(step==Special&&Lose)throw new IOException("Lost attachment response");if(Expire)R.Clock=p.Deadline;
   uint code=step==Special&&Code!=0?Code:Async?4096U:0U;
   return new NativeOpticalResponse(code,code==4096?JobRef:null,step==Special&&(Missing||Code!=0)?null:step==Special&&WrongResource!=null?WrongResource:Ref(step));
  }
  public StartJob ReadJob(string reference){Reads++;Check(reference==JobRef);bool saved=false;foreach(string step in NativeRpcOptical.Steps)if(J.Read("native-optical."+step+".receipt")!=null)saved=true;Check(saved);return new StartJob(reference,"definition-fixture",Time,State,Error,1);}
  public void VerifyOptical(NativeRpcDefinitionPlan p,string guid,string step,string resource,IDictionary<string,string> prior){Verifies++;Check(J.Read("native-optical."+step+".receipt")!=null&&guid==Id&&resource==Ref(step));if(!Resources.ContainsKey(step))Resources.Add(step,resource);}
  public void VerifyOpticalComplete(NativeRpcDefinitionPlan p,string guid,IDictionary<string,string> resources){Complete++;Check(guid==Id&&resources.Count==5);if(WrongFinal)throw new Exception("Actual topology changed");}
 }
 sealed class OpticalCase {
  internal readonly SecurityCase S=new SecurityCase();internal readonly Optical V;
  internal OpticalCase(){S.Submit();V=new Optical(S.C.J,S.C.R);}
  internal string Run(bool readOnly=false){return NativeRpcOptical.Configure(S.C.P,S.C.J,V,S.C.R,readOnly);}
 }
 static Dictionary<string,string> All(){var d=new Dictionary<string,string>();foreach(string step in NativeRpcOptical.Steps)d.Add(step,Ref(step));return d;}
 static Dictionary<string,Dictionary<string,object>> Inventory(NativeRpcDefinitionPlan p,IDictionary<string,string> all){var d=new Dictionary<string,Dictionary<string,object>>();foreach(var x in all)d.Add(x.Value,HyperVNativeRpcDefinition.OpticalValues(p,x.Key,all));return d;}
 const string Sid="S-1-5-83-1-123-456-789-1011";
 sealed class Access:INativeRpcReadAccess {
  internal Journal J;internal Runtime R;internal NativeRpcDefinitionPlan P;internal string Account=Sid,Fail;internal int Applies,Observes,Captures;internal bool Expire,Changed;
  internal Access(SecurityCase c){J=c.C.J;R=c.C.R;P=c.C.P;}
  public string Resolve(string guid){Check(guid==Id);return Account;}
  public string Capture(string name,string sid){Captures++;return name+",00000001:0000000000000002:0000000000000003,1,"+new string('a',64)+","+new string('b',64);}
  public void Apply(string name,string sid,string snapshot){Check(J.Read("native-read.submit")==NativeRpcDefinitionPlan.Hash(J.Read("native-read.intent"))&&J.Read("native-read.receipt")==null);Applies++;if(name==Fail)throw new IOException("Injected failed grant");if(Expire)R.Clock=P.Deadline;}
  public void Observe(string name,string sid,string snapshot){Observes++;if(Changed)throw new IOException("Changed ACL or file identity");}
 }

 static NativeRpcDevice Device(string cls,ushort type,string subtype,string key,string[] host=null,string[] connection=null,bool debugger=false){return new NativeRpcDevice(cls+".InstanceID=\""+key+"\"",cls,type,"Microsoft:Hyper-V:"+subtype,host,connection,debugger);}
 static List<NativeRpcDevice> Devices(NativeRpcDefinitionPlan p){var a=new List<NativeRpcDevice>{Device("Msvm_ProcessorSettingData",3,"Processor","cpu"),Device("Msvm_MemorySettingData",4,"Memory","memory")};foreach(string step in NativeRpcOptical.Steps){var v=HyperVNativeRpcDefinition.OpticalValues(p,step,All());a.Add(new NativeRpcDevice(Ref(step),HyperVNativeRpcDefinition.OpticalClass(step),(ushort)v["ResourceType"],(string)v["ResourceSubType"],v.ContainsKey("HostResource")?(string[])v["HostResource"]:null,null));}return a;}
 sealed class DeviceReader:INativeRpcDeviceProvider {internal Runtime R;internal List<NativeRpcDevice> Rows;internal int Reads,Delay;internal bool Lost;public IList<NativeRpcDevice> ReadDevices(NativeRpcDefinitionPlan p,string guid){Check(guid==Id);Reads++;R.Clock+=Delay;if(Lost)throw new IOException("Unavailable inventory");return Rows;}}
 sealed class DeviceCase {internal OpticalCase O=new OpticalCase();internal DeviceReader V;internal DeviceCase(){O.Run();NativeRpcReadGrant.Run(O.S.C.P,O.S.C.J,O.S.C.R,new Access(O.S),false);V=new DeviceReader{R=O.S.C.R,Rows=Devices(O.S.C.P)};}internal string Run(){return NativeRpcDevicePolicy.Observe(O.S.C.P,O.S.C.J,V,O.S.C.R);}internal string Proof(){return NativeRpcDevicePolicy.VerifyCompleted(O.S.C.P,O.S.C.J);}}
 public static int Main(string[] args){try{
  if(args.Length!=0)throw new ArgumentException("No fixture selection");
  var timer=new Timer(delegate{TerminateProcess(GetCurrentProcess(),125);},null,20000,Timeout.Infinite);BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);fixtureImage=File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location);
  var sample=new System.Management.ManagementPath(Devices(Plan())[0].Reference);Console.WriteLine("WMI relative reference diagnostics: input="+Devices(Plan())[0].Reference+" parsed="+sample.RelativePath+" server="+sample.Server+" namespace="+sample.NamespacePath+" class="+sample.ClassName+" instance="+sample.IsInstance);
  Test("original device observation binds all prior receipts and never permits start or release",()=>{var c=new DeviceCase();Check(c.Run()==c.Proof());string raw=c.O.S.C.J.Read("native-device.observed");Check(raw.Contains("\"startAuthorized\":false")&&raw.Contains("\"providerOperationFenced\":false")&&raw.Contains("\"reservationMayRelease\":false")&&c.V.Reads==1);});
  Test("fresh reordered observation is stable and performs no repeated mutations",()=>{var c=new DeviceCase();string h=c.Run();c.V.Rows.Reverse();Check(c.Run()==h&&c.V.Reads==2&&c.O.V.Calls==5&&c.O.S.V.Calls==1&&c.O.S.C.V.Defines==1);});
  Test("default disconnected serial and non3D synthetic display are bounded",()=>{var p=Plan();var a=Devices(p);a.Add(Device("Msvm_SerialPortSettingData",21,"Serial Port","com1",null,new[]{""}));a.Add(Device("Msvm_ResourceAllocationSettingData",21,"Serial Port","com2"));a.Add(Device("Msvm_SyntheticDisplayControllerSettingData",24,"Synthetic Display Controller","video"));Check(NativeRpcDevicePolicy.Validate(p,All(),a).Length==64);a.Add(Device("Msvm_SerialPortSettingData",21,"Serial Port","com3"));Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));});
  Test("NIC network attachment passthrough GPU disk and unknown resources refuse",()=>{foreach(var d in new[]{Device("Msvm_SyntheticEthernetPortSettingData",10,"Synthetic Ethernet Port","nic"),Device("Msvm_EthernetPortAllocationSettingData",33,"Ethernet Connection","switch"),Device("Msvm_ResourceAllocationSettingData",1,"PCI Express","pci"),Device("Msvm_Synthetic3DDisplayControllerSettingData",24,"Synthetic 3D Display Controller","gpu"),Device("Msvm_StorageAllocationSettingData",31,"Virtual Hard Disk","disk"),Device("Msvm_UnknownSettingData",1,"Unknown","unknown")}){var c=new DeviceCase();c.V.Rows.Add(d);Refuse(()=>c.Run());Check(c.O.S.C.J.Read("native-device.observed")==null);}});
  Test("connected serial named pipe and debugger mode refuse",()=>{foreach(var d in new[]{Device("Msvm_SerialPortSettingData",21,"Serial Port","serial",null,new[]{@"\\.\pipe\host"}),Device("Msvm_SerialPortSettingData",21,"Serial Port","serial",new[]{"host"}),Device("Msvm_SerialPortSettingData",21,"Serial Port","serial",null,null,true)}){var a=Devices(Plan());a.Add(d);Refuse(()=>NativeRpcDevicePolicy.Validate(Plan(),All(),a));}});
  Test("missing duplicate aliased or additional CPU memory optical fail",()=>{var p=Plan();for(int i=0;i<7;i++){var a=Devices(p);a.RemoveAt(i);Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));a=Devices(p);a.Add(a[i]);Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));}var b=Devices(p);b.Add(Device("Msvm_ProcessorSettingData",3,"Processor","cpu2"));Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),b));});
  Test("foreign media path type class and reference cannot pass matching resource count",()=>{var p=Plan();var original=Devices(p)[4];foreach(var d in new[]{new NativeRpcDevice(original.Reference,original.Class,31,original.Subtype,new[]{@"C:\foreign.container"},null),new NativeRpcDevice(original.Reference,original.Class,17,original.Subtype,original.Host,null),new NativeRpcDevice(original.Reference,"Msvm_ResourceAllocationSettingData",31,original.Subtype,original.Host,null),new NativeRpcDevice(original.Reference.Replace("fixture","foreign"),original.Class,31,original.Subtype,original.Host,null)}){var a=Devices(p);a[4]=d;Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));}});
  Test("local relative reference closure rejects namespace server alternate keys and overlong identity",()=>{var p=Plan();var d=Devices(p)[0];foreach(string r in new[]{@"\\remote\root\virtualization\v2:"+d.Reference,@"root\virtualization\v2:"+d.Reference,d.Reference.Replace("InstanceID","Name"),d.Class+".InstanceID=\""+new string('x',2049)+"\""}){var a=Devices(p);a[0]=new NativeRpcDevice(r,d.Class,d.Type,d.Subtype,null,null);Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));}});
  Test("host assignment on CPU and extra backing or connection on boot device refuse",()=>{var p=Plan();foreach(int i in new[]{0,1,2,3}){var a=Devices(p);var d=a[i];a[i]=new NativeRpcDevice(d.Reference,d.Class,d.Type,d.Subtype,new[]{"host"},null);Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),a));}var b=Devices(p);var x=b[4];b[4]=new NativeRpcDevice(x.Reference,x.Class,x.Type,x.Subtype,x.Host,new[]{"network"});Refuse(()=>NativeRpcDevicePolicy.Validate(p,All(),b));});
  Test("four second freshness accepts boundary but rejects late rollback and original expiry",()=>{var ok=new DeviceCase();ok.V.Delay=4000;Check(ok.Run()!=null);foreach(int delay in new[]{4001,-1,900000}){var c=new DeviceCase();c.V.Delay=delay;Refuse(()=>c.Run());Check(c.O.S.C.J.Read("native-device.observed")==null);}});
  Test("missing original security read grant optical or ownership refuses before inventory",()=>{foreach(string name in new[]{"native-security.observed","native-read.receipt","native-optical.observed","native-definition.owned"}){var c=new DeviceCase();c.O.S.C.J.Data.Remove(name);Refuse(()=>c.Run());Check(c.V.Reads==0&&c.O.S.C.J.Read("native-device.observed")==null);}});
  Test("changed otherwise allowed inventory refuses immutable original observation",()=>{var c=new DeviceCase();c.Run();c.V.Rows.Add(Device("Msvm_SerialPortSettingData",21,"Serial Port","com1"));Refuse(()=>c.Run());Check(c.V.Reads==2);});
  Test("lost observation write and altered proof cannot claim completion",()=>{var c=new DeviceCase();c.O.S.C.J.Fail="native-device.observed";Refuse(()=>c.Run());Refuse(()=>c.Proof());c=new DeviceCase();c.Run();string raw=c.O.S.C.J.Data["native-device.observed"];foreach(string changed in new[]{raw.Replace("no-nic-af-hyperv-only","nic"),raw.Replace("\"startAuthorized\":false","\"startAuthorized\":true"),raw.Replace(Id,"87654321-4321-4321-4321-210987654321")}){c.O.S.C.J.Data["native-device.observed"]=changed;Refuse(()=>c.Proof());}});
  Test("provider loss and denied runtime cannot write device proof",()=>{var c=new DeviceCase();c.V.Lost=true;Refuse(()=>c.Run());Check(c.O.S.C.J.Read("native-device.observed")==null);c=new DeviceCase();c.O.S.C.R.ObservationDenied=true;Refuse(()=>c.Run());Check(c.V.Reads==0);});
  Test("actual protected original journal permits only one device observation in readonly reconciliation",()=>{var c=new ProtectedCase("reconcile");using(var lease=c.Lease())using(var pin=ProtectedAttempt.PinNativeDefinitionJournalController(c.PlanPath,c.PlanHash,lease)){var j=new NativeRpcDefinitionJournal(pin);j.WriteOnce("native-device.observed","inert-proof");Check(j.Read("native-device.observed")=="inert-proof");Refuse(()=>j.WriteOnce("native-device.observed","replacement"));Refuse(()=>j.WriteOnce("native-device.submit","mutation"));Refuse(()=>j.WriteOnce("native-read.submit","mutation"));Refuse(()=>NativeRpcDevicePolicy.VerifyCompleted(c.P,j));}});
  GC.KeepAlive(timer);Console.WriteLine("TOTAL "+count+" PASS; provider/inventory/clock mocked; actual administrator journal; no target SYSTEM/WMI/VM/RPC");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
