// Independent start-side readback of the completed fixed boot graph. This is
// required before claim dispatch/native Start, not only by the boot controller.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
 internal sealed class BootStartBinding {
  readonly ProtectedAttempt vm;readonly Action live;
  readonly Dictionary<string,string> refs=new Dictionary<string,string>();
  readonly string switchGuid,mac;
  static readonly string[] Steps={"scsi","diskdrive","diskmedia","bootorder","seeddrive","seedmedia","nic","port"};
  static readonly string[] Classes={"Msvm_ResourceAllocationSettingData","Msvm_ResourceAllocationSettingData","Msvm_StorageAllocationSettingData","Msvm_BootSourceSettingData","Msvm_ResourceAllocationSettingData","Msvm_StorageAllocationSettingData","Msvm_SyntheticEthernetPortSettingData","Msvm_EthernetPortAllocationSettingData"};
  static string Hash(string s){return ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(s));}
  internal static string ValidateDefinition(string raw,OwnedVmPermit p){
   string[] f=raw.Split('\n');
   if(f.Length!=12||f[0]!="owned-rpc-definition/1"||f[1]!=p.Attempt||f[2]!=p.Boot||f[3]!=p.AdmissionHash||f[4]!=p.ImageHash||f[5]!=Path.GetDirectoryName(p.ConfigurationRoot)||f[6]!=p.Origin.ToString(CultureInfo.InvariantCulture)||f[7]!=p.Deadline.ToString(CultureInfo.InvariantCulture)||f[10]!="generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false"||f[11]!="")throw new InvalidOperationException("Boot definition differs from original start permit");
   StartIdentity.Hex(f[8],64);StartIdentity.Hex(f[9],64);return Hash(raw);
  }
  internal static string Reference(string step,string raw){
   int index=Array.IndexOf(Steps,step);if(index<0||raw==null||raw.Length>2048)throw new InvalidOperationException("Boot reference bound");
   string type=Classes[index];var p=new ManagementPath(raw);
   if(!p.IsInstance||!String.Equals(p.ClassName,type,StringComparison.OrdinalIgnoreCase)||(p.Server!=""&&p.Server!="."&&!String.Equals(p.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("Local boot resource required");
   string ns=p.NamespacePath;if(ns.StartsWith(@"\\")){int slash=ns.IndexOf('\\',2);if(slash<0)throw new InvalidOperationException("Boot namespace");ns=ns.Substring(slash+1);}
   if(ns!=""&&!String.Equals(ns,@"root\virtualization\v2",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Boot namespace");
   string relative=p.RelativePath;if(!Regex.IsMatch(relative,"\\A"+type+"\\.InstanceID=\"(?:[^\"\\\\\\r\\n]|\\\\[\\\\\"]){1,1024}\"\\z",RegexOptions.IgnoreCase))throw new InvalidOperationException("Exact boot instance key required");return type+relative.Substring(relative.IndexOf('.'));
  }
  internal static Dictionary<string,string> ValidateReady(string raw,string expectedPlan){
   var d=StartRecords.Parse(raw,new[]{"plan","resources","state"});
   if(StartRecords.Text(d["plan"])!=expectedPlan||StartRecords.Text(d["state"])!="configured-owned-off")throw new InvalidOperationException("Completed boot binding absent");
   var values=d["resources"] as Dictionary<string,object>;if(values==null||values.Count!=8)throw new InvalidOperationException("Complete boot graph required");var found=new Dictionary<string,string>();var unique=new HashSet<string>();
   foreach(string step in Steps){object value;if(!values.TryGetValue(step,out value))throw new InvalidOperationException("Boot graph step missing");string r=StartRecords.Text(value);if(Reference(step,r)!=r||!unique.Add(r))throw new InvalidOperationException("Ambiguous boot graph reference");found.Add(step,r);}return found;
  }
  internal BootStartBinding(ProtectedAttempt vm,Action live){
   if(vm==null||vm.VmPermit==null||live==null)throw new ArgumentException("Held original VM and live worker required");this.vm=vm;this.live=live;live();
   string definition=vm.ReadBootDefinition(),digest=ValidateDefinition(definition,vm.VmPermit);string[] fields=definition.Split('\n');
   var json=new JavaScriptSerializer{MaxJsonLength=262144,RecursionLimit=32};
   var admission=json.DeserializeObject(new UTF8Encoding(false,true).GetString(vm.ReadAdmission(vm.VmPermit.AdmissionHash))) as Dictionary<string,object>;object network;
   if(admission==null||!admission.TryGetValue("bootNetwork",out network))throw new InvalidOperationException("Boot network admission absent");
   var net=network as Dictionary<string,object>;
   if(net==null||net.Count!=3||!net.ContainsKey("schema")||!net.ContainsKey("switchGuid")||!net.ContainsKey("mac")||StartRecords.Text(net["schema"])!="owned-rpc-boot-network/1")throw new InvalidOperationException("Boot network schema");
   switchGuid=StartRecords.Text(net["switchGuid"]);mac=StartRecords.Text(net["mac"]);Guid id;
   if(!Guid.TryParseExact(switchGuid,"D",out id)||id==Guid.Empty||id.ToString("D")!=switchGuid||!Regex.IsMatch(mac,"\\A02[0-9A-F]{10}\\z"))throw new InvalidOperationException("Boot network identity");
   string plan=StartRecords.Encode(new Dictionary<string,object>{{"schema","owned-rpc-boot/1"},{"definition",digest},{"vm",vm.VmPermit.VmGuid},{"switch",switchGuid},{"mac",mac}});
   refs=ValidateReady(vm.ReadOnce("boot.ready"),Hash(plan));
   var media=StartRecords.Parse(vm.ReadOnce("boot.media"),new[]{"plan","disk","seed"});if(StartRecords.Text(media["plan"])!=digest)throw new InvalidOperationException("Boot media plan differs");
   vm.HoldBootStartMedia("boot.vhdx",fields[8],media["disk"],4294967296L);vm.HoldBootStartMedia("seed.iso",fields[9],media["seed"],67108864L);live();
  }
  static void Same(object a,object b){
   if(b is string[]){var x=a as string[];var y=(string[])b;if(x==null||x.Length!=y.Length)throw new InvalidOperationException("Boot array differs");for(int i=0;i<x.Length;i++)Same(x[i],y[i]);}
   else if(b is string){if(!String.Equals(a as string,(string)b,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Boot string differs");}
   else if(!Object.Equals(a,b))throw new InvalidOperationException("Boot typed value differs");
  }
  void Current(long began){live();vm.CheckDeadline();long now=BoundedWorker.MonotonicMilliseconds();if(now<began||now-began>2000)throw new InvalidOperationException("Aggregate boot readback exceeds two seconds");}
  internal void Verify(){
   long began=BoundedWorker.MonotonicMilliseconds();Current(began);var p=vm.VmPermit;var scope=HyperVStartProvider.Scope();
   using(var system=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_ComputerSystem WHERE Name='"+p.VmGuid+"'"))
   using(var settings=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualSystemSettingData WHERE VirtualSystemIdentifier='"+p.VmGuid+"' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"))
   using(var sw=HyperVStartProvider.One(scope,"SELECT * FROM Msvm_VirtualEthernetSwitch WHERE Name='"+switchGuid+"'")){
    if((string)system["Name"]!=p.VmGuid||(string)system["ElementName"]!=p.VmName||Convert.ToUInt16(system["EnabledState"])!=3)throw new InvalidOperationException("Boot target is not original owned Off VM");
    Same(settings["Notes"],new[]{p.OwnerNote});Same(settings["ConfigurationDataRoot"],p.ConfigurationRoot);Same(settings["VirtualSystemSubType"],"Microsoft:Hyper-V:SubType:2");
    Same(settings["AutomaticStartupAction"],(ushort)2);Same(settings["AutomaticShutdownAction"],(ushort)4);Same(settings["UserSnapshotType"],(ushort)2);Same(settings["AutomaticSnapshotsEnabled"],false);Same(settings["SecureBootEnabled"],true);Same(settings["SecureBootTemplateId"],"272e7447-90a4-4563-a4b9-8e4ab00526ce");
    if((string)sw["Name"]!=switchGuid)throw new InvalidOperationException("Boot switch changed");
    var expected=new Dictionary<string,Dictionary<string,object>>{
     {"scsi",new Dictionary<string,object>{{"ResourceType",(ushort)6},{"ResourceSubType","Microsoft:Hyper-V:Synthetic SCSI Controller"},{"Address","0"}}},
     {"diskdrive",new Dictionary<string,object>{{"ResourceType",(ushort)17},{"ResourceSubType","Microsoft:Hyper-V:Synthetic Disk Drive"},{"Parent",refs["scsi"]},{"AddressOnParent","0"}}},
     {"diskmedia",new Dictionary<string,object>{{"ResourceType",(ushort)31},{"ResourceSubType","Microsoft:Hyper-V:Virtual Hard Disk"},{"Parent",refs["diskdrive"]},{"HostResource",new[]{Path.Combine(vm.Root,"boot.vhdx")}}}},
     {"seeddrive",new Dictionary<string,object>{{"ResourceType",(ushort)16},{"ResourceSubType","Microsoft:Hyper-V:Synthetic DVD Drive"},{"Parent",refs["scsi"]},{"AddressOnParent","1"}}},
     {"seedmedia",new Dictionary<string,object>{{"ResourceType",(ushort)31},{"ResourceSubType","Microsoft:Hyper-V:Virtual CD/DVD Disk"},{"Parent",refs["seeddrive"]},{"HostResource",new[]{Path.Combine(vm.Root,"seed.iso")}}}},
     {"nic",new Dictionary<string,object>{{"ResourceType",(ushort)10},{"ResourceSubType","Microsoft:Hyper-V:Synthetic Ethernet Port"},{"Address",mac},{"StaticMacAddress",true}}},
     {"port",new Dictionary<string,object>{{"ResourceType",(ushort)33},{"ResourceSubType","Microsoft:Hyper-V:Ethernet Connection"},{"Parent",refs["nic"]},{"HostResource",new[]{sw.Path.Path}},{"EnabledState",(ushort)2}}}
    };
    foreach(string step in Steps){
     Current(began);int index=Array.IndexOf(Steps,step);
     using(var row=new ManagementObject(scope,new ManagementPath(refs[step]),new ObjectGetOptions{Timeout=TimeSpan.FromSeconds(2)})){
      row.Get();if(Reference(step,row.Path.Path)!=refs[step])throw new InvalidOperationException("Boot reference incarnation differs");
      if(step=="bootorder"){
       var order=settings["BootSourceOrder"] as string[];if(order==null||order.Length<1||order.Length>16||Reference(step,order[0])!=refs[step]||Convert.ToUInt32(row["BootSourceType"])!=1)throw new InvalidOperationException("Owned disk not first boot source");
      }else{
       int seen=0,matches=0;using(var all=settings.GetRelated(Classes[index]))foreach(ManagementObject candidate in all)using(candidate){if(++seen>64)throw new InvalidOperationException("Boot graph bound");if((string)candidate["ResourceSubType"]==(string)expected[step]["ResourceSubType"]){if(Reference(step,candidate.Path.Path)!=refs[step])throw new InvalidOperationException("Unexpected same-kind boot resource");matches++;}Current(began);}if(matches!=1)throw new InvalidOperationException("Boot resource not uniquely owned");
       foreach(var pair in expected[step]){object value=row[pair.Key];if(pair.Key=="Parent")value=Reference(step=="port"?"nic":step=="diskmedia"?"diskdrive":step=="seedmedia"?"seeddrive":"scsi",(string)value);Same(value,pair.Value);}
      }
     }
    }
    system.Get();settings.Get();if(Convert.ToUInt16(system["EnabledState"])!=3||(string)system["ElementName"]!=p.VmName)throw new InvalidOperationException("VM changed during boot readback");Same(settings["Notes"],new[]{p.OwnerNote});Same(settings["ConfigurationDataRoot"],p.ConfigurationRoot);
   }Current(began);
  }
 }
 public sealed partial class ProtectedAttempt {
  internal string ReadBootDefinition(){CheckDeadline();return Utf8.GetString(Bytes(HoldRead(Path.Combine(Root,"definition-plan.txt"),4096),4096));}
  internal void HoldBootStartMedia(string name,string expectedHash,object value,long maximum){
   if(name!="boot.vhdx"&&name!="seed.iso")throw new ArgumentException("Fixed boot asset required");
   var fields=value as IList;if(fields==null||fields.Count!=4||StartRecords.Text(fields[0])!=expectedHash)throw new InvalidOperationException("Initial media proof absent");
   string path=Path.Combine(Root,name);var handle=CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(handle.IsInvalid){handle.Dispose();throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());}held.Add(handle);Authority(handle,true,false,path);FileInfo info;
   if(!GetFileInformationByHandle(handle,out info)||StartRecords.Number(fields[1])!=info.Volume||StartRecords.Number(fields[2])!=info.IndexHigh||StartRecords.Number(fields[3])!=info.IndexLow)throw new InvalidOperationException("Initial boot asset replaced");
   long size=checked(((long)info.SizeHigh<<32)|info.SizeLow);if(size<1||size>maximum)throw new InvalidOperationException("Boot asset exceeds admitted disk bound");CheckDeadline();
  }
 }
}
