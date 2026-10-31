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
using Microsoft.Win32.SafeHandles;
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
  NamespaceCustodyQualification.Run(Test);
  Console.WriteLine("RESULT tests="+count+" providerCalls=false vmChanged=false targetInventoryQualified=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}}
}

// Disposable native filesystem qualification. No production path is accepted.
// A restricted token supplies the observed Users metadata/create rights; empty
// positive controls establish that attempted operations are valid and permitted.
static class NamespaceCustodyQualification {
 [StructLayout(LayoutKind.Sequential)] struct SidAttributes{public IntPtr Sid;public uint Attributes;}
 [StructLayout(LayoutKind.Sequential)] struct IoStatus{public IntPtr Status,Information;}
 [StructLayout(LayoutKind.Sequential)] struct Luid{public uint Low;public int High;}
 [StructLayout(LayoutKind.Sequential)] struct Privileges{public uint Count;public Luid Luid;public uint Attributes;}
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint rights,out IntPtr t);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t,uint flags,uint disableCount,ref SidAttributes disable,uint deleteCount,IntPtr delete,uint restrictCount,ref SidAttributes restrict,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsTokenRestricted(IntPtr t);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr t);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool RevertToSelf();
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref Privileges state,uint length,IntPtr previous,IntPtr required);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle handle,uint code,byte[] input,int size,IntPtr output,int outputSize,out uint returned,IntPtr overlap);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileAttributes(string path,uint attributes);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileEx(string from,string to,uint flags);
 [DllImport("ntdll.dll")] static extern int NtSetEaFile(SafeFileHandle file,out IoStatus status,byte[] ea,uint length);
 static void Check(bool ok){if(!ok)throw new Exception("Native ancestor custody qualification failed");}
 static void DirectoryNew(string path,bool metadata){
  var a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier("S-1-5-32-544"));a.SetAccessRuleProtection(true,false);
  foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
  a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-545"),(FileSystemRights)(metadata?0x1201bf:0x1200a9),InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,a);
 }
 static SafeFileHandle Open(string path,uint rights){var h=ProtectedAttempt.CreateFile(path,rights,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new System.ComponentModel.Win32Exception(e);}return h;}
 static IntPtr Sid(string name){var s=new SecurityIdentifier(name);byte[] b=new byte[s.BinaryLength];s.GetBinaryForm(b,0);IntPtr p=Marshal.AllocHGlobal(b.Length);Marshal.Copy(b,0,p,b.Length);return p;}
 static void AsRestricted(IntPtr token,Action a){Check(ImpersonateLoggedOnUser(token));try{using(var id=WindowsIdentity.GetCurrent())Check(!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator));a();}finally{Check(RevertToSelf());}}
 static byte[] Reparse(string target,bool symlink){
  string substitute=@"\??\"+target,print=target;byte[] s=Encoding.Unicode.GetBytes(substitute+"\0"),p=Encoding.Unicode.GetBytes(print+"\0");int fixedPart=symlink?12:8;byte[] b=new byte[8+fixedPart+s.Length+p.Length];
  Buffer.BlockCopy(BitConverter.GetBytes(symlink?0xa000000cu:0xa0000003u),0,b,0,4);Buffer.BlockCopy(BitConverter.GetBytes((ushort)(b.Length-8)),0,b,4,2);
  Buffer.BlockCopy(BitConverter.GetBytes((ushort)(s.Length-2)),0,b,10,2);Buffer.BlockCopy(BitConverter.GetBytes((ushort)s.Length),0,b,12,2);Buffer.BlockCopy(BitConverter.GetBytes((ushort)(p.Length-2)),0,b,14,2);
  Buffer.BlockCopy(s,0,b,8+fixedPart,s.Length);Buffer.BlockCopy(p,0,b,8+fixedPart+s.Length,p.Length);return b;
 }
 static int SetReparse(string path,byte[] bytes){using(var h=Open(path,0x116)){uint n;return DeviceIoControl(h,0x900a4,bytes,bytes.Length,IntPtr.Zero,0,out n,IntPtr.Zero)?0:Marshal.GetLastWin32Error();}}
 static bool DeleteAccess(string path){using(var h=ProtectedAttempt.CreateFile(path,0x10000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero))return !h.IsInvalid;}
 public static void Run(Action<string,Action> test){
  string root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-ancestor-ci-"+Guid.NewGuid().ToString("N"));DirectoryNew(root,false);
  string parent=Path.Combine(root,"metadata"),child=Path.Combine(parent,"protected"),target=Path.Combine(root,"target"),empty=Path.Combine(root,"empty-junction"),emptyLink=Path.Combine(root,"empty-symlink");
  DirectoryNew(parent,true);DirectoryNew(child,false);DirectoryNew(target,false);DirectoryNew(empty,true);DirectoryNew(emptyLink,true);
  IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,admin=Sid("S-1-5-32-544"),users=Sid("S-1-5-32-545");
  try{
   Check(OpenProcessToken(GetCurrentProcess(),0x2e,out original));var disabled=new SidAttributes{Sid=admin};var onlyUsers=new SidAttributes{Sid=users};Check(CreateRestrictedToken(original,1,1,ref disabled,0,IntPtr.Zero,1,ref onlyUsers,out restricted)&&IsTokenRestricted(restricted));
   using(var anchor=Open(parent,0x200a0)){
    test("ordinary-authority-still-refuses-metadata-ancestor",()=>{bool refused=false;try{ProtectedAttempt.Authority(anchor,false,true,parent);}catch(InvalidOperationException){refused=true;}Check(refused);});
    test("relative-child-traversal-refused",()=>{bool refused=false;try{using(var h=AncestorCustody.OpenChild(anchor,"..\\target")){};}catch(ArgumentException){refused=true;}Check(refused);});
    test("mutable-child-cannot-authorize-ancestor",()=>{DirectoryNew(Path.Combine(parent,"mutable"),true);bool refused=false;try{using(var c=new AncestorCustody(anchor,parent,"mutable")){};}catch(InvalidOperationException){refused=true;}Check(refused);});
    using(var custody=new AncestorCustody(anchor,parent,"protected")){
     test("native-relative-protected-child-custody",()=>{custody.Recheck();ProtectedAttempt.CustodiedAncestorAuthority(custody);});
     test("restricted-token-metadata-rights-positive-control",()=>AsRestricted(restricted,()=>{
      Check(SetFileAttributes(parent,2));Check(SetFileAttributes(parent,128));using(var h=Open(parent,0x110)){
       byte[] ea={0,0,0,0,0,5,1,0,112,114,111,111,102,0,1};IoStatus status;Check(NtSetEaFile(h,out status,ea,(uint)ea.Length)>=0);
       ea[6]=0;Check(NtSetEaFile(h,out status,ea,(uint)ea.Length-1)>=0);
      }
     }));
     test("restricted-junction-empty-positive-control",()=>AsRestricted(restricted,()=>Check(SetReparse(empty,Reparse(target,false))==0)));
     test("restricted-junction-protected-child-refuses",()=>AsRestricted(restricted,()=>{Check(SetReparse(parent,Reparse(target,false))==145);custody.Recheck();}));
     test("restricted-delete-rename-refused-under-custody",()=>AsRestricted(restricted,()=>{Check(!DeleteAccess(parent)&&!DeleteAccess(child));Check(!MoveFileEx(child,Path.Combine(root,"moved-child"),0));Check(!MoveFileEx(parent,Path.Combine(root,"moved-parent"),0));}));
     // The privileged positive control avoids confusing lack of symlink
     // privilege with the filesystem's protected-nonempty rejection.
     Luid luid;Check(LookupPrivilegeValue(null,"SeCreateSymbolicLinkPrivilege",out luid));var privilege=new Privileges{Count=1,Luid=luid,Attributes=2};Check(AdjustTokenPrivileges(original,false,ref privilege,0,IntPtr.Zero,IntPtr.Zero)&&Marshal.GetLastWin32Error()==0);
     try{
      test("symlink-empty-positive-control",()=>Check(SetReparse(emptyLink,Reparse(target,true))==0));
      test("symlink-protected-child-refuses",()=>{Check(SetReparse(parent,Reparse(target,true))==145);custody.Recheck();});
     }finally{privilege.Attributes=0;Check(AdjustTokenPrivileges(original,false,ref privilege,0,IntPtr.Zero,IntPtr.Zero));}
     test("relative-child-reparse-refused",()=>{using(var top=Open(root,0x200a0)){bool refused=false;try{using(var h=AncestorCustody.OpenChild(top,"empty-junction")){};}catch(InvalidOperationException){refused=true;}Check(refused);}});
    }
   }
   test("protected-child-denies-removal-after-custody-closes",()=>AsRestricted(restricted,()=>Check(!DeleteAccess(child)&&!DeleteAccess(parent))));
   test("template-fence-through-custodied-metadata-ancestor",()=>{
    string master=Path.Combine(child,"fixture.vmgs"),intent=Path.Combine(root,"intent");DirectoryNew(intent,false);
    byte[] bytes=Encoding.UTF8.GetBytes("disposable custody template");var acl=new FileSecurity();acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));acl.SetAccessRuleProtection(true,false);
    foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,AccessControlType.Allow));
    using(var file=new FileStream(master,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,acl)){file.Write(bytes,0,bytes.Length);file.Flush(true);}
    var receipt=LegacyTemplateFence.Apply(master,ProtectedAttempt.Hash(bytes),bytes.Length,ProtectedAttempt.CurrentBoot(),Path.Combine(intent,"definition-fence.intent"),BoundedWorker.MonotonicMilliseconds()+3000);
    Check(receipt.PersistentReadDenial&&!receipt.ExistingOperationsSettled&&!receipt.ReservationMayRelease);
    bool denied=false;try{File.ReadAllBytes(master);}catch(UnauthorizedAccessException){denied=true;}Check(denied);
   });
  }finally{if(restricted!=IntPtr.Zero)CloseHandle(restricted);if(original!=IntPtr.Zero)CloseHandle(original);Marshal.FreeHGlobal(admin);Marshal.FreeHGlobal(users);}
 }
}
