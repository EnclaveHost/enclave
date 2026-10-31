// Fixed owner file operations for the original RPC startup transaction.
// No task registration, child process, VM/provider call, retry or ACL repair.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Enclave.OwnedRpc {
 public static class TransitionFiles {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=16};
  static readonly List<IDisposable> Held=new List<IDisposable>();
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
  static long Origin,Deadline,OriginalOrigin,OriginalDeadline;static string Nonce,Boot,Attempt,Operation;
  const long MiB=1048576,GiB=1073741824;
  [StructLayout(LayoutKind.Sequential)] struct Memory {public uint Length,Load;public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended;}
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Length;public IntPtr Descriptor;public int Inherit;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string root,out ulong available,out ulong total,out ulong free);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SecurityAttributes attributes);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  static void Check(){long now=BoundedWorker.MonotonicMilliseconds();if(now<Origin||now>=Deadline)throw new TimeoutException("Original file-operation lease expired");}
  static void Arm(){
   var ready=new ManualResetEvent(false);
   new Thread(delegate(){ready.Set();while(BoundedWorker.MonotonicMilliseconds()<Deadline)Thread.Sleep(5);
    if(!TerminateProcess(GetCurrentProcess(),124))Environment.FailFast("File-operation deadline termination failed");
   }){IsBackground=true}.Start();
   if(!ready.WaitOne(1000))throw new TimeoutException("Independent file watchdog not armed");Check();
  }
  static void Hex(string value,int length){if(value==null||!Regex.IsMatch(value,"\\A[0-9a-f]{"+length+"}\\z"))throw new ArgumentException("Exact hexadecimal identity required");}
  static Dictionary<string,object> Obj(object value){var row=value as Dictionary<string,object>;if(row==null)throw new ArgumentException("Object required");return row;}
  static string Text(object value){var s=value as string;if(s==null)throw new ArgumentException("String required");return s;}
  static long Number(object value){if(!(value is int)&&!(value is long))throw new ArgumentException("Integer required");return Convert.ToInt64(value,CultureInfo.InvariantCulture);}
  static void Keys(Dictionary<string,object> row,params string[] keys){if(row.Count!=keys.Length)throw new ArgumentException("Exact fields required");foreach(string key in keys)if(!row.ContainsKey(key))throw new ArgumentException("Missing field");}
  static string FixedRoot(string kind,string nonce){Hex(nonce,32);return @"C:\EnclaveRpc"+kind+"-"+nonce+@"\"+nonce;}
  static void HoldVolume(){
   var handle=ProtectedAttempt.CreateFile(@"C:\",0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Held.Add(handle);ProtectedAttempt.Authority(handle,false,true,@"C:\");Check();
  }
  static void HoldNamespace(string root,bool privacy){
   ProtectedAttempt.LocalPath(root);string path=Path.GetPathRoot(root);string[] parts=root.Substring(3).Split('\\');
   for(int i=-1;i<parts.Length;i++){
    if(i>=0)path=Path.Combine(path,parts[i]);
    var handle=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Held.Add(handle);
    ProtectedAttempt.Authority(handle,i==parts.Length-1,true,path);
    if(privacy&&i==parts.Length-1)ProtectedAttempt.TransitionPrivacy(handle,true,path);Check();
   }
  }
  static FileStream Open(string path,long maximum,bool privacy){
   Check();var handle=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Held.Add(handle);
   ProtectedAttempt.Authority(handle,true,false,path);if(privacy)ProtectedAttempt.TransitionPrivacy(handle,false,path);
   var stream=new FileStream(handle,FileAccess.Read);Held.Add(stream);
   if(stream.Length<1||stream.Length>maximum)throw new InvalidOperationException("Protected input size bound");return stream;
  }
  static byte[] Read(string path,int maximum){var file=Open(path,maximum,false);byte[] raw=new byte[(int)file.Length];int offset=0;
   while(offset<raw.Length){Check();int n=file.Read(raw,offset,raw.Length-offset);if(n==0)throw new IOException("Short input");offset+=n;}
   if(file.ReadByte()!=-1)throw new IOException("Input grew");return raw;
  }
  static void Absent(string path){
   var handle=ProtectedAttempt.CreateFile(path,0x80,3,IntPtr.Zero,3,0x00200000,IntPtr.Zero);int error=Marshal.GetLastWin32Error();
   if(!handle.IsInvalid){handle.Dispose();throw new InvalidOperationException("File operation already consumed or boot already begun");}
   handle.Dispose();if(error!=2)throw new Win32Exception(error);Check();
  }
  static FileSecurity FileAcl(){var acl=new FileSecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));return acl;}
  static FileStream NewFile(string path){Check();var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,65536,FileOptions.WriteThrough,FileAcl());
   try{ProtectedAttempt.TransitionPrivacy(f.SafeFileHandle,false,path);return f;}catch{f.Dispose();throw;}}
  static void Write(string path,byte[] data){using(var f=NewFile(path)){f.Write(data,0,data.Length);f.Flush(true);}Check();}
  static void DirectoryNew(string path){
   var acl=new DirectorySecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   byte[] raw=acl.GetSecurityDescriptorBinaryForm();IntPtr memory=Marshal.AllocHGlobal(raw.Length);
   try{Marshal.Copy(raw,0,memory,raw.Length);var a=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=memory,Inherit=0};
    if(!CreateDirectoryW(path,ref a))throw new Win32Exception(Marshal.GetLastWin32Error());
   }finally{Marshal.FreeHGlobal(memory);}HoldNamespace(path,true);
  }
  static Dictionary<string,object> Record(string name,byte[] raw,bool contents){
   var row=new Dictionary<string,object>{{"name",name},{"bytes",raw.Length},{"sha256",ProtectedAttempt.Hash(raw)}};
   if(contents)row.Add("base64",Convert.ToBase64String(raw));return row;
  }
  static object Collect(Dictionary<string,object> p){
   Keys(p,"root","contractHash","activation");string root=Text(p["root"]);string nonce=Path.GetFileName(root);
   if(root!=FixedRoot("LegacyHandoff",nonce))throw new ArgumentException("Exact completed cut namespace required");
   Hex(Text(p["contractHash"]),64);HoldNamespace(root,false);
   byte[] contract=Read(Path.Combine(root,"contract.txt"),1024),activation=Read(Path.Combine(root,"pool.activation"),4096),complete=Read(Path.Combine(root,"pool.complete"),64);
   string[] f=Utf8.GetString(contract).Split('\n');
   if(f.Length!=9||f[0]!="owned-rpc-legacy-handoff-v1"||f[1]!=nonce||f[2]!=Boot||f[6]!="legacy-memory-cut-seed-v1"||f[8]!=""||ProtectedAttempt.Hash(contract)!=Text(p["contractHash"]))throw new InvalidOperationException("Original cut contract differs");
   long origin=Int64.Parse(f[3],CultureInfo.InvariantCulture),deadline=Int64.Parse(f[4],CultureInfo.InvariantCulture);Hex(f[5],64);Hex(f[7],64);
   if(origin<OriginalOrigin||deadline<=origin||deadline-origin>30000||deadline>OriginalDeadline)throw new InvalidOperationException("Cut window differs");
   string hash=ProtectedAttempt.Hash(activation);var seed=Obj(Json.DeserializeObject(Utf8.GetString(activation)));
   var expected=Obj(p["activation"]);if(seed.Count!=19||expected.Count!=seed.Count)throw new InvalidOperationException("Exact returned activation shape required");
   foreach(var field in seed){object value;if(!expected.TryGetValue(field.Key,out value)||!Object.Equals(value,field.Value))throw new InvalidOperationException("Returned activation differs");}
   if(Utf8.GetString(complete)!=hash||Text(seed["boot"])!=Boot||Text(seed["manifest"])!=f[7]||Text(seed["schema"])!="legacy-pool-seed/2")throw new InvalidOperationException("Completed pool binding differs");
   return new{root=root,files=new[]{Record("contract.txt",contract,true),Record("pool.activation",activation,true),Record("pool.complete",complete,true)}};
  }
  static object Stage(Dictionary<string,object> p,string requestHash){
   Keys(p,"files");var rows=p["files"] as IList;if(rows==null||rows.Count<1||rows.Count>2)throw new ArgumentException("One observation and optional definition required");
   var files=new Dictionary<string,byte[]>();foreach(object item in rows){var row=Obj(item);Keys(row,"name","sha256","base64");string name=Text(row["name"]);Hex(Text(row["sha256"]),64);
    if((name!="observation.json"&&name!="definition-plan.txt")||files.ContainsKey(name))throw new ArgumentException("Fixed staged input names required");
    byte[] raw=Convert.FromBase64String(Text(row["base64"]));if(raw.Length<1||raw.Length>(name=="observation.json"?32768:4096)||ProtectedAttempt.Hash(raw)!=Text(row["sha256"]))throw new InvalidOperationException("Staged bytes differ");
    if(name=="definition-plan.txt")Plan(raw);files.Add(name,raw);
   }
   if(!files.ContainsKey("observation.json"))throw new ArgumentException("Observation required");
   var observation=Obj(Json.DeserializeObject(Utf8.GetString(files["observation.json"])));var obs=Obj(observation["observation"]);
   if(Number(observation["rc"])!=0||observation["failure"]!=null||!Object.Equals(observation["readOnly"],true)||Text(obs["bootNative"])!=Boot)throw new InvalidOperationException("Observation binding differs");
   if(files.ContainsKey("definition-plan.txt")&&Plan(files["definition-plan.txt"])[3]!=ProtectedAttempt.Hash(files["observation.json"]))throw new InvalidOperationException("Definition admission digest differs");
   string parent=@"C:\EnclaveRpcInputs-"+Nonce,root=FixedRoot("Inputs",Nonce);HoldVolume();
   DirectoryNew(parent);DirectoryNew(root);Write(Path.Combine(root,"input.intent"),Utf8.GetBytes(requestHash));var result=new List<object>();
   foreach(var file in files){Write(Path.Combine(root,file.Key),file.Value);byte[] actual=Read(Path.Combine(root,file.Key),32768);if(ProtectedAttempt.Hash(actual)!=ProtectedAttempt.Hash(file.Value))throw new IOException("Staged readback differs");result.Add(Record(file.Key,actual,false));}
   return new{root=root,files=result};
  }
  static string[] Plan(byte[] raw){
   string[] f=Utf8.GetString(raw).Split('\n');if(f.Length!=12||f[0]!="owned-rpc-definition/1"||f[1]!=Attempt||f[2]!=Boot||f[5]!=FixedRoot("Vm",Attempt)||f[6]!=OriginalOrigin.ToString(CultureInfo.InvariantCulture)||f[7]!=OriginalDeadline.ToString(CultureInfo.InvariantCulture)||f[10]!="generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false"||f[11]!="")throw new InvalidOperationException("Original definition binding differs");
   foreach(int n in new[]{3,4,8,9})Hex(f[n],64);return f;
  }
  static void Disk(long outstanding){Check();ulong available,total,free;if(!GetDiskFreeSpaceExW(@"C:\",out available,out total,out free))throw new Win32Exception(Marshal.GetLastWin32Error());
   if(available<(ulong)(16*GiB+256*MiB+outstanding))throw new InvalidOperationException("Original disk floor/growth reservation refused");}
  static string StreamHash(FileStream stream){using(var sha=SHA256.Create()){byte[] buffer=new byte[65536];int n;while((n=stream.Read(buffer,0,buffer.Length))!=0){Check();sha.TransformBlock(buffer,0,n,buffer,0);}sha.TransformFinalBlock(new byte[0],0,0);return BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();}}
  static object CopyMedia(Dictionary<string,object> p,string requestHash){
   Keys(p,"sourceRoot","planHash");string source=Text(p["sourceRoot"]);if(source!=FixedRoot("PrivateMedia",Path.GetFileName(source)))throw new ArgumentException("Fixed private media source required");Hex(Text(p["planHash"]),64);
   string root=FixedRoot("Vm",Attempt);HoldNamespace(root,true);HoldNamespace(source,true);
   byte[] plan=Read(Path.Combine(root,"definition-plan.txt"),4096);string[] f=Plan(plan);if(ProtectedAttempt.Hash(plan)!=Text(p["planHash"]))throw new InvalidOperationException("Original plan hash differs");
   byte[] system=Read(Path.Combine(root,"definition.system"),4096),receipt=Read(Path.Combine(root,"definition.receipt"),4096);
   var defined=Obj(Json.DeserializeObject(Utf8.GetString(system)));Keys(defined,"receipt","system");
   var match=Regex.Match(Text(defined["system"]),"\\AMsvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\"([0-9a-f-]{36})\"\\z");Guid definedGuid;
   if(Text(defined["receipt"])!=ProtectedAttempt.Hash(receipt)||!match.Success||!Guid.TryParseExact(match.Groups[1].Value,"D",out definedGuid)||definedGuid==Guid.Empty||definedGuid.ToString("D")!=match.Groups[1].Value||Utf8.GetString(Read(Path.Combine(root,"definition.off"),4096))!=ProtectedAttempt.Hash(system)+";"+Text(p["planHash"])+";owned-off-zero;start-authorized=false")throw new InvalidOperationException("Durable owned definition journal differs");
   // Only before attachment: these new files are not existing VM data. Native
   // boot later rechecks exact original-owned Off/zero before any attachment.
   foreach(string name in new[]{"boot.scsi.intent","boot.scsi.intent.pending","boot.media","boot.ready","startup-controller.consumed","boot.vhdx","seed.iso"})Absent(Path.Combine(root,name));
   var boot=Open(Path.Combine(source,"boot.vhdx"),4*GiB,true);var seed=Open(Path.Combine(source,"seed.iso"),64*MiB,true);
   long total=boot.Length+seed.Length,growth=4*GiB-boot.Length,copied=0;Disk(total+growth);
   Write(Path.Combine(root,"media-copy.intent"),Utf8.GetBytes(requestHash));var results=new List<object>();
   foreach(string name in new[]{"boot.vhdx","seed.iso"}){var input=name=="boot.vhdx"?boot:seed;string expected=name=="boot.vhdx"?f[8]:f[9];long length=input.Length;
    using(var output=NewFile(Path.Combine(root,name)))using(var sha=SHA256.Create()){
     byte[] block=new byte[65536];long written=0,nextDisk=0;int n;
     while((n=input.Read(block,0,block.Length))!=0){Check();if(written+n>length)throw new IOException("Source grew");
      if(written>=nextDisk){Disk(total-copied+growth);nextDisk=written+8*MiB;}output.Write(block,0,n);sha.TransformBlock(block,0,n,block,0);written+=n;copied+=n;
     }
     sha.TransformFinalBlock(new byte[0],0,0);if(written!=length||BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant()!=expected)throw new IOException("Original private media digest differs");
     output.Flush(true);output.Position=0;if(output.Length!=length||StreamHash(output)!=expected)throw new IOException("Private destination readback differs");ProtectedAttempt.TransitionPrivacy(output.SafeFileHandle,false,name);
    }
    results.Add(new{name=name,bytes=length,sha256=expected});
   }
   Disk(growth);Write(Path.Combine(root,"media-copy.complete"),Utf8.GetBytes(requestHash));
   return new{root=root,sourceRoot=source,planHash=Text(p["planHash"]),files=results,definitionJournalBound=true,currentVmOffObserved=false,mediaAttached=false,privateContentsPrinted=false};
  }
  public static int Main(string[] args){
   try{
    if(args.Length!=7||args[0]!="--target")return 64;
    Operation=args[1];Nonce=args[2];Boot=args[3];Origin=Int64.Parse(args[4],NumberStyles.None,CultureInfo.InvariantCulture);Deadline=Int64.Parse(args[5],NumberStyles.None,CultureInfo.InvariantCulture);Hex(args[6],64);Hex(Nonce,32);Hex(Boot,32);
    long now=BoundedWorker.MonotonicMilliseconds();if(Origin<0||Origin>Int64.MaxValue-30000||now<Origin||now-Origin>=5000||Deadline<=now||Deadline>Origin+30000)throw new ArgumentException("Fresh bounded original worker lease required");Arm();
    var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireAdministrator();if(ProtectedAttempt.CurrentBoot()!=Boot)throw new InvalidOperationException("Native boot changed");
    using(var self=Process.GetCurrentProcess()){HoldNamespace(Path.GetDirectoryName(self.MainModule.FileName),false);if(ProtectedAttempt.Hash(Read(self.MainModule.FileName,262144))!=args[6])throw new InvalidOperationException("Helper image differs");}
    var memory=new Memory();memory.Length=(uint)Marshal.SizeOf(typeof(Memory));ulong floor=62709039104UL;
#if TRANSITION_FILES_CI
    if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("Hosted fixture only");floor=3UL*1073741824;
#endif
    if(!GlobalMemoryStatusEx(ref memory)||memory.Available<floor)throw new InvalidOperationException("Retained physical/pending floor refused");
    // Independently armed native watchdog interrupts blocked stdin/file calls.
    char[] buffer=new char[65537];int count=Console.In.ReadBlock(buffer,0,buffer.Length);if(count<1||count>65536)throw new ArgumentException("Bounded request required");string raw=new string(buffer,0,count);var request=Obj(Json.DeserializeObject(raw));
    Keys(request,"schema","operation","nonce","windowsBoot","vmAttempt","origin","deadline","payload");
    if(Text(request["schema"])!="owned-rpc-transition-files/1"||Text(request["operation"])!=Operation||Text(request["nonce"])!=Nonce||Text(request["windowsBoot"])!=Boot)throw new InvalidOperationException("Request binding differs");
    Attempt=Text(request["vmAttempt"]);Hex(Attempt,32);OriginalOrigin=Number(request["origin"]);OriginalDeadline=Number(request["deadline"]);
    if(OriginalOrigin<0||OriginalOrigin>Int64.MaxValue-900000||OriginalDeadline!=OriginalOrigin+900000||Origin<OriginalOrigin||Deadline>OriginalDeadline)throw new InvalidOperationException("Original startup window differs");
    string hash=ProtectedAttempt.Hash(Utf8.GetBytes(raw));var payload=Obj(request["payload"]);object result;
    if(Operation=="collect-cut")result=Collect(payload);else if(Operation=="stage-inputs")result=Stage(payload,hash);else if(Operation=="copy-media")result=CopyMedia(payload,hash);else throw new ArgumentException("Fixed file operation required");
    Check();using(var self=Process.GetCurrentProcess()){
     string output=Json.Serialize(new{schema="owned-rpc-transition-files-result/1",operation=Operation,nonce=Nonce,requestHash=hash,windowsBoot=Boot,vmAttempt=Attempt,origin=Origin,deadline=Deadline,result=result,pid=self.Id,creation=self.StartTime.ToUniversalTime().ToFileTimeUtc(),envelope=envelope,vmChanged=false,rpcReady=false,reservationMayRelease=false});
     if(output.Length>8192)throw new InvalidOperationException("Bounded response required");Console.WriteLine(output);
    }return 0;
   }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
   finally{for(int i=Held.Count-1;i>=0;i--)Held[i].Dispose();}
  }
 }
 public sealed partial class ProtectedAttempt {
  // Media custody forbids foreign read grants as well as mutation. Check the
  // actual held object; never repair an existing ACL after secret bytes arrive.
  internal static void TransitionPrivacy(SafeFileHandle handle,bool directory,string label){
   Authority(handle,true,directory,label);FileInfo info;if(!GetFileInformationByHandle(handle,out info)||(!directory&&info.Links!=1))throw new InvalidOperationException("Private file link identity differs");
   IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,1,1|4,out owner,out group,out dacl,out sacl,out descriptor);if(error!=0)throw new Win32Exception((int)error);
   try{uint size=GetSecurityDescriptorLength(descriptor);if(size==0||size>65536)throw new InvalidOperationException("Private security descriptor bound");byte[] raw=new byte[size];Marshal.Copy(descriptor,raw,0,(int)size);var sd=new RawSecurityDescriptor(raw,0);
    foreach(GenericAce ace in sd.DiscretionaryAcl){var common=ace as CommonAce;if(common==null||common.IsCallback)throw new InvalidOperationException("Private ACE type");if(common.AceQualifier==AceQualifier.AccessDenied)continue;
     if(common.AceQualifier!=AceQualifier.AccessAllowed||(common.SecurityIdentifier.Value!=SystemSid&&common.SecurityIdentifier.Value!=AdminSid))throw new InvalidOperationException("Foreign private access refused");}
   }finally{if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }
 }
}
