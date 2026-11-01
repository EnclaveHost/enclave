// Native SYSTEM WMI provider implementation. Excluded from the controller
// executable; controller retains shared recipes and protected receipt checks.
using System;
using System.Collections.Generic;
using System.Management;
namespace Enclave.OwnedRpc {
 public sealed partial class HyperVNativeRpcDefinition : INativeRpcDefinitionProvider, INativeRpcSecurityProvider, INativeRpcOpticalProvider, INativeRpcDeviceProvider {
  readonly INativeRpcDefinitionRuntime runtime;readonly IStartJournal journal;
  public HyperVNativeRpcDefinition(INativeRpcDefinitionRuntime runtime,IStartJournal journal){
   if(runtime==null||journal==null)throw new ArgumentNullException("dependencies");this.runtime=runtime;this.journal=journal;
  }
  static ManagementObject New(ManagementScope scope,string name,Dictionary<string,object> fields){
   using(var cls=new ManagementClass(scope,new ManagementPath(name),null)){var row=cls.CreateInstance();if(row==null)throw new InvalidOperationException("Native class unavailable");try{foreach(var pair in fields)row[pair.Key]=pair.Value;return row;}catch{row.Dispose();throw;}}
  }
  public NativeDefinitionResponse Define(NativeRpcDefinitionPlan p){
   ProtectedAttempt.RequireSystem();runtime.Check(p,true);
   if(journal.Read("native-definition.intent")!=p.Encode()||journal.Read("native-definition.submit")!=p.Digest||journal.Read("native-definition.native")!=p.Digest)throw new InvalidOperationException("Consumed native intent required");
   journal.WriteOnce("native-definition.invoke",p.Digest);var scope=HyperVStartProvider.Scope();
   using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService"))
   using(var system=New(scope,"Msvm_VirtualSystemSettingData",Settings(p)))
   using(var memory=New(scope,"Msvm_MemorySettingData",MemorySettings()))
   using(var cpu=New(scope,"Msvm_ProcessorSettingData",new Dictionary<string,object>{{"VirtualQuantity",(ulong)4}}))
   using(var input=service.GetMethodParameters("DefineSystem")){
    input["SystemSettings"]=system.GetText(TextFormat.WmiDtd20);input["ResourceSettings"]=new[]{memory.GetText(TextFormat.WmiDtd20),cpu.GetText(TextFormat.WmiDtd20)};input["ReferenceConfiguration"]=null;
    runtime.Check(p,true);if(runtime.Now<p.Origin||runtime.Now>=p.Deadline)throw new InvalidOperationException("Native original deadline");
    using(var output=service.InvokeMethod("DefineSystem",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
     if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Native definition response absent");
     return new NativeDefinitionResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,output["ResultingSystem"] as string);
    }
   }
  }
  public StartJob ReadJob(string reference){
   ProtectedAttempt.RequireSystem();if(HyperVStartProvider.CanonicalJobReference(reference)!=reference)throw new InvalidOperationException("Exact persisted job required");
   using(var job=new ManagementObject(HyperVStartProvider.Scope(),new ManagementPath(reference),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
    job.Get();if(HyperVStartProvider.CanonicalJobReference(job.Path.Path)!=reference)throw new InvalidOperationException("Job reference changed");
    foreach(string field in new[]{"InstanceID","TimeSubmitted","JobState","ErrorCode","JobRunTimes"})if(job[field]==null)throw new InvalidOperationException("Definition job field absent");
    string time=(string)job["TimeSubmitted"];ManagementDateTimeConverter.ToDateTime(time);
    return new StartJob(reference,(string)job["InstanceID"],time,Convert.ToUInt16(job["JobState"]),Convert.ToUInt16(job["ErrorCode"]),Convert.ToUInt32(job["JobRunTimes"]));
   }
  }
  public string ReadResultingSystem(string exactSettledJob){
   ProtectedAttempt.RequireSystem();if(HyperVStartProvider.CanonicalJobReference(exactSettledJob)!=exactSettledJob)throw new InvalidOperationException("Exact settled job required");
   using(var job=new ManagementObject(HyperVStartProvider.Scope(),new ManagementPath(exactSettledJob),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
    job.Get();if(HyperVStartProvider.CanonicalJobReference(job.Path.Path)!=exactSettledJob||Convert.ToUInt16(job["JobState"])!=7||Convert.ToUInt16(job["ErrorCode"])!=0||Convert.ToUInt32(job["JobRunTimes"])!=1)throw new InvalidOperationException("Successful settled definition required");
    string found=null;using(var rows=job.GetRelated("Msvm_ComputerSystem","Msvm_AffectedJobElement",null,null,null,null,false,null))foreach(ManagementObject row in rows)using(row){if(found!=null)throw new InvalidOperationException("Ambiguous resulting system");found=NativeDefinitionReferences.SystemReference(row.Path.Path);}
    if(found==null)throw new InvalidOperationException("Resulting system unavailable; no name scan");return found;
   }
  }
  static ManagementObject RelatedOne(ManagementObject parent,string name){
   ManagementObject found=null;
   try{using(var rows=parent.GetRelated(name))foreach(ManagementObject row in rows){if(found!=null){row.Dispose();throw new InvalidOperationException("Ambiguous native association: "+name);}found=row;}
    if(found==null)throw new InvalidOperationException("Missing native association: "+name);return found;
   }catch{if(found!=null)found.Dispose();throw;}
  }
  public NativeDefinitionResponse ConfigureSecurity(NativeRpcDefinitionPlan p,string guid,string intent){
   ProtectedAttempt.RequireSystem();runtime.Check(p,true);string original;NativeRpcSecurity.Ownership(p,journal,out original);
   if(original!=guid||journal.Read("native-security.native")!=intent||NativeRpcDefinitionPlan.Hash(journal.Read("native-security.intent"))!=intent)throw new InvalidOperationException("Exact consumed security intent required");
   RequireOwnedOff(p,guid);var scope=HyperVStartProvider.Scope();
   using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+guid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var security=RelatedOne(settings,"Msvm_SecuritySettingData"))
   using(var service=RelatedOne(vm,"Msvm_SecurityService"))
   using(var input=service.GetMethodParameters("ModifySecuritySettings")){
    // Modify only this guest's TPM/VTL1 offer. Preserve every other security
    // property; never disable host VBS or alter Type1 partition isolation.
    security["TpmEnabled"]=true;security["VirtualizationBasedSecurityOptOut"]=true;
    input["SecuritySettingData"]=security.GetText(TextFormat.WmiDtd20);
    journal.WriteOnce("native-security.invoke",intent);runtime.Check(p,true);
    if(runtime.Now<p.Origin||runtime.Now>=p.Deadline)throw new InvalidOperationException("Native original deadline");
    using(var output=service.InvokeMethod("ModifySecuritySettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
     if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Native security response absent");
     return new NativeDefinitionResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,null);
    }
   }
  }
  public void RequireSecurity(NativeRpcDefinitionPlan p,string guid){
   ProtectedAttempt.RequireSystem();RequireOwnedOff(p,guid);
   using(var settings=HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var security=RelatedOne(settings,"Msvm_SecuritySettingData")){
    RequireSecurityFields(new Dictionary<string,object>{{"TpmEnabled",security["TpmEnabled"]},{"VirtualizationBasedSecurityOptOut",security["VirtualizationBasedSecurityOptOut"]}});
   }runtime.Check(p,false);
  }
  public void RequireOwnedOff(NativeRpcDefinitionPlan p,string guid){RequireOwnedState(p,guid,3,0);}
  void RequireOwnedState(NativeRpcDefinitionPlan p,string guid,ushort state,ulong blocks){
   ProtectedAttempt.RequireSystem();runtime.Check(p,false);
   if(NativeDefinitionReferences.GuidForReference("Msvm_ComputerSystem.Name=\""+guid+"\"")!=guid)throw new InvalidOperationException("Canonical returned VM GUID required");
   var scope=HyperVStartProvider.Scope();
   using(var vm=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+guid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var memory=HyperVStartProvider.One(scope,"SELECT SystemName,BlockSize,NumberOfBlocks FROM Msvm_Memory WHERE SystemName='"+guid+"'")){
    if((string)vm["Name"]!=guid||(string)vm["ElementName"]!=p.Name||!(vm["EnabledState"] is ushort)||(ushort)vm["EnabledState"]!=state)throw new InvalidOperationException("Native owned state identity differs");
    foreach(var pair in Settings(p)){
     object value=settings[pair.Key];if(pair.Value is string[]){var a=value as string[];if(a==null||a.Length!=1||a[0]!=p.Note)throw new InvalidOperationException("Native owner marker differs");}
     else if(!Object.Equals(value,pair.Value))throw new InvalidOperationException("Native setting differs: "+pair.Key);
    }
    if((string)memory["SystemName"]!=guid||!(memory["BlockSize"] is ulong)||(ulong)memory["BlockSize"]!=1048576||!(memory["NumberOfBlocks"] is ulong)||(ulong)memory["NumberOfBlocks"]!=blocks)throw new InvalidOperationException("Native exact allocation unconfirmed");
    int count=0;using(var rows=settings.GetRelated("Msvm_MemorySettingData"))foreach(ManagementObject row in rows)using(row){if(++count>1)throw new InvalidOperationException("Native memory ambiguity");var d=new Dictionary<string,object>();foreach(string k in new[]{"ResourceType","ResourceSubType","AllocationUnits","VirtualQuantityUnits","VirtualQuantity","Reservation","Limit","DynamicMemoryEnabled","AutomaticAllocation","SwapFilesInUse"})d[k]=row[k];HyperVStartProvider.RequireGuestMemory(d,19L*1073741824);}if(count!=1)throw new InvalidOperationException("Native memory absent");
    var cpus=new List<object>();using(var rows=settings.GetRelated("Msvm_ProcessorSettingData"))foreach(ManagementObject row in rows)using(row){if(cpus.Count>=2)throw new InvalidOperationException("Native CPU ambiguity");cpus.Add(row["VirtualQuantity"]);}RequireProcessors(cpus);
   }runtime.Check(p,false);
  }  static ManagementObject OpticalSettings(string guid){return HyperVStartProvider.One(HyperVStartProvider.Scope(),"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+guid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'");}
  static Dictionary<string,Dictionary<string,object>> OpticalInventory(ManagementObject settings){
   var found=new Dictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);int count=0;
   // These are sibling WMI classes, not an Msvm inheritance chain. Query both
   // through this exact original VM setting's association; retain one bound.
   foreach(string cls in new[]{"Msvm_ResourceAllocationSettingData","Msvm_StorageAllocationSettingData"})
   using(var rows=settings.GetRelated(cls))foreach(ManagementObject row in rows)using(row){
    if(++count>64)throw new InvalidOperationException("Optical inventory bound");string sub=row["ResourceSubType"] as string;ushort type=Convert.ToUInt16(row["ResourceType"]);
    bool scsi=sub=="Microsoft:Hyper-V:Synthetic SCSI Controller",drive=sub=="Microsoft:Hyper-V:Synthetic DVD Drive",media=sub=="Microsoft:Hyper-V:Virtual CD/DVD Disk";
    if(!scsi&&!drive&&!media){if(type==5||type==6||type==15||type==16||type==17||type==19||type==31)throw new InvalidOperationException("Unexpected storage device on native VM");continue;}
    string step=scsi?"scsi":drive?"imagedrive":"imagemedia",reference=OpticalReference(step,row.Path.Path);var values=new Dictionary<string,object>();
    foreach(string field in scsi?new[]{"ResourceType","ResourceSubType","Address"}:drive?new[]{"ResourceType","ResourceSubType","Parent","AddressOnParent"}:new[]{"ResourceType","ResourceSubType","Parent","HostResource"})values[field]=row[field];
    found.Add(reference,values);
   }return found;
  }
  // Exact original-VM association and every expected parent/address/media path,
  // not just a matching filename or a resource belonging to another VM.
  void OpticalGuard(NativeRpcDefinitionPlan p,string guid,bool mutation){runtime.Check(p,mutation);string original;NativeRpcSecurity.Ownership(p,journal,out original);if(original!=guid)throw new InvalidOperationException("Original optical VM differs");NativeRpcSecurity.VerifyCompleted(p,journal);RequireOwnedOff(p,guid);RequireSecurity(p,guid);runtime.Check(p,mutation);}
  public NativeOpticalResponse Attach(NativeRpcDefinitionPlan p,string guid,string step,IDictionary<string,string> prior,string intent){
   ProtectedAttempt.RequireSystem();OpticalGuard(p,guid,true);string pre="native-optical."+step;
   if(journal.Read(pre+".submit")!=intent||NativeRpcDefinitionPlan.Hash(journal.Read(pre+".intent"))!=intent)throw new InvalidOperationException("Consumed optical intent required");
   var scope=HyperVStartProvider.Scope();using(var settings=OpticalSettings(guid)){
    var inventory=OpticalInventory(settings);
    if(step=="scsi"&&prior.Count==0&&inventory.Count==1){foreach(string existing in inventory.Keys){var one=new Dictionary<string,string>{{"scsi",existing}};VerifyOpticalInventory(p,one,inventory);return new NativeOpticalResponse(0,null,existing,true);}}
    VerifyOpticalInventory(p,prior,inventory);
    var values=OpticalValues(p,step,prior);
    using(var service=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemManagementService"))using(var row=New(scope,OpticalClass(step),values))using(var input=service.GetMethodParameters("AddResourceSettings")){
     if(values.ContainsKey("Parent"))row["Parent"]=scope.Path.Path+":"+(string)values["Parent"];
     input["AffectedConfiguration"]=settings.Path.Path;input["ResourceSettings"]=new[]{row.GetText(TextFormat.WmiDtd20)};
     journal.WriteOnce(pre+".invoke",intent);OpticalGuard(p,guid,true);
     using(var output=service.InvokeMethod("AddResourceSettings",input,new InvokeMethodOptions{Timeout=TimeSpan.FromSeconds(2)})){
      if(output==null||output["ReturnValue"]==null)throw new InvalidOperationException("Optical response absent");var refs=output["ResultingResourceSettings"] as string[];if(refs!=null&&refs.Length>1)throw new InvalidOperationException("Ambiguous optical resources");
      return new NativeOpticalResponse(Convert.ToUInt32(output["ReturnValue"]),output["Job"] as string,refs==null||refs.Length==0?null:refs[0]);
     }
    }
   }
  }
  public void VerifyOptical(NativeRpcDefinitionPlan p,string guid,string step,string reference,IDictionary<string,string> prior){
   ProtectedAttempt.RequireSystem();OpticalGuard(p,guid,false);var expected=new Dictionary<string,string>(prior);expected.Add(step,reference);
   // Earlier steps may be re-observed after later returned resources exist.
   // Verify their exact association/fields here; before every new mutation and
   // at final completion the entire inventory must match the known closure.
   using(var settings=OpticalSettings(guid))VerifyOpticalSubset(p,expected,OpticalInventory(settings));OpticalGuard(p,guid,false);
  }
  public void VerifyOpticalComplete(NativeRpcDefinitionPlan p,string guid,IDictionary<string,string> resources){
   ProtectedAttempt.RequireSystem();if(resources.Count!=5)throw new InvalidOperationException("Both optical roles required");OpticalGuard(p,guid,false);
   using(var settings=OpticalSettings(guid))VerifyOpticalInventory(p,resources,OpticalInventory(settings));OpticalGuard(p,guid,false);
  }
  public IList<NativeRpcDevice> ReadDevices(NativeRpcDefinitionPlan p,string guid){
   ProtectedAttempt.RequireSystem();OpticalGuard(p,guid,false);
   var optical=StartRecords.Parse(journal.Read("native-optical.observed"),new[]{"schema","plan","vmGuid","owned","security","profile","resources","startAuthorized","providerOperationFenced","reservationMayRelease"});
   NativeRpcOptical.VerifyCompleted(p,journal);var refs=new Dictionary<string,string>();foreach(var pair in (Dictionary<string,object>)optical["resources"])refs.Add(pair.Key,StartRecords.Text(pair.Value));VerifyOpticalComplete(p,guid,refs);
   var result=new List<NativeRpcDevice>();
   using(var settings=OpticalSettings(guid))
   using(var rows=settings.GetRelated("CIM_ResourceAllocationSettingData","Msvm_VirtualSystemSettingDataComponent",null,null,null,null,false,null))foreach(ManagementObject row in rows)using(row){
    if(result.Count>=64)throw new InvalidOperationException("Native device inventory bound");
    if(!(row["ResourceType"] is ushort)||!(row["ResourceSubType"] is string))throw new InvalidOperationException("Typed native resource fields required");
    // CIM base includes sibling Microsoft resource/storage/CPU/memory classes.
    // Only this original VM configuration association is queried; no host scan.
    string[] host=row["HostResource"] as string[];
    if(row["HostResource"]!=null&&host==null)throw new InvalidOperationException("Device host resource shape");
    string[] connection=null;bool debugger=false;foreach(PropertyData property in row.Properties){if(property.Name=="Connection"){connection=property.Value as string[];if(property.Value!=null&&connection==null)throw new InvalidOperationException("Connection shape");}if(property.Name=="DebuggerMode"){if(!(property.Value is bool))throw new InvalidOperationException("Debugger mode shape");debugger=(bool)property.Value;}}
    result.Add(new NativeRpcDevice(row.Path.RelativePath,row.ClassPath.ClassName,(ushort)row["ResourceType"],(string)row["ResourceSubType"],host,connection,debugger));
   }
   OpticalGuard(p,guid,false);return result;
  }
 }
}
